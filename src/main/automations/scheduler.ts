import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  robotId,
  type AgentState,
  type AutomationInfo,
  type AutomationRun,
  type AutomationTrigger
} from '@shared/types'
import { baseInfo, type AutomationSpec } from './spec'

/** What the app remembers about each automation (private, outside the user's folder). */
export interface AutomationState {
  enabled: boolean
  /** Hash of automation.md when the user approved it. */
  approvedHash?: string
  nextRunAt?: number
  lastRun?: { ts: number; ok: boolean; ms: number }
}

/** Runs one automation; the manager decides when. */
export type Executor = (
  spec: AutomationSpec,
  trigger: AutomationTrigger,
  detail: string | undefined,
  signal: AbortSignal,
  progress: (text: string) => void
) => Promise<AutomationRun>

/** Watches a folder and calls back on changes; returns a function that stops watching. */
export type Watcher = (spec: AutomationSpec, onChange: (file: string) => void) => (() => void) | undefined

export interface ManagerEvents {
  changed(list: AutomationInfo[]): void
  run(run: AutomationRun): void
  think(id: string, state: AgentState, text: string): void
}

export interface ManagerOptions {
  stateFile: string
  runsDir: string
  execute: Executor
  watch?: Watcher
  events: ManagerEvents
  now?: () => number
  /** Runs at the same time; the rest wait. */
  maxParallel?: number
  /** How long a job to an agent waits for its automations. */
  beforeAgentTimeoutMs?: number
}

export const KEEP_RUNS = 50
/** First interval run after start-up when one was missed while the app was closed. */
const CATCH_UP_DELAY_MS = 10_000
/** setTimeout cannot wait longer than ~24.8 days. */
const MAX_TIMER_MS = 2_000_000_000
const WATCH_DEBOUNCE_MS = 2000
/** Changes right after a run are most likely the run's own. */
const WATCH_QUIET_MS = 3000
const IDLE_DELAY_MS = 4000

interface Job {
  spec: AutomationSpec
  trigger: AutomationTrigger
  detail?: string
  waiters: Array<() => void>
}

export class AutomationManager {
  private specs = new Map<string, AutomationSpec>()
  private state: Record<string, AutomationState> = {}
  private timers = new Map<string, NodeJS.Timeout>()
  private watchers = new Map<string, { key: string; stop: () => void }>()
  private watchTimers = new Map<string, NodeJS.Timeout>()
  private quietUntil = new Map<string, number>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  private running = new Map<string, AbortController>()
  private queue: Job[] = []
  private inFlight = new Set<Promise<void>>()
  private started = false
  private now: () => number

