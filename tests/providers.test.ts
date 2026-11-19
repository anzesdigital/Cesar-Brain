import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { brainPrompt } from '../src/main/brain/orchestrator'
import { ClaudeProvider } from '../src/main/brain/providers/claude'
import { CopilotProvider } from '../src/main/brain/providers/copilot'
import { toClaudeAgent, toClaudeMcp } from '../src/main/brain/providers/claude'
import { CopilotTranslator, quotaToLimit, toCopilotAgent, toCopilotMcp } from '../src/main/brain/providers/copilot'
import { fromCopilotTool, permissionToCanonical, toCopilotTools } from '../src/main/brain/providers/toolmap'
import type { RunSink } from '../src/main/brain/providers/types'
import type { AgentRecord } from '../src/main/brain/registry'
import { defaultConfig, loadConfig, parseConfig, resolveModel, updateConfigFile } from '../src/main/config'
import { ensureHome, homePaths } from '../src/main/home'
import { mcpServerOf, parseMcp } from '../src/main/mcp'

function agent(id: string, tools?: string[], mcp: string[] = []): AgentRecord {
  return {
    info: { id, name: id.toUpperCase(), role: '', description: `desc ${id}`, sprite: { hair: '#000000', shirt: '#000000', skin: '#000000' }, zone: 'General' },
    spec: { description: `desc ${id}`, prompt: `Eres ${id}.`, tools, mcp },
    builtin: false
  }
}

describe('config', () => {
  it('fills defaults and validates', () => {
    expect(parseConfig({})).toEqual(defaultConfig())
    const c = parseConfig({ provider: 'copilot', userName: ' Ana ', models: { copilot: { aliases: { sonnet: 'x-1' } } } })
    expect(c.provider).toBe('copilot')
    expect(c.userName).toBe('Ana')
    expect(c.models.copilot.aliases).toEqual({ sonnet: 'x-1' })
    expect(c.models.claude).toEqual({ brain: 'sonnet', aliases: { rapido: 'haiku', normal: 'sonnet', potente: 'opus' } })
    expect(() => parseConfig({ provider: 'gemini' })).toThrow(/provider/)
  })

  it('reads disabledAgents and ignores anything that is not a list of ids', () => {
    expect(parseConfig({ disabledAgents: [' iris ', 'iris', 3, ''] }).disabledAgents).toEqual(['iris'])
    expect(parseConfig({ disabledAgents: 'iris' }).disabledAgents).toEqual([])
  })

  it('falls back to defaults on a broken file and says why', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'))
    const file = join(dir, 'config.json')
    expect(await loadConfig(file)).toEqual({ config: defaultConfig() })
    await writeFile(file, '{ roto', 'utf8')
    const loaded = await loadConfig(file)
    expect(loaded.config).toEqual(defaultConfig())
    expect(loaded.error).toMatch(/no es JSON válido/)
  })

  it('changes one key and keeps the rest of the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'))
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ provider: 'claude', userName: 'Ana', extra: 1 }), 'utf8')
    await updateConfigFile(file, { provider: 'copilot' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ provider: 'copilot', userName: 'Ana', extra: 1 })
  })

  it('maps model aliases per provider', () => {
    const c = parseConfig({ models: { copilot: { aliases: { sonnet: 'claude-sonnet-x' } } } })
    expect(resolveModel(c, 'claude', 'sonnet')).toBe('sonnet')
    expect(resolveModel(c, 'copilot', 'sonnet')).toBe('claude-sonnet-x')
    expect(resolveModel(c, 'copilot', 'haiku')).toBeUndefined()
    expect(resolveModel(c, 'copilot', 'gpt-5')).toBe('gpt-5')
    expect(resolveModel(c, 'claude', undefined)).toBeUndefined()
    expect(resolveModel(c, 'claude', 'rapido')).toBe('haiku')
    expect(resolveModel(c, 'claude', 'potente')).toBe('opus')
    expect(resolveModel(c, 'copilot', 'rapido')).toBeUndefined()
    const cop = parseConfig({ models: { copilot: { aliases: { rapido: 'gpt-mini', normal: '' } } } })
    expect(resolveModel(cop, 'copilot', 'rapido')).toBe('gpt-mini')
    expect(resolveModel(cop, 'copilot', 'normal')).toBeUndefined()
  })
})

