import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../src/shared/types'
import { defaultConfig, type AppConfig } from '../src/main/config'
import { emptyCatalog } from '../src/main/mcp'
import type { AgentRecord } from '../src/main/brain/registry'
import type { AgentRunRequest, BrainProvider } from '../src/main/brain/providers/types'
import {
  allowedByAutomation,
  commandCwd,
  runAutomation,
  runCommand,
  unattendedSink,
  type RunnerDeps
} from '../src/main/automations/runner'
import { AutomationManager, type Executor } from '../src/main/automations/scheduler'
import { loadAutomations, parseAutomationFile, yamlHint, parseDuration, triggerTexts, type AutomationSpec } from '../src/main/automations/spec'

const ctx = { agentIds: new Set(['dev', 'resumidor']), repoNames: new Set(['api']) }

const SAMPLE = `---
id: pull-api
name: Pull de api
description: Mantiene api al día
cuando:
  cada: 30m
  al-arrancar: true
  archivos: inbox
  agente: [dev]
pasos:
  - nombre: Traer cambios
    comando: git pull origin main
    repo: api
  - agente: resumidor
    encargo: "Resume: {salida}"
    modelo: rapido
permitir: [Write, mcp__notion]
si-falla: seguir
---
Notas.`

function parse(content: string): AutomationSpec {
  return parseAutomationFile(content, 'pull-api', '/x/pull-api', ctx)
}

function withFront(front: string): string {
  return `---\n${front}\n---\n`
}