  constructor(private opts: ManagerOptions) {
    this.now = opts.now ?? Date.now
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.opts.stateFile, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.state = parsed as Record<string, AutomationState>
      }
    } catch {
      this.state = {}
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.opts.stateFile}.tmp`
    await writeFile(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8')
    await rename(tmp, this.opts.stateFile)
  }

  private stateOf(id: string): AutomationState {
    return (this.state[id] ??= { enabled: false })
  }

  /** Enabled and approved as the file is written right now. */
  ready(spec: AutomationSpec): boolean {
    const s = this.state[spec.id]
    return Boolean(s?.enabled && s.approvedHash === spec.hash)
  }

  list(): AutomationInfo[] {
    return [...this.specs.values()].map((spec) => {
      const s = this.state[spec.id]
      const info: AutomationInfo = {
        ...baseInfo(spec),
        enabled: Boolean(s?.enabled),
        needsApproval: s?.approvedHash !== spec.hash,
        running: this.running.has(spec.id)
      }
      if (s?.lastRun) info.lastRun = s.lastRun
      if (this.ready(spec) && spec.everyMs && s?.nextRunAt) info.nextRunAt = s.nextRunAt
      return info
    })
  }

  private changed(): void {
    this.opts.events.changed(this.list())
  }

  /** New set of automation files (start-up and every reload). */
  setSpecs(specs: AutomationSpec[]): void {
    const previous = this.specs
    this.specs = new Map(specs.map((s) => [s.id, s]))
    for (const id of previous.keys()) {
      if (!this.specs.has(id)) this.unschedule(id)
    }
    for (const spec of specs) this.schedule(spec)
    if (!this.started) {
      this.started = true
      for (const spec of specs) if (spec.onStartup && this.ready(spec)) this.trigger(spec.id, 'arranque')
    }
    this.changed()
  }

  private unschedule(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    this.watchers.get(id)?.stop()
    this.watchers.delete(id)
    clearTimeout(this.watchTimers.get(id))
    this.watchTimers.delete(id)
  }

  private schedule(spec: AutomationSpec): void {
    const id = spec.id
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    if (!this.ready(spec)) {
      this.watchers.get(id)?.stop()
      this.watchers.delete(id)
      return
    }

    if (spec.everyMs) {
      const s = this.stateOf(id)
      const now = this.now()
      // Keep a saved time unless the interval got shorter than what is left.
      if (!s.nextRunAt || s.nextRunAt > now + spec.everyMs) s.nextRunAt = now + spec.everyMs
      const delay = s.nextRunAt <= now ? CATCH_UP_DELAY_MS : s.nextRunAt - now
      this.timers.set(
        id,
        setTimeout(() => this.onTimer(id), Math.min(delay, MAX_TIMER_MS))
      )
      void this.save().catch(() => undefined)
    }

    const key = spec.watch ? `${spec.watch.repo ?? ''}|${spec.watch.folder ?? ''}` : ''
    const current = this.watchers.get(id)
    if (current && current.key !== key) {
      current.stop()
      this.watchers.delete(id)
    }
    if (spec.watch && this.opts.watch && !this.watchers.has(id)) {
      const stop = this.opts.watch(spec, (file) => this.onFileChange(id, file))
      if (stop) this.watchers.set(id, { key, stop })
    }
  }

  private onTimer(id: string): void {
    this.timers.delete(id)
    const spec = this.specs.get(id)
    if (!spec || !this.ready(spec) || !spec.everyMs) return
    const s = this.stateOf(id)
    if (s.nextRunAt && s.nextRunAt > this.now() + 1000) {
      // Woke early (long waits are split): wait the rest.
      this.schedule(spec)
      return
    }
    s.nextRunAt = this.now() + spec.everyMs
    this.schedule(spec)
    this.trigger(id, 'intervalo')
    this.changed()
  }

  private onFileChange(id: string, file: string): void {
    if (this.running.has(id) || (this.quietUntil.get(id) ?? 0) > this.now()) return
    clearTimeout(this.watchTimers.get(id))
    this.watchTimers.set(
      id,
      setTimeout(() => {
        this.watchTimers.delete(id)
        this.trigger(id, 'archivos', file)
      }, WATCH_DEBOUNCE_MS)
    )
  }

  /** Queues a run; resolves when it has finished (or was skipped). */
  trigger(id: string, trigger: AutomationTrigger, detail?: string): Promise<void> {
    const spec = this.specs.get(id)
    if (!spec) return Promise.resolve()
    if (trigger !== 'manual' && !this.ready(spec)) return Promise.resolve()
    if (this.running.has(id) || this.queue.some((j) => j.spec.id === id)) {
      // Already running or waiting: wait for that run instead of starting another.
      if (trigger === 'agente') return this.waitFor(id)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const job: Job = { spec, trigger, waiters: [resolve] }
      if (detail) job.detail = detail
      this.queue.push(job)
      this.pump()
    })
  }

  private waitFor(id: string): Promise<void> {
    const queued = this.queue.find((j) => j.spec.id === id)
    if (queued) return new Promise((resolve) => queued.waiters.push(resolve))
    const controller = this.running.get(id)
    if (!controller) return Promise.resolve()
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (!this.running.has(id)) {
          clearInterval(check)
          resolve()
        }
      }, 250)
    })
  }

  private pump(): void {
    const max = this.opts.maxParallel ?? 2
    while (this.running.size < max && this.queue.length) {
      const job = this.queue.shift()!
      const started = this.start(job)
      this.inFlight.add(started)
      void started.finally(() => this.inFlight.delete(started))
    }
  }

  private async start(job: Job): Promise<void> {
    const { spec } = job
    const id = spec.id
    const robot = robotId(id)
    const controller = new AbortController()
    this.running.set(id, controller)
    this.think(robot, 'working', 'Arrancando…')
    this.changed()
    let run: AutomationRun
    try {
      run = await this.opts.execute(spec, job.trigger, job.detail, controller.signal, (text) =>
        this.think(robot, 'working', text)
      )
    } catch (err) {
      run = {
        automationId: id,
        trigger: job.trigger,
        startedAt: this.now(),
        endedAt: this.now(),
        ok: false,
        note: `Error: ${(err as Error).message}`,
        steps: []
      }
    }
    this.running.delete(id)
    this.quietUntil.set(id, this.now() + WATCH_QUIET_MS)
    this.think(robot, run.ok ? 'done' : 'error', run.ok ? '¡Hecho!' : run.note ?? 'Algo falló')
    this.idleTimers.set(
      robot,
      setTimeout(() => this.think(robot, 'idle', ''), IDLE_DELAY_MS)
    )
    const s = this.stateOf(id)
    s.lastRun = { ts: run.endedAt, ok: run.ok, ms: run.endedAt - run.startedAt }
    await this.save().catch(() => undefined)
    await this.appendRun(run).catch(() => undefined)
    this.opts.events.run(run)
    this.changed()
    for (const done of job.waiters) done()
    this.pump()
  }

  private think(id: string, state: AgentState, text: string): void {
    clearTimeout(this.idleTimers.get(id))
    this.idleTimers.delete(id)
    this.opts.events.think(id, state, text)
  }

  private runsFile(id: string): string {
    return join(this.opts.runsDir, `${id}.jsonl`)
  }

  private async appendRun(run: AutomationRun): Promise<void> {
    await mkdir(this.opts.runsDir, { recursive: true })
    const file = this.runsFile(run.automationId)
    await appendFile(file, JSON.stringify(run) + '\n', 'utf8')
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    if (lines.length > KEEP_RUNS * 2) await writeFile(file, lines.slice(-KEEP_RUNS).join('\n') + '\n', 'utf8')
  }

  /** Last runs, newest first. */
  async runs(id: string): Promise<AutomationRun[]> {
    if (!this.specs.has(id) && !this.state[id]) return []
    try {
      const lines = (await readFile(this.runsFile(id), 'utf8')).split('\n').filter(Boolean)
      return lines
        .slice(-KEEP_RUNS)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AutomationRun]
          } catch {
            return []
          }
        })
        .reverse()
    } catch {
      return []
    }
  }

  /** The user approves the file as written now; it switches on. */
  async approve(id: string): Promise<void> {
    const spec = this.specs.get(id)
    if (!spec) throw new Error(`Automatización desconocida: ${id}`)
    const s = this.stateOf(id)
    s.approvedHash = spec.hash
    s.enabled = true
    delete s.nextRunAt
    await this.save()
    this.schedule(spec)
    this.changed()
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const spec = this.specs.get(id)
    if (!spec) throw new Error(`Automatización desconocida: ${id}`)
    if (enabled && this.stateOf(id).approvedHash !== spec.hash) {
      throw new Error('Revisa y aprueba la automatización antes de activarla.')
    }
    const s = this.stateOf(id)
    s.enabled = enabled
    if (!enabled) delete s.nextRunAt
    await this.save()
    if (enabled) this.schedule(spec)
    else this.unschedule(id)
    this.changed()
  }

  /** "Ejecutar ahora": needs approval, not the switch. */
  runNow(id: string): void {
    const spec = this.specs.get(id)
    if (!spec) throw new Error(`Automatización desconocida: ${id}`)
    if (this.stateOf(id).approvedHash !== spec.hash) throw new Error('Revisa y aprueba la automatización antes de ejecutarla.')
    if (this.running.has(id)) throw new Error('Ya se está ejecutando.')
    void this.trigger(id, 'manual')
  }

  stop(id: string): void {
    this.running.get(id)?.abort()
    this.queue = this.queue.filter((j) => {
      if (j.spec.id !== id) return true
      j.waiters.forEach((done) => done())
      return false
    })
  }

  /** Runs (and waits for) the automations tied to an agent, before it gets a job. */
  async beforeDelegation(agentId: string): Promise<void> {
    const due = [...this.specs.values()].filter((s) => s.beforeAgents.includes(agentId) && this.ready(s))
    if (!due.length) return
    const limit = this.opts.beforeAgentTimeoutMs ?? 300_000
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all(due.map((s) => this.trigger(s.id, 'agente', agentId))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limit)
      })
    ])
    clearTimeout(timer)
  }

  /** Resolves once nothing runs or waits (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size || this.queue.length) await Promise.all([...this.inFlight])
  }

  dispose(): void {
    for (const id of [...this.specs.keys()]) this.unschedule(id)
    for (const c of this.running.values()) c.abort()
    for (const t of this.idleTimers.values()) clearTimeout(t)
  }
}