describe('mcp.json', () => {
  it('reads stdio and remote servers, trust and disabled flags', () => {
    const c = parseMcp({
      mcpServers: {
        local: { command: 'npx', args: ['-y', 'srv', 3], env: { A: '1', B: 2 }, trusted: true },
        remoto: { url: 'https://x/mcp', headers: { Authorization: 'B' }, trusted: ['leer', 3] },
        apagado: { command: 'x', disabled: true },
        malo: { args: [] },
        'mal nombre': { command: 'x' }
      }
    })
    expect(c.servers).toEqual({
      local: { type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, cwd: undefined },
      remoto: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'B' } }
    })
    expect([...c.trusted]).toEqual(['local'])
    expect([...c.trustedTools]).toEqual(['mcp__remoto__leer'])
    expect(c.errors).toHaveLength(2)
  })

  it('finds the server of an MCP tool name', () => {
    expect(mcpServerOf('mcp__banco__saldo')).toBe('banco')
    expect(mcpServerOf('mcp__mi_srv__a__b')).toBe('mi_srv')
    expect(mcpServerOf('Read')).toBeUndefined()
  })

  it('converts servers for each provider', () => {
    const stdio = { type: 'stdio' as const, command: 'node', args: ['s.js'], cwd: 'C:/x' }
    expect(toClaudeMcp(stdio)).toEqual({ type: 'stdio', command: 'node', args: ['s.js'], env: undefined })
    expect(toCopilotMcp(stdio)).toMatchObject({ type: 'local', command: 'node', workingDirectory: 'C:/x', tools: ['*'] })
    expect(toCopilotMcp({ type: 'sse', url: 'u' })).toMatchObject({ type: 'sse', url: 'u', tools: ['*'] })
  })
})

describe('home folder', () => {
  it('creates the folder, seeds examples once, and keeps existing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'home-'))
    const paths = homePaths(root)
    const examples = resolve(__dirname, '../examples/agents')
    await ensureHome(paths, examples)
    expect((await readdir(paths.agentsDir)).sort()).toEqual(['documentos', 'investigador'])
    expect(JSON.parse(await readFile(paths.configFile, 'utf8')).provider).toBe('claude')
    expect(JSON.parse(await readFile(paths.mcpFile, 'utf8'))).toEqual({ servers: {} })

    await writeFile(paths.configFile, '{"provider":"copilot"}', 'utf8')
    await rm(join(paths.agentsDir, 'documentos'), { recursive: true })
    await ensureHome(paths, examples)
    expect(await readFile(paths.configFile, 'utf8')).toBe('{"provider":"copilot"}')
    expect(await readdir(paths.agentsDir)).toEqual(['investigador'])
  })
})

describe('model choice per job', () => {
  it('tells the brain which model to use for each difficulty', () => {
    const claude = new ClaudeProvider(() => undefined).delegationText(defaultConfig())
    expect(claude).toContain('`Agent`')
    expect(claude).toContain('`haiku`: tareas sencillas')
    expect(claude).toContain('`opus`: solo lo realmente complejo')
    // Copilot without tiers configured: no model advice, just how to delegate.
    const bare = new CopilotProvider().delegationText(defaultConfig())
    expect(bare).toContain('`task`')
    expect(bare).not.toContain('model')
    const cop = new CopilotProvider().delegationText(parseConfig({ models: { copilot: { aliases: { rapido: 'gpt-mini', potente: 'gpt-max' } } } }))
    expect(cop).toContain('`gpt-mini`: tareas sencillas')
    expect(cop).toContain('`gpt-max`')
  })

  it('skips Claude tiers the Agent tool cannot take', () => {
    const text = new ClaudeProvider(() => undefined).delegationText(
      parseConfig({ models: { claude: { aliases: { rapido: 'claude-haiku-9-9' } } } })
    )
    expect(text).not.toContain('claude-haiku-9-9')
    expect(text).toContain('`sonnet`')
  })
})

