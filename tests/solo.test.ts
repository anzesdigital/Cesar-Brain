import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

// Captures what the Claude provider asks the SDK for, without running it.
const captured: Options[] = []
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Options }) => {
    captured.push(options)
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'hecho', is_error: false, session_id: 's1', total_cost_usd: 0 }
    })()
  }
}))

const { ClaudeProvider } = await import('../src/main/brain/providers/claude')
const { CopilotTranslator } = await import('../src/main/brain/providers/copilot')
const { defaultConfig } = await import('../src/main/config')
type RunSink = import('../src/main/brain/providers/types').RunSink
type AgentRecord = import('../src/main/brain/registry').AgentRecord

const catalog = {
  servers: {
    notion: { type: 'http' as const, url: 'https://n' },
    slack: { type: 'http' as const, url: 'https://s' }
  },
  trusted: new Set<string>(),
  trustedTools: new Set<string>(),
  errors: []
}

const dev: AgentRecord = {
  info: { id: 'dev', name: 'Dev', role: '', description: 'd', sprite: { hair: '#000000', shirt: '#000000', skin: '#000000' }, zone: 'General' },
  spec: { description: 'd', prompt: 'Eres Dev.', tools: ['Read', 'Bash'], mcp: ['notion'], model: 'rapido' },
  builtin: false
}

function sink(): RunSink & { texts: string[][] } {
  const texts: string[][] = []
  return {
    texts,
    sessionId: () => undefined,
    textDelta: () => undefined,
    agentText: (id, text) => texts.push([id, text]),
    toolStart: () => undefined,
    delegationStart: () => undefined,
    delegationEnd: () => undefined,
    limits: () => undefined,
    authorize: async () => true
  }
}

describe('running one agent alone (automations)', () => {
  it('Claude: the agent is the session, with its prompt, tools, servers and model', async () => {
    captured.length = 0
    const result = await new ClaudeProvider(() => undefined).runAgent(
      { agent: dev, prompt: 'Haz pull', mcp: catalog as never, config: defaultConfig(), workspaceDir: '/ws', signal: new AbortController().signal },
      sink()
    )
    expect(result).toMatchObject({ text: 'hecho', failed: false })
    const o = captured[0]
    expect(o.systemPrompt).toBe('Eres Dev.')
    expect(o.agents).toBeUndefined()
    expect(o.tools).toEqual(['Read', 'Bash', 'PowerShell'])
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['notion'])
    expect(o.model).toBe('haiku')
    expect(o.disallowedTools).toEqual(['Agent', 'Task'])
    expect(o.allowedTools).not.toContain('Agent')
    expect(o.hooks).toBeUndefined()
  })

  it('Claude: a brain run hooks delegations when automations may need to run first', async () => {
    captured.length = 0
    const before = vi.fn(async () => undefined)
    await new ClaudeProvider(() => undefined).run(
      {
        prompt: 'hola',
        systemPrompt: 'Cerebro',
        agents: [dev],
        mcp: catalog as never,
        config: defaultConfig(),
        workspaceDir: '/ws',
        signal: new AbortController().signal
      },
      { ...sink(), beforeDelegation: before }
    )
    const matcher = captured[0].hooks?.PreToolUse?.[0]
    expect(matcher?.matcher).toBe('Agent|Task')
    const hook = matcher!.hooks[0]
    const signal = new AbortController().signal
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev' } } as never, 'x', { signal })
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } } as never, 'y', { signal })
    expect(before).toHaveBeenCalledTimes(1)
    expect(before).toHaveBeenCalledWith('dev')
  })

  it('Copilot: everything the main session says belongs to the agent', () => {
    const s = sink()
    const t = new CopilotTranslator(new Set(), s, 'dev')
    t.handle({ type: 'assistant.message', data: { content: 'Hecho el pull.' } })
    t.handle({ type: 'assistant.usage', data: { inputTokens: 3, outputTokens: 1 } })
    expect(t.finalText).toBe('Hecho el pull.')
    expect(s.texts).toEqual([['dev', 'Hecho el pull.']])
    expect(t.totals()).toEqual({ dev: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 } })
    expect(t.ownerOf('cualquiera')).toBe('dev')
  })
})
