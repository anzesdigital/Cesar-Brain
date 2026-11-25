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
  /**
   * Last messages of the conversation (resume.ts summaryPreamble). Put in front
   * of the prompt when there is no `resumeId`, or when resuming it fails.
   */
  history?: string
  signal: AbortSignal
}

/** Runs one agent on its own, without the brain (automation steps). */
export interface AgentRunRequest {
  agent: AgentRecord
  /** The task for the agent. */
  prompt: string
  mcp: McpCatalog
  config: AppConfig
  workspaceDir: string
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
  /** Called before the brain hands a job to an agent; the job waits for it (automations). */
  beforeDelegation?(agentId: string): Promise<void>
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
  /** `resumeId` could not be resumed, so the run started fresh with `history`. */
  resumeLost?: boolean
}

export interface BrainProvider {
  readonly id: ProviderId
  /** Fills {{DELEGATION}} in brain.md: how to hand work to an agent and which model to ask for. */
  delegationText(config: AppConfig): string
  run(req: RunRequest, sink: RunSink): Promise<RunResult>
  /** Runs `req.agent` as the main session: its prompt, tools, MCP servers and model; no delegation. */
  runAgent(req: AgentRunRequest, sink: RunSink): Promise<RunResult>
  auth(): Promise<ProviderAuth>
  dispose?(): Promise<void>
}
