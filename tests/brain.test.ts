import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide, isInside } from '../src/main/brain/permissions'
import { fillPlaceholders, loadAgents, parseAgentFile, rosterText } from '../src/main/brain/registry'
import { limitsFromPlan, RunMeter, UsageStore } from '../src/main/brain/usage'
import { firstSentence, MAX_BUBBLE, permissionSummary, thoughtForTool, truncate } from '../src/main/brain/thoughts'

const VALID = `---
id: prueba
name: Pía
role: Tester
description: Úsala para probar.
tools: [Read]
model: haiku
sprite:
  hair: "#112233"
---
Eres Pía.`

describe('parseAgentFile', () => {
  it('parses a complete agent', () => {
    const { info, spec } = parseAgentFile(VALID, 'carpeta')
    expect(info).toMatchObject({ id: 'prueba', name: 'Pía', role: 'Tester' })
    expect(info.sprite.hair).toBe('#112233')
    expect(info.sprite.shirt).toMatch(/^#[0-9a-f]{6}$/i)
    expect(spec).toEqual({
      description: 'Úsala para probar.',
      prompt: 'Eres Pía.',
      tools: ['Read'],
      mcp: [],
      model: 'haiku'
    })
  })

  it('falls back to the folder name for the id', () => {
    const record = parseAgentFile('---\ndescription: algo\n---\nHola', 'mi-agente')
    expect(record.info.id).toBe('mi-agente')
    expect(record.spec.tools).toBeUndefined()
  })

  it.each([
    ['---\nid: "Mal Id"\ndescription: x\n---\ncuerpo', /id inválido/],
    ['---\nid: cerebro\ndescription: x\n---\ncuerpo', /reservado/],
    ['---\nid: ok\n---\ncuerpo', /description/],
    ['---\nid: ok\ndescription: x\n---\n', /cuerpo/],
    ['---\nid: ok\ndescription: x\ntools: Read\n---\ncuerpo', /tools/],
    ['---\nid: ok\ndescription: x\ntools: [Leer]\n---\ncuerpo', /herramienta desconocida: Leer/]
  ])('rejects invalid file %#', (content, reason) => {
    expect(() => parseAgentFile(content, 'carpeta')).toThrow(reason)
  })
})

describe('loadAgents', () => {
  const builtin = { dir: resolve(__dirname, '../brain/agents'), builtin: true }
  const examples = { dir: resolve(__dirname, '../examples/agents'), builtin: false }

  it('loads the built-in and example agents without errors', async () => {
    const { agents, errors } = await loadAgents([builtin, examples], new Set(), { USER: 'Ana', AGENTS_DIR: '/a' })
    expect(errors).toEqual([])
    expect(agents.map((a) => a.info.id)).toEqual(['configurador', 'documentos', 'investigador'])
    expect(agents[0].builtin).toBe(true)
    expect(agents[1].builtin).toBe(false)
    expect(agents[0].spec.prompt).toContain('/a/<id>/agent.md')
    expect(agents[1].spec.prompt).toContain('ayuda a Ana')
    expect(agents[1].info.description).toContain('que Ana adjunta')
    expect(rosterText(agents)).toContain('- "investigador": Iris')
  })

  it('keeps the first agent on a repeated id, skips disabled folders, and reports bad files', async () => {
    const user = await mkdtemp(join(tmpdir(), 'agentes-'))
    const write = async (folder: string, content: string): Promise<void> => {
      await mkdir(join(user, folder), { recursive: true })
      await writeFile(join(user, folder, 'agent.md'), content, 'utf8')
    }
    await write('configurador', '---\ndescription: copia\n---\nOtra')
    await write('_apagado', '---\ndescription: x\n---\ncuerpo')
    await write('roto', '---\nid: roto\n---\ncuerpo')
    await write('con-mcp', '---\ndescription: x\nmcp: [banco]\n---\ncuerpo')
    await write('nuevo', VALID)

    const { agents, errors } = await loadAgents([builtin, { dir: user, builtin: false }], new Set(['banco']))
    expect(agents.map((a) => a.info.id)).toEqual(['configurador', 'con-mcp', 'prueba'])
    expect(agents.find((a) => a.info.id === 'con-mcp')!.spec.mcp).toEqual(['banco'])
    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).toMatch(/id duplicado "configurador"/)
    expect(errors.join('\n')).toMatch(/roto\/agent.md: falta "description"/)
  })

  it('rejects an agent that asks for an unknown MCP server', () => {
    expect(() => parseAgentFile('---\ndescription: x\nmcp: [banco]\n---\ncuerpo', 'a-b')).toThrow(/mcp desconocido/)
  })

  it('reports a missing folder instead of throwing', async () => {
    const { agents, errors } = await loadAgents([{ dir: resolve(__dirname, 'no-existe'), builtin: false }])
    expect(agents).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('adds the shared rules to every agent', async () => {
    const { agents } = await loadAgents([builtin, examples], new Set(), { USER: 'Ana' }, 'Sé breve, {{USER}}.')
    expect(agents.length).toBeGreaterThan(0)
    for (const a of agents) expect(a.spec.prompt.endsWith('\n\nSé breve, Ana.')).toBe(true)
  })

  it('ships brain/estilo.md with the cost rules', async () => {
    const text = await readFile(resolve(__dirname, '../brain/estilo.md'), 'utf8')
    expect(text).toMatch(/gastar poco/i)
    expect(text).toMatch(/No expliques el proceso/)
  })

  it('fills known placeholders and leaves the rest', () => {
    expect(fillPlaceholders('Hola {{USER}}, {{OTRO}}', { USER: 'Ana' })).toBe('Hola Ana, {{OTRO}}')
  })
})

describe('thoughts', () => {
  it('keeps bubbles within the limit', () => {
    const long = thoughtForTool('WebSearch', { query: 'x'.repeat(200) })
    expect(long.length).toBeLessThanOrEqual(MAX_BUBBLE)
    expect(long.endsWith('…')).toBe(true)
    expect(truncate('  corto \n texto ')).toBe('corto texto')
  })

  it('describes known tools', () => {
    expect(thoughtForTool('WebSearch', { query: 'clima CDMX' })).toBe('Buscando: «clima CDMX»')
    expect(thoughtForTool('WebFetch', { url: 'https://www.ejemplo.com/a/b' })).toBe('Leyendo ejemplo.com')
    expect(thoughtForTool('Read', { file_path: 'C:\\w\\inbox\\reporte.pdf' })).toBe('Abriendo reporte.pdf')
    expect(thoughtForTool('Write', { file_path: 'output/resumen.md' })).toBe('Escribiendo resumen.md')
    expect(thoughtForTool('mcp__gmail__send', {})).toBe('Usando gmail › send')
    expect(thoughtForTool('WebFetch', { url: 'no es url' })).toBe('Leyendo la web')
  })

  it('extracts a first sentence without markdown', () => {
    expect(firstSentence('## **Voy** a revisar el PDF. Luego resumo.')).toBe('Voy a revisar el PDF.')
    expect(firstSentence('```js\ncode\n```')).toBe('')
  })
})

describe('permissions', () => {
  const ws = resolve('/tmp/ws')

  it('detects paths inside and outside a root', () => {
    expect(isInside(join(ws, 'inbox', 'a.pdf'), ws)).toBe(true)
    expect(isInside(ws, ws)).toBe(true)
    expect(isInside(join(ws, '..', 'ws-otro', 'a'), ws)).toBe(false)
    expect(isInside(join(ws, '..', 'secreto.txt'), ws)).toBe(false)
  })

  it('allows delegation, web and workspace files; asks for the rest', () => {
    const ctx = { workspaceDir: ws }
    expect(decide('Agent', {}, ctx)).toBe('allow')
    expect(decide('WebSearch', { query: 'x' }, ctx)).toBe('allow')
    expect(decide('Read', { file_path: 'inbox/a.pdf' }, ctx)).toBe('allow')
    expect(decide('Write', { file_path: join(ws, 'output', 'r.md') }, ctx)).toBe('allow')
    expect(decide('Glob', { pattern: '**/*.pdf' }, ctx)).toBe('allow')
    expect(decide('Write', { file_path: '../fuera.txt' }, ctx)).toBe('ask')
    expect(decide('Read', { file_path: resolve('/etc/passwd') }, ctx)).toBe('ask')
    expect(decide('Write', {}, ctx)).toBe('ask')
    expect(decide('Bash', { command: 'dir' }, ctx)).toBe('ask')
    expect(decide('mcp__x__y', {}, ctx)).toBe('ask')
  })

  it('reads the agents folder freely but asks before writing there', () => {
    const agentsDir = resolve('/tmp/agentes')
    const ctx = { workspaceDir: ws, readableDirs: [agentsDir] }
    expect(decide('Read', { file_path: join(agentsDir, 'a', 'agent.md') }, ctx)).toBe('allow')
    expect(decide('Glob', { pattern: '*/agent.md', path: agentsDir }, ctx)).toBe('allow')
    expect(decide('Write', { file_path: join(agentsDir, 'b', 'agent.md') }, ctx)).toBe('ask')
  })

  it('lets tools of trusted MCP servers run', () => {
    const ctx = { workspaceDir: ws, trustedServers: new Set(['banco']) }
    expect(decide('mcp__banco__saldo', {}, ctx)).toBe('allow')
    expect(decide('mcp__otro__borrar', {}, ctx)).toBe('ask')
    const some = { workspaceDir: ws, trustedTools: new Set(['mcp__banco__saldo']) }
    expect(decide('mcp__banco__saldo', {}, some)).toBe('allow')
    expect(decide('mcp__banco__transferir', {}, some)).toBe('ask')
  })
})

describe('usage', () => {
  it('counts each streamed message once, per agent', () => {
    const meter = new RunMeter()
    meter.start('main', 'cerebro', 'm1', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 })
    meter.delta('main', { output_tokens: 40 })
    meter.message('cerebro', 'm1', { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50 })
    meter.message('cerebro', 'm1', { input_tokens: 100, output_tokens: 1 })
    meter.start('job1', 'presupuesto', 'm2', { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 7 })
    meter.delta('job1', { output_tokens: 30 })
    meter.delta('desconocido', { output_tokens: 999 })
    expect(meter.totals()).toEqual({
      cerebro: { input: 100, output: 40, cacheRead: 50, cacheWrite: 0 },
      presupuesto: { input: 10, output: 30, cacheRead: 0, cacheWrite: 7 }
    })
  })

  it('reads plan limits and skips empty windows', () => {
    const limits = limitsFromPlan({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42.4, resets_at: '2026-11-13T15:00:00Z' },
        seven_day: { utilization: 130, resets_at: null },
        seven_day_opus: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: null }]
      }
    })
    expect(limits.map((l) => [l.id, l.percent])).toEqual([
      ['five_hour', 42.4],
      ['seven_day', 100],
      ['model:Fable', 12]
    ])
    expect(limits[0].resetsAt).toBe(Date.parse('2026-11-13T15:00:00Z'))
    expect(limitsFromPlan({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual([])
  })

  it('adds runs into days and charges only the new part of a session cost', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uso-'))
    let now = new Date(2026, 10, 13, 10)
    const store = new UsageStore(join(dir, 'usage.json'), () => now)
    const count = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
    await store.recordRun({ cerebro: count }, 's1', 0.1)
    await store.recordRun({ cerebro: count, presupuesto: count }, 's1', 0.25, false, 2)
    now = new Date(2026, 10, 14, 9)
    await store.recordRun({ cerebro: count }, 's2', 0.05)

    const reloaded = new UsageStore(join(dir, 'usage.json'), () => now)
    await reloaded.load()
    const days = reloaded.snapshot().days
    expect(days.map((d) => [d.date, d.runs])).toEqual([
      ['2026-11-13', 2],
      ['2026-11-14', 1]
    ])
    expect(days[0].costUsd).toBeCloseTo(0.25)
    expect(days[1].costUsd).toBeCloseTo(0.05)
    expect(days[0].agents.cerebro.input).toBe(20)
    expect(days[0].agents.presupuesto.output).toBe(5)
    expect(days[0].premiumRequests).toBe(2)
    expect(days[1].premiumRequests).toBeUndefined()

    // A resumed session seen for the first time only sets the starting point.
    await reloaded.recordRun({ cerebro: count }, 'viejo', 6, true)
    await reloaded.recordRun({ cerebro: count }, 'viejo', 6.5, true)
    expect(reloaded.snapshot().days[1].costUsd).toBeCloseTo(0.55)
  })

  it('keeps limits with their provider and clears them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uso-'))
    const store = new UsageStore(join(dir, 'usage.json'))
    await store.setLimits('copilot', [{ id: 'premium', label: 'P', percent: 30 }], true, 'Copilot')
    expect(store.snapshot()).toMatchObject({ limitsProvider: 'copilot', plan: 'Copilot', limitsAvailable: true })
    await store.clearLimits()
    expect(store.snapshot().limits).toEqual([])
    expect(store.snapshot().limitsProvider).toBeUndefined()
  })
})
