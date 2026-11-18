import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  query,
  type AgentDefinition,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import { BRAIN_ID, type ProviderAuth } from '@shared/types'
import { resolveModel, type AppConfig } from '../../config'
import { delegationGuide, tierModels } from './guide'
import type { McpServer } from '../../mcp'
import type { AgentRecord } from '../registry'
import { limitsFromPlan, RunMeter, type ApiUsage, type PlanUsage } from '../usage'
import type { BrainProvider, RunRequest, RunResult, RunSink } from './types'

const DELEGATION_TOOLS = new Set(['Agent', 'Task'])
/** Values the Agent tool's `model` field accepts. */
const CLAUDE_TOOL_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable'])
const LIMITS_TIMEOUT_MS = 5000
const MAIN_STREAM = 'main'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export function toClaudeMcp(server: McpServer): McpServerConfig {
  if (server.type === 'stdio') return { type: 'stdio', command: server.command, args: server.args, env: server.env }
  return { type: server.type, url: server.url, headers: server.headers }
}

/** agent.md -> Claude Agent SDK definition. */
export function toClaudeAgent(agent: AgentRecord, model: string | undefined): AgentDefinition {
  const { spec } = agent
  const definition: AgentDefinition = { description: spec.description, prompt: spec.prompt }
  if (spec.tools) {
    const tools = spec.tools.flatMap((t) => (t === 'Bash' ? ['Bash', 'PowerShell'] : [t]))
    // `mcp__server` stands for every tool of that server.
    definition.tools = [...tools, ...spec.mcp.map((s) => `mcp__${s}`)]
  }
  if (spec.mcp.length) definition.mcpServers = spec.mcp
  if (model) definition.model = model
  return definition
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** One run of the Claude Agent SDK; holds the per-run bookkeeping. */
class ClaudeRun {
  private jobs = new Map<string, string>()
  private toolOwners = new Map<string, string>()
  private meter = new RunMeter()
  private streamText = ''
  private current?: Query
  private sessionId?: string
  private cost?: number

  constructor(
    private req: RunRequest,
    private sink: RunSink,
    private apiKey: string | undefined
  ) {}

  async execute(): Promise<RunResult> {
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    this.req.signal.addEventListener('abort', onAbort, { once: true })
    let text = ''
    let failed = false
    try {
      const running = query({ prompt: this.req.prompt, options: this.options(abort) })
      this.current = running
      for await (const message of running) {
        const result = await this.handle(message)
        if (result) {
          text = result.text
          failed = result.failed
        }
      }
    } catch (err) {
      failed = true
      text = this.req.signal.aborted ? 'Detenido.' : `Error: ${(err as Error).message}`
    } finally {
      this.req.signal.removeEventListener('abort', onAbort)
      this.current = undefined
    }
    return { text, failed, tokens: this.meter.totals(), sessionId: this.sessionId, sessionCostUsd: this.cost }
  }

  private options(abort: AbortController): Options {
    const { req } = this
    const env: Record<string, string | undefined> = { ...process.env }
    if (this.apiKey) env.ANTHROPIC_API_KEY = this.apiKey
    // Otherwise the SDK may launch agents in the background and the brain
    // answers before they finish.
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
    const trusted = [...[...req.mcp.trusted].map((s) => `mcp__${s}`), ...req.mcp.trustedTools]

    const options: Options = {
      abortController: abort,
      cwd: req.workspaceDir,
      systemPrompt: req.systemPrompt,
      agents: Object.fromEntries(
        req.agents.map((a) => [a.info.id, toClaudeAgent(a, resolveModel(req.config, 'claude', a.spec.model))])
      ),
      mcpServers: Object.fromEntries(Object.entries(req.mcp.servers).map(([name, s]) => [name, toClaudeMcp(s)])),
      allowedTools: ['Agent', 'WebSearch', 'WebFetch', ...trusted],
      // Do not inherit the user's Claude Code settings, hooks or plugins.
      settingSources: [],
      includePartialMessages: true,
      forwardSubagentText: true,
      env,
      canUseTool: async (toolName, input, ctx) => {
        const agentId = this.toolOwners.get(ctx.toolUseID) ?? BRAIN_ID
        const allowed = await this.sink.authorize(agentId, toolName, input, ctx.signal)
        return allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'El usuario no autorizó esta acción.' }
      }
    }
    const model = req.config.models.claude.brain
    if (model) options.model = model
    if (req.resumeId) options.resume = req.resumeId
    return options
  }

  private async handle(msg: SDKMessage): Promise<{ text: string; failed: boolean } | undefined> {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id
          this.sink.sessionId(msg.session_id)
          void this.refreshLimits()
        }
        return undefined

      case 'rate_limit_event':
        void this.refreshLimits()
        return undefined

      case 'stream_event': {
        const event = msg.event as {
          type: string
          delta?: { type: string; text?: string }
          message?: { id: string; usage?: ApiUsage }
          usage?: ApiUsage
        }
        const streamKey = msg.parent_tool_use_id ?? MAIN_STREAM
        if (event.type === 'message_start' && event.message) {
          this.meter.start(streamKey, this.speakerOf(msg.parent_tool_use_id), event.message.id, event.message.usage)
        } else if (event.type === 'message_delta') {
          this.meter.delta(streamKey, event.usage)
        }
        if (msg.parent_tool_use_id) return undefined
        if (event.type === 'message_start') {
          this.streamText = ''
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          this.streamText += event.delta.text ?? ''
          this.sink.textDelta(this.streamText)
        }
        return undefined
      }

      case 'assistant': {
        const speaker = this.speakerOf(msg.parent_tool_use_id)
        this.meter.message(speaker, msg.message.id, msg.message.usage as ApiUsage)
        const blocks = msg.message.content as Array<{ type: string; text?: string }>
        for (const block of blocks) {
          if (block.type === 'text' && block.text && speaker !== BRAIN_ID) {
            this.sink.agentText(speaker, block.text)
          } else if (block.type === 'tool_use') {
            this.onToolUse(speaker, block as unknown as ToolUseBlock)
          }
        }
        return undefined
      }

      case 'user': {
        if (msg.parent_tool_use_id) return undefined
        const content = msg.message.content
        if (!Array.isArray(content)) return undefined
        for (const block of content) {
          if (block.type !== 'tool_result' || !this.jobs.has(block.tool_use_id)) continue
          this.jobs.delete(block.tool_use_id)
          this.sink.delegationEnd(block.tool_use_id, !block.is_error)
        }
        return undefined
      }

      case 'result':
        this.sessionId = msg.session_id
        this.cost = msg.total_cost_usd
        // Last chance to read the plan limits while the session is still open.
        await this.refreshLimits()
        if (msg.subtype === 'success') return { text: msg.result, failed: msg.is_error }
        return { text: `El Cerebro no pudo terminar (${msg.subtype}).`, failed: true }

      default:
        return undefined
    }
  }

  private speakerOf(parentToolUseId: string | null | undefined): string {
    return parentToolUseId ? (this.jobs.get(parentToolUseId) ?? BRAIN_ID) : BRAIN_ID
  }

  private onToolUse(speaker: string, block: ToolUseBlock): void {
    this.toolOwners.set(block.id, speaker)
    if (speaker === BRAIN_ID && DELEGATION_TOOLS.has(block.name)) {
      const target = String(block.input.subagent_type ?? '')
      if (this.req.agents.some((a) => a.info.id === target)) {
        this.jobs.set(block.id, target)
        this.sink.delegationStart(block.id, target, String(block.input.description ?? ''))
        return
      }
    }
    this.sink.toolStart(speaker, block.name, block.input)
  }

  /** Reads the plan's limit windows from the running session; never fails the run. */
  private async refreshLimits(): Promise<void> {
    const running = this.current
    if (!running) return
    let timer: NodeJS.Timeout | undefined
    try {
      const plan = await Promise.race([
        running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), LIMITS_TIMEOUT_MS)
        })
      ])
      if (!plan) return
      const p = plan as PlanUsage
      this.sink.limits(limitsFromPlan(p), p.rate_limits_available, p.subscription_type ?? undefined)
    } catch {
      // The call is experimental; without it the panel just keeps the last values.
    } finally {
      clearTimeout(timer)
    }
  }
}

