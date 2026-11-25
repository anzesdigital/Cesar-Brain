import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type { AgentState, AutomationRun, AutomationStepResult, AutomationTrigger, TokenCount } from '@shared/types'
import type { AppConfig } from '../config'
import type { McpCatalog } from '../mcp'
import { decide, isInside } from '../brain/permissions'
import type { BrainProvider, RunResult, RunSink } from '../brain/providers/types'
import { DENIED_BY_RULE, matchRule } from '../brain/rules'
import type { AgentRecord } from '../brain/registry'
import { firstSentence, thoughtForTool, truncate } from '../brain/thoughts'
import { mcpServerOf } from '../mcp'
import type { AgentStep, AutomationSpec, CommandStep } from './spec'

/** Output kept per step (the end, where errors usually are). */
export const OUTPUT_LIMIT = 8000
/** Previous output handed to an agent step through `{salida}`. */
export const HANDOFF_LIMIT = 4000

export interface RunnerDeps {
  workspaceDir: string
  readableDirs: string[]
  getConfig(): AppConfig
  getAgents(): AgentRecord[]
  getMcp(): McpCatalog
  getProvider(): BrainProvider
  /** Bubble of an agent (or robot) in the office. */
  think(agentId: string, state: AgentState, text: string): void
  /** Robot bubble text for the current step. */
  progress(text: string): void
  recordUsage?(tokens: Record<string, TokenCount>, result: RunResult): Promise<void>
  /** Runs a shell command; replaceable in tests. */
  exec?: typeof runCommand
}

function tail(text: string, limit = OUTPUT_LIMIT): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

export interface CommandResult {
  ok: boolean
  output: string
}

/** Runs one command line in a shell (PowerShell on Windows), with a timeout. */
export function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
  return new Promise((done) => {
    const windows = process.platform === 'win32'
    const child = windows
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          cwd,
          windowsHide: true
        })
      : spawn('/bin/sh', ['-c', command], { cwd })
    let output = ''
    let finished = false
    let reason = ''
    const collect = (chunk: Buffer): void => {
      output = tail(output + chunk.toString('utf8'), OUTPUT_LIMIT * 2)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const kill = (why: string): void => {
      if (finished) return
      reason = why
      if (windows && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGTERM')
    }
    const timer = setTimeout(() => kill(`Tiempo agotado (${Math.round(timeoutMs / 1000)} s).`), timeoutMs)
    const onAbort = (): void => kill('Detenido.')
    signal.addEventListener('abort', onAbort, { once: true })
    const finish = (ok: boolean, extra = ''): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const text = [output.trim(), extra].filter(Boolean).join('\n')
      done({ ok, output: tail(text) })
    }
    child.on('error', (err) => finish(false, `No se pudo ejecutar: ${err.message}`))
    child.on('close', (code) => {
      if (reason) finish(false, reason)
      else finish(code === 0, code === 0 ? '' : `Terminó con código ${code}.`)
    })
  })
}

/** Folder a command step runs in: a configured repo or a folder of the workspace. */
export function commandCwd(step: CommandStep, workspaceDir: string, config: AppConfig): string {
  if (step.repo) {
    const repo = config.repos.find((r) => r.name === step.repo)
    if (!repo) throw new Error(`El repo "${step.repo}" ya no está en config.json.`)
    return repo.path
  }
  if (step.folder) {
    const dir = resolve(workspaceDir, step.folder)
    if (!isInside(dir, workspaceDir)) throw new Error(`La carpeta ${step.folder} está fuera del directorio de trabajo.`)
    return dir
  }
  return workspaceDir
}

/** Tool is in the automation's `permitir` list (an mcp__server entry covers all its tools). */
export function allowedByAutomation(tool: string, allow: readonly string[]): boolean {
  if (allow.includes(tool)) return true
  const server = mcpServerOf(tool)
  if (server !== undefined && allow.includes(`mcp__${server}`)) return true
  // Claude runs commands as PowerShell on Windows; it is the same permission as Bash.
  return tool === 'PowerShell' && allow.includes('Bash')
}

function fillOutput(task: string, previous: string): string {
  const handoff = previous.length > HANDOFF_LIMIT ? `…${previous.slice(-HANDOFF_LIMIT)}` : previous
  return task.includes('{salida}') ? task.replaceAll('{salida}', handoff || '(sin salida)') : task
}

/**
 * A sink for an agent running unattended: nobody is there to answer, so
 * anything the policy would ask about is allowed only when the approved
 * automation lists it in `permitir`.
 */
