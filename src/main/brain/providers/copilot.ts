import {
  CopilotClient,
  type CopilotSession,
  type CreateSessionOptions,
  type CustomAgentConfig,
  type MCPServerConfig,
  type PermissionHandler
} from '@microsoft/copilot-sdk'
import { BRAIN_ID, type ProviderAuth, type TokenCount, type UsageLimit } from '@shared/types'
import { resolveModel, type AppConfig } from '../../config'
import { delegationGuide, tierModels } from './guide'
import type { McpServer } from '../../mcp'
import type { AgentRecord } from '../registry'
import { addCount, emptyCount } from '../usage'
import { fromCopilotTool, permissionToCanonical, toCopilotTools, type CopilotPermission } from './toolmap'
import type { BrainProvider, RunRequest, RunResult, RunSink } from './types'

const QUOTA_TIMEOUT_MS = 5000
const DENIED = 'El usuario no autorizó esta acción.'

export function toCopilotMcp(server: McpServer): MCPServerConfig {
  if (server.type !== 'stdio') return { type: server.type, url: server.url, headers: server.headers, tools: ['*'] }
  return {
    type: 'local',
    command: server.command,
    args: server.args,
    env: server.env,
    workingDirectory: server.cwd,
    tools: ['*']
  }
}

/** agent.md -> Copilot custom agent. */
export function toCopilotAgent(agent: AgentRecord, model: string | undefined): CustomAgentConfig {
  const { spec, info } = agent
  const config: CustomAgentConfig = {
    name: info.id,
    displayName: info.name,
    description: spec.description,
    prompt: spec.prompt,
    tools: toCopilotTools(spec.tools, spec.mcp) ?? null
  }
  if (model) config.model = model
  return config
}

/** The fields of a session event this app reads. */
export interface CopilotEvent {
  type: string
  /** Sub-agent instance; absent for the brain and session-level events. */
  agentId?: string
  data?: unknown
}

type Data = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Turns Copilot session events into the app's provider-neutral events.
 * Pure bookkeeping, no SDK calls, so it can be tested with plain objects.
 */
export class CopilotTranslator {
  /** delegation tool call id -> agent id */
  private jobs = new Map<string, string>()
  private ended = new Set<string>()
  /** delegations already matched to a sub-agent instance */
  private claimed = new Set<string>()
  /** sub-agent instance id -> agent id */
  private instances = new Map<string, string>()
  /** tool call id -> agent id that made it (for permission prompts) */
  private toolOwners = new Map<string, string>()
  private tokens: Record<string, TokenCount> = {}
  private streamId = ''
  private streamText = ''
  premium = 0
  finalText = ''
  error = ''

  constructor(
    private agentIds: ReadonlySet<string>,
    private sink: RunSink
  ) {}

  totals(): Record<string, TokenCount> {
    return this.tokens
  }

  ownerOf(toolCallId: string | undefined): string {
    return (toolCallId && this.toolOwners.get(toolCallId)) || BRAIN_ID
  }

  /**
   * Which agent sent an event. Sub-agent events carry an instance id; it is
   * matched to the delegation that started it (same id, or the oldest
   * delegation not yet matched).
   */
  private speaker(instance: string | undefined): string {
    if (!instance) return BRAIN_ID
    const known = this.instances.get(instance)
    if (known) return known
    let callId: string | undefined = this.jobs.has(instance) ? instance : undefined
    callId ??= [...this.jobs.keys()].find((id) => !this.ended.has(id) && !this.claimed.has(id))
    if (!callId) return BRAIN_ID
    this.claimed.add(callId)
    const agentId = this.jobs.get(callId) ?? BRAIN_ID
    this.instances.set(instance, agentId)
    return agentId
  }

  private startJob(callId: string, agentId: string, task: string): void {
    if (this.jobs.has(callId)) return
    this.jobs.set(callId, agentId)
    this.sink.delegationStart(callId, agentId, task)
  }

  private endJob(callId: string, ok: boolean): void {
    if (!this.jobs.has(callId) || this.ended.has(callId)) return
    this.ended.add(callId)
    this.sink.delegationEnd(callId, ok)
  }