describe('automation spec', () => {
  it('parses durations', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('1,5h')).toBe(5_400_000)
    expect(() => parseDuration('cada rato')).toThrow(/duración/)
  })

  it('reads a full automation.md', () => {
    const spec = parse(SAMPLE)
    expect(spec.id).toBe('pull-api')
    expect(spec.everyMs).toBe(1_800_000)
    expect(spec.onStartup).toBe(true)
    expect(spec.watch).toEqual({ folder: 'inbox' })
    expect(spec.beforeAgents).toEqual(['dev'])
    expect(spec.steps).toEqual([
      { kind: 'comando', name: 'Traer cambios', command: 'git pull origin main', repo: 'api', timeoutMs: 120_000 },
      { kind: 'agente', name: 'Encargo a resumidor', agent: 'resumidor', task: 'Resume: {salida}', model: 'rapido', timeoutMs: 900_000 }
    ])
    expect(spec.allow).toEqual(['Write', 'mcp__notion'])
    expect(spec.onFailure).toBe('seguir')
    expect(spec.notes).toBe('Notas.')
    expect(spec.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(triggerTexts(spec)).toEqual(['cada 30 min', 'al arrancar', 'al cambiar inbox', 'antes de encargos a dev', 'manual'])
  })

  it('ties the hash to the exact text', () => {
    expect(parse(SAMPLE).hash).not.toBe(parse(SAMPLE.replace('30m', '31m')).hash)
  })

  it('explains what is wrong', () => {
    const step = 'pasos:\n  - comando: echo hola'
    expect(() => parse(withFront('id: X'))).toThrow(/id inválido/)
    expect(() => parse(withFront('id: ok'))).toThrow(/faltan "pasos"/)
    expect(() => parse(withFront(`cuando:\n  cada: 10s\n${step}`))).toThrow(/al menos 1m/)
    expect(() => parse(withFront(`cuando:\n  agente: [nadie]\n${step}`))).toThrow(/no existe nadie/)
    expect(() => parse(withFront(`cuando:\n  archivos: ../fuera\n${step}`))).toThrow(/dentro del directorio de trabajo/)
    expect(() => parse(withFront(`cuando:\n  archivos: repo:web\n${step}`))).toThrow(/repo "web"/)
    expect(() => parse(withFront('pasos:\n  - comando: echo\n    repo: web'))).toThrow(/repo "web"/)
    expect(() => parse(withFront('pasos:\n  - comando: echo\n    carpeta: C:/Windows'))).toThrow(/dentro del directorio/)
    expect(() => parse(withFront('pasos:\n  - agente: nadie\n    encargo: x'))).toThrow(/no existe el agente/)
    expect(() => parse(withFront('pasos:\n  - agente: dev'))).toThrow(/falta "encargo"/)
    expect(() => parse(withFront('pasos:\n  - comando: a\n    agente: dev'))).toThrow(/no los dos/)
    expect(() => parse(withFront(`${step}\npermitir: [Volar]`))).toThrow(/herramienta desconocida/)
    expect(() => parse(withFront(`${step}\nsi-falla: llorar`))).toThrow(/si-falla/)
  })

  it('loads a folder, reporting bad files and skipping disabled ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autos-'))
    try {
      const put = async (folder: string, content: string): Promise<void> => {
        await mkdir(join(dir, folder), { recursive: true })
        await writeFile(join(dir, folder, 'automation.md'), content)
      }
      await put('pull-api', SAMPLE)
      await put('mala', withFront('pasos: []'))
      await put('_apagada', SAMPLE)
      await put('sin-comillas', withFront('description: Prueba: algo\npasos:\n  - comando: echo'))
      const { automations, errors } = await loadAutomations(dir, ctx)
      expect(automations.map((a) => a.id)).toEqual(['pull-api'])
      expect(errors).toEqual([
        expect.stringContaining('automations/mala/automation.md'),
        expect.stringContaining('sin comillas')
      ])
      expect(yamlHint('otro error')).toBe('otro error')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function agent(id: string, tools?: string[], repos?: string[]): AgentRecord {
  return {
    info: { id, name: id, role: '', description: id, sprite: { hair: '#000000', shirt: '#000000', skin: '#000000' }, zone: 'General' },
    spec: { description: id, prompt: `Eres ${id}.`, tools, mcp: [], ...(repos ? { repos } : {}) },
    builtin: false
  }
}

function deps(overrides: Partial<RunnerDeps> = {}, config: AppConfig = defaultConfig()): RunnerDeps {
  return {
    workspaceDir: '/ws',
    readableDirs: [],
    getConfig: () => config,
    getAgents: () => [agent('dev'), agent('resumidor', ['Read', 'Write'])],
    getMcp: () => emptyCatalog(),
    getProvider: () => {
      throw new Error('sin proveedor')
    },
    think: () => undefined,
    progress: () => undefined,
    ...overrides
  }
}

describe('automation runner', () => {
  it('chains a command into an agent step through {salida}', async () => {
    const config = { ...defaultConfig(), repos: [{ name: 'api', path: '/repos/api', write: true }] }
    const calls: AgentRunRequest[] = []
    const provider = {
      runAgent: async (req: AgentRunRequest) => {
        calls.push(req)
        return { text: 'resumen hecho', failed: false, tokens: { resumidor: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } }
      }
    } as unknown as BrainProvider
    const exec = vi.fn(async () => ({ ok: true, output: '3 commits nuevos' }))
    const recordUsage = vi.fn(async () => undefined)
    const run = await runAutomation(
      parse(SAMPLE),
      'manual',
      undefined,
      deps({ exec, getProvider: () => provider, recordUsage }, config),
      new AbortController().signal
    )
    expect(exec).toHaveBeenCalledWith('git pull origin main', '/repos/api', 120_000, expect.anything())
    expect(calls[0].agent.info.id).toBe('resumidor')
    expect(calls[0].agent.spec.model).toBe('rapido')
    expect(calls[0].prompt).toContain('Resume: 3 commits nuevos')
    expect(run.ok).toBe(true)
    expect(run.steps.map((s) => [s.name, s.ok, s.output])).toEqual([
      ['Traer cambios', true, '3 commits nuevos'],
      ['Encargo a resumidor', true, 'resumen hecho']
    ])
    expect(recordUsage).toHaveBeenCalledOnce()
  })

  it('stops at the first failure with si-falla: parar', async () => {
    const spec = parse(withFront('pasos:\n  - comando: uno\n  - comando: dos'))
    const exec = vi.fn(async () => ({ ok: false, output: 'mal' }))
    const run = await runAutomation(spec, 'manual', undefined, deps({ exec }), new AbortController().signal)
    expect(exec).toHaveBeenCalledOnce()
    expect(run.ok).toBe(false)
    expect(run.steps).toHaveLength(1)
  })

  it('runs commands in the workspace unless told otherwise, never outside it', () => {
    const config = defaultConfig()
    expect(commandCwd({ kind: 'comando', name: '', command: '', timeoutMs: 1 }, '/ws', config)).toMatch(/ws$/)
    expect(() => commandCwd({ kind: 'comando', name: '', command: '', repo: 'api', timeoutMs: 1 }, '/ws', config)).toThrow(/ya no está/)
  })

  it('never asks the user: only the approved permitir list opens the door', async () => {
    const spec = parse(withFront('pasos:\n  - agente: dev\n    encargo: x\npermitir: [Bash]'))
    const strict = parse(withFront('pasos:\n  - agente: dev\n    encargo: x'))
    const ws = join(tmpdir(), 'ws')
    const d = deps({ workspaceDir: ws })
    const allowed = unattendedSink(spec, agent('dev'), d)
    const denied = unattendedSink(strict, agent('dev'), d)
    expect(await allowed.authorize('dev', 'Bash', { command: 'ls' })).toBe(true)
    expect(await denied.authorize('dev', 'Bash', { command: 'ls' })).toMatch(/sin supervisión/)
    // Free things stay free, refused things stay refused.
    expect(await denied.authorize('dev', 'Write', { file_path: join(ws, 'a.txt') })).toBe(true)
    expect(await denied.authorize('dev', 'Write', { file_path: join(tmpdir(), 'fuera.txt') })).toMatch(/sin supervisión/)
  })

  it('matches permitir entries', () => {
    expect(allowedByAutomation('mcp__notion__search', ['mcp__notion'])).toBe(true)
    expect(allowedByAutomation('mcp__notion__search', ['mcp__notion__search'])).toBe(true)
    expect(allowedByAutomation('mcp__slack__post', ['mcp__notion'])).toBe(false)
    expect(allowedByAutomation('PowerShell', ['Bash'])).toBe(true)
    expect(allowedByAutomation('Bash', ['Write'])).toBe(false)
  })

  it('runs a real shell command with its output and exit code', async () => {
    const ok = await runCommand('echo hola', tmpdir(), 30_000, new AbortController().signal)
    expect(ok).toEqual({ ok: true, output: 'hola' })
    const bad = await runCommand('exit 3', tmpdir(), 30_000, new AbortController().signal)
    expect(bad.ok).toBe(false)
    expect(bad.output).toContain('código 3')
  }, 30_000)
})

describe('automation manager', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'automgr-'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  function manager(execute: Executor): { m: AutomationManager; runs: AutomationRun[] } {
    const runs: AutomationRun[] = []
    const m = new AutomationManager({
      stateFile: join(dir, 'state.json'),
      runsDir: join(dir, 'runs'),
      execute,
      events: { changed: () => undefined, run: (r) => runs.push(r), think: () => undefined }
    })
    return { m, runs }
  }

  const okRun: Executor = async (spec, trigger, detail) => ({
    automationId: spec.id,
    trigger,
    ...(detail ? { detail } : {}),
    startedAt: Date.now(),
    endedAt: Date.now(),
    ok: true,
    steps: []
  })

  it('does nothing until approved; an edit needs a new approval', async () => {
    const execute = vi.fn(okRun)
    const { m } = manager(execute)
    await m.load()
    const spec = parse(SAMPLE)
    m.setSpecs([spec])
    expect(m.list()[0]).toMatchObject({ enabled: false, needsApproval: true })
    expect(() => m.runNow('pull-api')).toThrow(/aprueba/)
    await expect(m.setEnabled('pull-api', true)).rejects.toThrow(/aprueba/)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(execute).not.toHaveBeenCalled()

    await m.approve('pull-api')
    expect(m.list()[0]).toMatchObject({ enabled: true, needsApproval: false })
    expect(m.list()[0].nextRunAt).toBe(Date.now() + 1_800_000)

    m.setSpecs([parse(SAMPLE.replace('30m', '45m'))])
    expect(m.list()[0].needsApproval).toBe(true)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(execute).not.toHaveBeenCalled()
    await m.whenIdle()
    m.dispose()
  })

  it('runs on its interval, keeps the history and remembers state on restart', async () => {
    const { m, runs } = manager(okRun)
    await m.load()
    m.setSpecs([parse(SAMPLE)])
    await m.approve('pull-api')
    await vi.advanceTimersByTimeAsync(1_800_000 + 100)
    await m.whenIdle()
    await vi.advanceTimersByTimeAsync(1_800_000 + 100)
    await m.whenIdle()
    expect(runs.map((r) => r.trigger)).toEqual(['intervalo', 'intervalo'])
    expect((await m.runs('pull-api')).length).toBe(2)
    m.dispose()

    // A restart keeps approval; the start-up trigger fires once.
    const again = manager(okRun)
    await again.m.load()
    again.m.setSpecs([parse(SAMPLE)])
    await again.m.whenIdle()
    expect(again.runs.map((r) => r.trigger)).toEqual(['arranque'])
    expect(again.m.list()[0].lastRun?.ok).toBe(true)
    again.m.dispose()
  })

  it('never overlaps a run with itself', async () => {
    let release!: () => void
    const execute = vi.fn(
      (spec: AutomationSpec, trigger: AutomationRun['trigger']) =>
        new Promise<AutomationRun>((resolve) => {
          release = () => resolve({ automationId: spec.id, trigger, startedAt: 0, endedAt: 0, ok: true, steps: [] })
        })
    )
    const { m } = manager(execute)
    await m.load()
    m.setSpecs([parse(withFront('pasos:\n  - comando: lento'))])
    await m.approve('pull-api')
    m.runNow('pull-api')
    expect(() => m.runNow('pull-api')).toThrow(/Ya se está ejecutando/)
    void m.trigger('pull-api', 'intervalo')
    expect(execute).toHaveBeenCalledOnce()
    release()
    await m.whenIdle()
    m.dispose()
  })

  it('makes a job to an agent wait for its automations', async () => {
    const order: string[] = []
    const execute: Executor = async (spec, trigger, detail) => {
      await new Promise((r) => setTimeout(r, 1000))
      order.push(`auto:${detail}`)
      return okRun(spec, trigger, detail, new AbortController().signal, () => undefined)
    }
    const { m } = manager(execute)
    await m.load()
    m.setSpecs([parse(SAMPLE)])
    await m.approve('pull-api')
    const waiting = m.beforeDelegation('dev').then(() => order.push('encargo'))
    await m.beforeDelegation('resumidor') // not tied to it: returns at once
    await vi.advanceTimersByTimeAsync(1500)
    await waiting
    await m.whenIdle()
    expect(order).toEqual(['auto:dev', 'encargo'])
    m.dispose()
  })
})