describe('brain prompt', () => {
  it('fills roster, memory, user and delegation', () => {
    const text = brainPrompt('---\nx: 1\n---\nHola {{USER}}. {{DELEGATION}}\n{{ROSTER}}\n{{MEMORY}}', {
      roster: '- "a"',
      memory: '',
      user: 'Ana',
      delegation: 'Usa task.'
    })
    expect(text).toBe('Hola Ana. Usa task.\n- "a"\n(vacía)')
  })
})

describe('tool translation', () => {
  it('maps canonical tools to Copilot tools', () => {
    expect(toCopilotTools(undefined, ['x'])).toBeUndefined()
    expect(toCopilotTools(['Read', 'Write', 'WebSearch', 'WebFetch', 'mcp__banco__saldo'], ['gh'], 'linux')).toEqual([
      'view',
      'create',
      'web_fetch',
      'banco-saldo',
      'gh/*'
    ])
    expect(toCopilotTools(['Bash'], [], 'win32')).toEqual(['powershell', 'read_powershell', 'stop_powershell', 'list_powershell'])
  })

  it('maps Copilot tool calls and permission requests back to canonical names', () => {
    expect(fromCopilotTool('view', { path: 'C:/w/a.pdf' })).toEqual({ tool: 'Read', input: { file_path: 'C:/w/a.pdf' } })
    expect(fromCopilotTool('powershell', { command: 'dir', description: 'Listar' })).toEqual({
      tool: 'Bash',
      input: { command: 'dir', description: 'Listar' }
    })
    expect(fromCopilotTool('x', { a: 1 }, { server: 'banco', tool: 'saldo' })).toEqual({ tool: 'mcp__banco__saldo', input: { a: 1 } })
    expect(permissionToCanonical({ kind: 'write', fileName: 'C:/a.md' })).toEqual({ tool: 'Write', input: { file_path: 'C:/a.md' } })
    expect(permissionToCanonical({ kind: 'shell', fullCommandText: 'rm x' })).toEqual({ tool: 'Bash', input: { command: 'rm x' } })
    expect(permissionToCanonical({ kind: 'mcp', serverName: 's', toolName: 't', args: { q: 1 } })).toEqual({
      tool: 'mcp__s__t',
      input: { q: 1 }
    })
    expect(permissionToCanonical({ kind: 'url', url: 'https://x' }).tool).toBe('WebFetch')
  })

  it('builds agent definitions for each provider', () => {
    const a = agent('iris', ['WebFetch', 'Bash'], ['gh'])
    expect(toClaudeAgent(a, 'sonnet')).toEqual({
      description: 'desc iris',
      prompt: 'Eres iris.',
      tools: ['WebFetch', 'Bash', 'PowerShell', 'mcp__gh'],
      mcpServers: ['gh'],
      model: 'sonnet'
    })
    expect(toClaudeAgent(agent('todo'), undefined)).toEqual({ description: 'desc todo', prompt: 'Eres todo.' })
    const c = toCopilotAgent(a, undefined)
    expect(c).toMatchObject({ name: 'iris', displayName: 'IRIS', description: 'desc iris', prompt: 'Eres iris.' })
    expect(c.tools).toContain('web_fetch')
    expect(c.tools).toContain('gh/*')
    expect(c.model).toBeUndefined()
    expect(toCopilotAgent(agent('todo'), 'gpt-5')).toMatchObject({ tools: null, model: 'gpt-5' })
  })
})