export function unattendedSink(spec: AutomationSpec, agent: AgentRecord, deps: RunnerDeps): RunSink {
  const agentId = agent.info.id
  return {
    sessionId: () => undefined,
    textDelta: () => undefined,
    agentText: (id, text) => {
      const sentence = firstSentence(text)
      if (sentence) deps.think(id, 'working', sentence)
    },
    toolStart: (id, tool, input) => deps.think(id, 'working', thoughtForTool(tool, input)),
    delegationStart: () => undefined,
    delegationEnd: () => undefined,
    limits: () => undefined,
    authorize: async (_id, tool, input) => {
      const config = deps.getConfig()
      const repos = agent.spec.repos
      const decision = decide(tool, input, {
        workspaceDir: deps.workspaceDir,
        readableDirs: deps.readableDirs,
        trustedServers: deps.getMcp().trusted,
        trustedTools: deps.getMcp().trustedTools,
        repos: config.repos,
        allowedRepos: repos ? new Set(repos) : undefined
      })
      // The user's deny rules apply here too; the mode and allow rules do not (nobody is watching).
      if (config.permissions.deny.some((rule) => matchRule(rule, agentId, tool, input, deps.workspaceDir))) {
        return DENIED_BY_RULE
      }
      if (decision === 'allow') return true
      if (typeof decision === 'object') return decision.deny
      if (allowedByAutomation(tool, spec.allow)) {
        deps.think(agentId, 'working', truncate(`Permitido por la automatización: ${tool}`))
        return true
      }
      const reason = `Esta automatización corre sin supervisión y no tiene permiso para ${tool}. Si hace falta, añádelo en "permitir" de su automation.md.`
      deps.think(agentId, 'working', truncate(`Sin permiso para ${tool}`))
      return reason
    }
  }
}

async function runAgentStep(
  spec: AutomationSpec,
  step: AgentStep,
  previous: string,
  deps: RunnerDeps,
  signal: AbortSignal
): Promise<{ ok: boolean; output: string }> {
  const found = deps.getAgents().find((a) => a.info.id === step.agent)
  if (!found) return { ok: false, output: `No existe el agente "${step.agent}".` }
  const agent: AgentRecord = step.model ? { ...found, spec: { ...found.spec, model: step.model } } : found
  const provider = deps.getProvider()
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), step.timeoutMs)
  const prompt = `${fillOutput(step.task, previous)}\n\n(Encargo de la automatización «${spec.name}». Nadie revisa tu respuesta en directo: no hagas preguntas, haz lo que puedas y di qué falta.)`
  deps.think(agent.info.id, 'thinking', truncate(`Encargo automático: ${step.task}`))
  try {
    const result = await provider.runAgent(
      {
        agent,
        prompt,
        mcp: deps.getMcp(),
        config: deps.getConfig(),
        workspaceDir: deps.workspaceDir,
        signal: abort.signal
      },
      unattendedSink(spec, agent, deps)
    )
    await deps.recordUsage?.(result.tokens, result).catch(() => undefined)
    deps.think(agent.info.id, result.failed ? 'error' : 'done', result.failed ? 'No pude…' : '¡Listo!')
    const timedOut = abort.signal.aborted && !signal.aborted
    return {
      ok: !result.failed && !abort.signal.aborted,
      output: tail(timedOut ? `${result.text}\nTiempo agotado (${Math.round(step.timeoutMs / 1000)} s).` : result.text)
    }
  } catch (err) {
    deps.think(agent.info.id, 'error', 'No pude…')
    return { ok: false, output: `Error: ${(err as Error).message}` }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Runs every step of an automation, in order. Never throws. */
export async function runAutomation(
  spec: AutomationSpec,
  trigger: AutomationTrigger,
  detail: string | undefined,
  deps: RunnerDeps,
  signal: AbortSignal
): Promise<AutomationRun> {
  const startedAt = Date.now()
  const steps: AutomationStepResult[] = []
  let previous = ''
  let ok = true
  const exec = deps.exec ?? runCommand

  for (const [i, step] of spec.steps.entries()) {
    if (signal.aborted) break
    const t0 = Date.now()
    deps.progress(truncate(`Paso ${i + 1}/${spec.steps.length}: ${step.name}`))
    let result: { ok: boolean; output: string }
    if (step.kind === 'comando') {
      try {
        const cwd = commandCwd(step, deps.workspaceDir, deps.getConfig())
        result = await exec(step.command, cwd, step.timeoutMs, signal)
      } catch (err) {
        result = { ok: false, output: (err as Error).message }
      }
    } else {
      result = await runAgentStep(spec, step, previous, deps, signal)
    }
    steps.push({ name: step.name, kind: step.kind, ok: result.ok, output: result.output, ms: Date.now() - t0 })
    previous = result.output
    if (!result.ok) {
      ok = false
      if (spec.onFailure === 'parar') break
    }
  }

  const run: AutomationRun = { automationId: spec.id, trigger, startedAt, endedAt: Date.now(), ok: ok && !signal.aborted, steps }
  if (detail) run.detail = detail
  if (signal.aborted) run.note = 'Detenida.'
  return run
}