export class ClaudeProvider implements BrainProvider {
  readonly id = 'claude' as const
  delegationText(config: AppConfig): string {
    return delegationGuide('Agent', 'subagent_type', tierModels(config, 'claude', CLAUDE_TOOL_MODELS))
  }

  constructor(private getApiKey: () => string | undefined) {}

  run(req: RunRequest, sink: RunSink): Promise<RunResult> {
    return new ClaudeRun(req, sink, this.getApiKey()).execute()
  }

  async auth(): Promise<ProviderAuth> {
    if (this.getApiKey()) return { provider: this.id, ready: true, detail: 'Usa la clave de API guardada en Ajustes.' }
    if (process.env.ANTHROPIC_API_KEY) return { provider: this.id, ready: true, detail: 'Usa ANTHROPIC_API_KEY del entorno.' }
    // On macOS the login lives in the keychain, so there is no file to check.
    if (process.platform === 'darwin' || (await exists(join(homedir(), '.claude', '.credentials.json')))) {
      return { provider: this.id, ready: true, detail: 'Usa la sesión de Claude Code de este equipo.' }
    }
    return {
      provider: this.id,
      ready: false,
      detail: 'No hay clave ni sesión. Pon una clave de API en Ajustes o inicia sesión con Claude Code (`claude` → /login).'
    }
  }
}