  handle(event: CopilotEvent): void {
    const d = (event.data ?? {}) as Data
    switch (event.type) {
      case 'assistant.message_delta': {
        if (event.agentId) return
        const id = str(d.messageId)
        if (id !== this.streamId) {
          this.streamId = id
          this.streamText = ''
        }
        this.streamText += str(d.deltaContent)
        this.sink.textDelta(this.streamText)
        return
      }
      case 'assistant.message': {
        const content = str(d.content).trim()
        if (!content) return
        if (event.agentId) this.sink.agentText(this.speaker(event.agentId), content)
        else this.finalText = content
        return
      }
      case 'tool.execution_start': {
        const speaker = this.speaker(event.agentId)
        const callId = str(d.toolCallId)
        const args = (d.arguments && typeof d.arguments === 'object' ? d.arguments : {}) as Data
        this.toolOwners.set(callId, speaker)
        if (str(d.toolName) === 'task' && speaker === BRAIN_ID) {
          const target = str(args.agent_type)
          if (this.agentIds.has(target)) {
            this.startJob(callId, target, str(args.description))
            return
          }
        }
        const { tool, input } = fromCopilotTool(str(d.toolName), args, {
          server: str(d.mcpServerName) || undefined,
          tool: str(d.mcpToolName) || undefined
        })
        this.sink.toolStart(speaker, tool, input)
        return
      }
      case 'tool.execution_complete':
        this.endJob(str(d.toolCallId), d.success !== false)
        return
      case 'subagent.started': {
        const target = str(d.agentName)
        if (this.agentIds.has(target)) this.startJob(str(d.toolCallId), target, '')
        return
      }
      case 'subagent.completed':
        this.endJob(str(d.toolCallId), d.cancelled !== true)
        return
      case 'subagent.failed':
        this.endJob(str(d.toolCallId), false)
        return
      case 'assistant.usage': {
        const speaker = this.speaker(event.agentId)
        const count: TokenCount = {
          input: num(d.inputTokens),
          output: num(d.outputTokens),
          cacheRead: num(d.cacheReadTokens),
          cacheWrite: num(d.cacheWriteTokens)
        }
        this.tokens[speaker] = addCount(this.tokens[speaker] ?? emptyCount(), count)
        this.premium += num(d.cost)
        return
      }
      case 'session.error':
        this.error = str(d.message) || 'error desconocido'
        return
      default:
        return
    }
  }
}

/** Monthly premium-request quota as a usage limit. */
export function quotaToLimit(snapshot: {
  isUnlimitedEntitlement?: boolean
  remainingPercentage?: number
  entitlementRequests?: number
  usedRequests?: number
  resetDate?: string
}): { limits: UsageLimit[]; available: boolean } {
  if (snapshot.isUnlimitedEntitlement) return { limits: [], available: false }
  const percent = Math.min(100, Math.max(0, 100 - num(snapshot.remainingPercentage)))
  const resetsAt = snapshot.resetDate ? Date.parse(snapshot.resetDate) : NaN
  const used = num(snapshot.usedRequests)
  const total = num(snapshot.entitlementRequests)
  return {
    available: true,
    limits: [
      {
        id: 'premium',
        label: total ? `Premium requests del mes (${Math.round(used)} de ${total})` : 'Premium requests del mes',
        percent,
        ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
      }
    ]
  }
}

export class CopilotProvider implements BrainProvider {
  readonly id = 'copilot' as const
  delegationText(config: AppConfig): string {
    return delegationGuide('task', 'agent_type', tierModels(config, 'copilot'))
  }

  private client?: Promise<CopilotClient>

  private getClient(): Promise<CopilotClient> {
    if (!this.client) {
      const starting = (async () => {
        const client = new CopilotClient({ mode: 'coding-agent' })
        await client.start()
        return client
      })()
      // A failed start is retried on the next call.
      starting.catch(() => {
        if (this.client === starting) this.client = undefined
      })
      this.client = starting
    }
    return this.client
  }