function fakeSink(): RunSink & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const rec =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args])
    }
  return {
    calls,
    sessionId: rec('sessionId'),
    textDelta: rec('textDelta'),
    agentText: rec('agentText'),
    toolStart: rec('toolStart'),
    delegationStart: rec('delegationStart'),
    delegationEnd: rec('delegationEnd'),
    limits: rec('limits'),
    authorize: vi.fn(async () => true)
  }
}

describe('Copilot event translation', () => {
  it('follows a delegation and attributes the sub-agent work', () => {
    const sink = fakeSink()
    const t = new CopilotTranslator(new Set(['iris', 'dante']), sink)
    t.handle({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Voy ' } })
    t.handle({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'a delegar' } })
    t.handle({
      type: 'tool.execution_start',
      data: { toolCallId: 'c1', toolName: 'task', arguments: { agent_type: 'iris', description: 'Buscar precios' } }
    })
    t.handle({ type: 'subagent.started', data: { toolCallId: 'c1', agentName: 'iris' } })
    t.handle({ type: 'tool.execution_start', agentId: 'inst-9', data: { toolCallId: 'c2', toolName: 'web_fetch', arguments: { url: 'https://a.com' } } })
    t.handle({ type: 'assistant.message', agentId: 'inst-9', data: { content: 'Encontré tres precios.' } })
    t.handle({ type: 'assistant.usage', agentId: 'inst-9', data: { model: 'm', inputTokens: 10, outputTokens: 5, cost: 1 } })
    t.handle({ type: 'subagent.completed', data: { toolCallId: 'c1', agentName: 'iris' } })
    t.handle({ type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true } })
    t.handle({ type: 'assistant.message', data: { content: 'Resumen final' } })
    t.handle({ type: 'assistant.usage', data: { model: 'm', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cost: 0.33 } })

    expect(sink.calls).toEqual([
      ['textDelta', 'Voy '],
      ['textDelta', 'Voy a delegar'],
      ['delegationStart', 'c1', 'iris', 'Buscar precios'],
      ['toolStart', 'iris', 'WebFetch', { url: 'https://a.com' }],
      ['agentText', 'iris', 'Encontré tres precios.'],
      ['delegationEnd', 'c1', true]
    ])
    expect(t.finalText).toBe('Resumen final')
    expect(t.premium).toBeCloseTo(1.33)
    expect(t.totals()).toEqual({
      iris: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      cerebro: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0 }
    })
    expect(t.ownerOf('c2')).toBe('iris')
    expect(t.ownerOf('desconocido')).toBe('cerebro')
  })

  it('treats a task for an unknown agent as a normal tool and records errors', () => {
    const sink = fakeSink()
    const t = new CopilotTranslator(new Set(['iris']), sink)
    t.handle({ type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'task', arguments: { agent_type: 'explore' } } })
    t.handle({ type: 'subagent.failed', data: { toolCallId: 'c1', agentName: 'explore', error: 'x' } })
    t.handle({ type: 'session.error', data: { message: 'cuota agotada' } })
    expect(sink.calls).toEqual([['toolStart', 'cerebro', 'task', { agent_type: 'explore' }]])
    expect(t.error).toBe('cuota agotada')
  })

  it('reads the premium quota as a limit', () => {
    expect(quotaToLimit({ isUnlimitedEntitlement: true })).toEqual({ limits: [], available: false })
    const { limits, available } = quotaToLimit({
      remainingPercentage: 70,
      entitlementRequests: 300,
      usedRequests: 90,
      resetDate: '2026-12-01T00:00:00Z'
    })
    expect(available).toBe(true)
    expect(limits[0]).toMatchObject({ id: 'premium', percent: 30, resetsAt: Date.parse('2026-12-01T00:00:00Z') })
    expect(limits[0].label).toContain('90 de 300')
  })
})
