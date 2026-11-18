import type { ProviderAuth, ProviderId, TokenCount, UsageLimit } from '@shared/types'
import type { AppConfig } from '../../config'
import type { McpCatalog } from '../../mcp'
import type { AgentRecord } from '../registry'

export interface RunRequest {
  /** User prompt, attachments already listed. */
  prompt: string
  /** Brain prompt with roster, memory and delegation text filled in. */
  systemPrompt: string
  agents: AgentRecord[]
  mcp: McpCatalog
  config: AppConfig
  workspaceDir: string
  /** Provider session to continue, if any. */
  resumeId?: string
  signal: AbortSignal
}

/**
 * What a provider reports while it runs. Tool names are canonical
 * (Read, Write, Bash, mcp__srv__tool…) whatever the provider calls them.
 */
/** Message for the agent when a tool call is not allowed. */
export function denialMessage(result: boolean | string): string {
  return typeof result === 'string' ? result : 'El usuario no autorizó esta acción.'
}

export interface RunSink {
  sessionId(id: string): void
  /** Brain's answer so far (whole text, not a chunk). */
  textDelta(text: string): void
  /** Something an agent said while working. */
  agentText(agentId: string, text: string): void
  toolStart(agentId: string, tool: string, input: Record<string, unknown>): void
  delegationStart(callId: string, agentId: string, task: string): void
  delegationEnd(callId: string, ok: boolean): void
  limits(limits: UsageLimit[], available: boolean, plan?: string): void
  /**
   * Applies the permission policy and asks the user when needed.
   * true = go ahead; false = the user said no; a string = refused, with the reason for the agent.
   */
  authorize(agentId: string, tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<boolean | string>
}

export interface RunResult {
  text: string
  failed: boolean
  /** Tokens per agent id (the brain included). */
  tokens: Record<string, TokenCount>
  sessionId?: string
  /** Running cost of the whole session (Claude). */
  sessionCostUsd?: number
  /** Premium requests spent by this run (Copilot). */
  premiumRequests?: number
}

export interface BrainProvider {
  readonly id: ProviderId
  /** Fills {{DELEGATION}} in brain.md: how to hand work to an agent and which model to ask for. */
  delegationText(config: AppConfig): string
  run(req: RunRequest, sink: RunSink): Promise<RunResult>
  auth(): Promise<ProviderAuth>
  dispose?(): Promise<void>
}
