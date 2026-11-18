import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide, isInside } from '../src/main/brain/permissions'
import { loadAgents, parseAgentFile, rosterText } from '../src/main/brain/registry'
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
    const { info, definition } = parseAgentFile(VALID, 'carpeta')
    expect(info).toMatchObject({ id: 'prueba', name: 'Pía', role: 'Tester' })
    expect(info.sprite.hair).toBe('#112233')
    expect(info.sprite.shirt).toMatch(/^#[0-9a-f]{6}$/i)
    expect(definition).toEqual({
      description: 'Úsala para probar.',
      prompt: 'Eres Pía.',
      tools: ['Read'],
      model: 'haiku'
    })
  })

  it('falls back to the folder name for the id', () => {
    const record = parseAgentFile('---\ndescription: algo\n---\nHola', 'mi-agente')
    expect(record.info.id).toBe('mi-agente')
    expect(record.definition.tools).toBeUndefined()
  })

  it.each([
    ['---\nid: "Mal Id"\ndescription: x\n---\ncuerpo', /id inválido/],
    ['---\nid: cerebro\ndescription: x\n---\ncuerpo', /reservado/],
    ['---\nid: ok\n---\ncuerpo', /description/],
    ['---\nid: ok\ndescription: x\n---\n', /cuerpo/],
    ['---\nid: ok\ndescription: x\ntools: Read\n---\ncuerpo', /tools/]
  ])('rejects invalid file %#', (content, reason) => {
    expect(() => parseAgentFile(content, 'carpeta')).toThrow(reason)
  })
})

describe('loadAgents', () => {
  it('loads the shipped agents without errors', async () => {
    const mcp = { presupuesto: ['mcp__presupuesto__estado'] }
    const { agents, errors } = await loadAgents(resolve(__dirname, '../agents'), mcp)
    expect(errors).toEqual([])
    expect(agents.map((a) => a.info.id).sort()).toEqual(['documentos', 'investigador', 'presupuesto'])
    expect(rosterText(agents)).toContain('subagent_type "investigador": Iris')
    const nora = agents.find((a) => a.info.id === 'presupuesto')!
    expect(nora.definition.tools).toEqual(['Read', 'Glob', 'mcp__presupuesto__estado'])
    expect(nora.definition.mcpServers).toEqual(['presupuesto'])
  })

  it('rejects an agent that asks for an unknown tool server', () => {
    expect(() => parseAgentFile('---\ndescription: x\nmcp: [banco]\n---\ncuerpo', 'a-b')).toThrow(/mcp desconocido/)
  })

  it('lets trusted built-in tools run and asks for the rest', () => {
    const trusted = new Set(['mcp__presupuesto__estado'])
    expect(decide('mcp__presupuesto__estado', {}, '/ws', trusted)).toBe('allow')
    expect(decide('mcp__presupuesto__aplicar_presupuesto', {}, '/ws', trusted)).toBe('ask')
  })

  it('writes budget bubbles and permission text', () => {
    expect(thoughtForTool('mcp__presupuesto__registrar_movimientos', { movimientos: [1, 2, 3] })).toBe('Anotando 3 movimientos')
    expect(thoughtForTool('mcp__presupuesto__guardar_pendientes', { pendientes: [1] })).toBe('Tengo 1 duda de categoría')
    expect(
      permissionSummary('mcp__presupuesto__aplicar_presupuesto', {
        periodo: 'Budget Junio',
        cambios: [{ categoria: 'Compras', presupuesto: 150 }]
      })
    ).toContain('Compras → 150 €')
  })

  it('reports a missing folder instead of throwing', async () => {
    const { agents, errors } = await loadAgents(resolve(__dirname, 'no-existe'))
    expect(agents).toEqual([])
    expect(errors).toHaveLength(1)
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
    expect(decide('Agent', {}, ws)).toBe('allow')
    expect(decide('WebSearch', { query: 'x' }, ws)).toBe('allow')
    expect(decide('Read', { file_path: 'inbox/a.pdf' }, ws)).toBe('allow')
    expect(decide('Write', { file_path: join(ws, 'output', 'r.md') }, ws)).toBe('allow')
    expect(decide('Glob', { pattern: '**/*.pdf' }, ws)).toBe('allow')
    expect(decide('Write', { file_path: '../fuera.txt' }, ws)).toBe('ask')
    expect(decide('Read', { file_path: resolve('/etc/passwd') }, ws)).toBe('ask')
    expect(decide('Write', {}, ws)).toBe('ask')
    expect(decide('Bash', { command: 'dir' }, ws)).toBe('ask')
    expect(decide('mcp__x__y', {}, ws)).toBe('ask')
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
    await store.recordRun({ cerebro: count, presupuesto: count }, 's1', 0.25)
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

    // A resumed session seen for the first time only sets the starting point.
    await reloaded.recordRun({ cerebro: count }, 'viejo', 6, true)
    await reloaded.recordRun({ cerebro: count }, 'viejo', 6.5, true)
    expect(reloaded.snapshot().days[1].costUsd).toBeCloseTo(0.55)
  })
})