  async auth(): Promise<ProviderAuth> {
    try {
      const status = await (await this.getClient()).getAuthStatus()
      if (status.isAuthenticated) {
        return { provider: this.id, ready: true, detail: status.login ? `Conectado como ${status.login}.` : 'Conectado.' }
      }
      return {
        provider: this.id,
        ready: false,
        detail:
          'No hay sesión de GitHub. Instala GitHub CLI y ejecuta `gh auth login` con la cuenta que tiene Copilot Business (o define GH_TOKEN), y vuelve a comprobar.'
      }
    } catch (err) {
      return { provider: this.id, ready: false, detail: `No pude arrancar Copilot: ${(err as Error).message}` }
    }
  }

  async run(req: RunRequest, sink: RunSink): Promise<RunResult> {
    const translator = new CopilotTranslator(new Set(req.agents.map((a) => a.info.id)), sink)
    let session: CopilotSession | undefined
    let text = ''
    let failed = false
    try {
      const client = await this.getClient()
      const onRequest: PermissionHandler = async (request) => {
        const r = request as unknown as CopilotPermission
        const { tool, input } = permissionToCanonical(r)
        const allowed = await sink.authorize(translator.ownerOf(r.toolCallId), tool, input, req.signal)
        return allowed ? { kind: 'approve-once' } : { kind: 'reject', feedback: DENIED }
      }
      const options: CreateSessionOptions = {
        workingDirectory: req.workspaceDir,
        // Do not pick up the user's own Copilot instructions, agents or MCP config.
        enableConfigDiscovery: false,
        systemMessage: { mode: 'append', content: req.systemPrompt },
        agents: {
          definitions: req.agents.map((a) => toCopilotAgent(a, resolveModel(req.config, 'copilot', a.spec.model))),
          includedBuiltinAgents: []
        },
        mcp: { servers: Object.fromEntries(Object.entries(req.mcp.servers).map(([n, s]) => [n, toCopilotMcp(s)])) },
        permissions: { onRequest },
        events: { streaming: true, onEvent: (event) => translator.handle(event as CopilotEvent) }
      }
      const model = req.config.models.copilot.brain
      if (model) options.model = model

      session = req.resumeId
        ? await client.resumeSession(req.resumeId, options).catch(() => client.createSession(options))
        : await client.createSession(options)
      sink.sessionId(session.sessionId)

      const active = session
      const finished = new Promise<void>((resolve) => {
        const off = active.on((event) => {
          if (event.type === 'session.idle' || event.type === 'session.error') {
            off()
            resolve()
          }
        })
        req.signal.addEventListener(
          'abort',
          () => {
            void active.abort().catch(() => undefined)
            off()
            resolve()
          },
          { once: true }
        )
      })
      await active.send({ prompt: req.prompt })
      await finished

      if (req.signal.aborted) {
        failed = true
        text = 'Detenido.'
      } else if (translator.error) {
        failed = true
        text = `Error: ${translator.error}`
      } else {
        text = translator.finalText
      }
      await this.readQuota(client, sink)
    } catch (err) {
      failed = true
      text = req.signal.aborted ? 'Detenido.' : `Error: ${(err as Error).message}`
    } finally {
      await session?.disconnect().catch(() => undefined)
    }
    return {
      text,
      failed,
      tokens: translator.totals(),
      sessionId: session?.sessionId,
      premiumRequests: translator.premium
    }
  }

  /** Reads the premium-request quota; never fails the run. */
  private async readQuota(client: CopilotClient, sink: RunSink): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        client.rpc.account.getQuota({}),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), QUOTA_TIMEOUT_MS)
        })
      ])
      const snapshot = result?.quotaSnapshots?.premium_interactions
      if (!snapshot) return
      const { limits, available } = quotaToLimit(snapshot)
      sink.limits(limits, available, 'Copilot')
    } catch {
      // Experimental call; the panel keeps the last values.
    } finally {
      clearTimeout(timer)
    }
  }

  async dispose(): Promise<void> {
    const client = await this.client?.catch(() => undefined)
    this.client = undefined
    await client?.stop().catch(() => undefined)
  }
}
