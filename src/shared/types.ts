export const BRAIN_ID = 'cerebro'

export type AgentState = 'idle' | 'thinking' | 'working' | 'asking' | 'done' | 'error'

export interface SpriteSpec {
  hair: string
  shirt: string
  skin: string
}

/** What the UI needs to draw one person in the office. */
export interface AgentInfo {
  id: string
  name: string
  role: string
  description: string
  sprite: SpriteSpec
  /** Room of the office the agent sits in (agent.md `zona`). */
  zone: string
  /** Switched off by the user (config.json `disabledAgents`): the brain cannot use it. */
  disabled?: boolean
}

export interface ThoughtEvent {
  agentId: string
  state: AgentState
  /** Short bubble text (already truncated). Empty string clears the bubble. */
  text: string
  ts: number
}

export interface PermissionRequest {
  id: string
  agentId: string
  toolName: string
  summary: string
}

export interface ChatMessage {
  role: 'user' | 'brain'
  text: string
  files?: string[]
  error?: boolean
  /** Small remark shown above an answer (e.g. it was resumed from a summary). */
  note?: string
  ts: number
}

/** One saved conversation, as listed in the history. */
export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Messages in it. */
  count: number
}

/**
 * How an old conversation continues: `full` resumes the provider session
 * (the whole history is read again), `summary` starts a new session with the
 * last visible messages only (cheaper).
 */
export type ResumeMode = 'full' | 'summary'

/** The conversation the brain continues. */
export interface ConversationState {
  id: string
  /** Set while the next message will resume a conversation opened from the history. */
  resume?: {
    /** What the app would pick by itself. */
    auto: ResumeMode
    /** What the user picked instead, if anything. */
    forced?: ResumeMode
    /** Full resume is possible (there is a session for the current provider). */
    canFull: boolean
    /** Rough size of the history, in tokens. */
    tokens: number
  }
}

export interface IncomingFile {
  name: string
  /** Absolute path on disk when the file was dragged from the OS. */
  path?: string
  /** Raw bytes when there is no path (pasted image). */
  data?: ArrayBuffer
}

export type ProviderId = 'claude' | 'copilot'

export const PROVIDERS: Record<ProviderId, string> = {
  claude: 'Claude',
  copilot: 'GitHub Copilot'
}

export type SkinId = 'clasica' | 'ing'

/** Looks of the app, chosen in Ajustes or config.json `skin`. */
export const SKINS: Record<SkinId, string> = {
  clasica: 'Clásica',
  ing: 'ING'
}

/** Whether the chosen provider can run, and what to do if not. */
export interface ProviderAuth {
  provider: ProviderId
  ready: boolean
  /** Human sentence: who is signed in, or how to sign in. */
  detail: string
}

/** A code repository agents may work in, as shown in Ajustes. */
export interface RepoStatus {
  name: string
  path: string
  /** Read and write (true) or read only (false). */
  write: boolean
  /** The folder exists on this computer. */
  exists: boolean
}

export interface AppStatus {
  hasApiKey: boolean
  busy: boolean
  provider: ProviderId
  skin: SkinId
  homeDir: string
  workspaceDir: string
  agentsDir: string
  automationsDir: string
  /** Problems found while reading config.json, mcp.json or agent files. */
  problems: string[]
  repos: RepoStatus[]
  conversation: ConversationState
}

export interface TokenCount {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface UsageDay {
  /** Local day, YYYY-MM-DD. */
  date: string
  runs: number
  /** Estimated cost at list prices; not a bill. */
  costUsd: number
  /** Copilot premium requests spent (provider "copilot" only). */
  premiumRequests?: number
  /** Tokens per agent id (the brain included). */
  agents: Record<string, TokenCount>
}

/** One plan limit window, as the provider account reports it. */
export interface UsageLimit {
  id: string
  label: string
  /** 0–100 */
  percent: number
  resetsAt?: number
}

export interface UsageSnapshot {
  /** Oldest first; days without activity are absent. */
  days: UsageDay[]
  limits: UsageLimit[]
  /** When the limits were last read. */
  limitsAt?: number
  /** False when the account has no plan limits (API key). Undefined until first read. */
  limitsAvailable?: boolean
  plan?: string
  /** Provider the limits were read from. */
  limitsProvider?: ProviderId
}

/** Thought ids of automation robots in the office: `auto:<id>`. */
export const AUTOMATION_PREFIX = 'auto:'

export function robotId(automationId: string): string {
  return `${AUTOMATION_PREFIX}${automationId}`
}

/** What started an automation run. */
export type AutomationTrigger = 'intervalo' | 'manual' | 'arranque' | 'archivos' | 'agente'

export interface AutomationStepInfo {
  kind: 'comando' | 'agente'
  name: string
  /** Command line, or the agent's task. */
  detail: string
  /** Repo or folder a command runs in; agent id for agent steps. */
  where: string
}

/** One automation, as the UI shows it. */
export interface AutomationInfo {
  id: string
  name: string
  description: string
  /** Human-readable triggers ("cada 30 min", "al arrancar"…). */
  triggers: string[]
  steps: AutomationStepInfo[]
  /** Tools agent steps may use without asking. */
  allow: string[]
  onFailure: 'parar' | 'seguir'
  /** Body color of the robot. */
  color: string
  enabled: boolean
  /** The file changed since the user approved it (or it was never approved). */
  needsApproval: boolean
  running: boolean
  lastRun?: { ts: number; ok: boolean; ms: number }
  nextRunAt?: number
  /** Folder of its automation.md. */
  dir: string
}

export interface AutomationStepResult {
  name: string
  kind: 'comando' | 'agente'
  ok: boolean
  /** Output (truncated). */
  output: string
  ms: number
}

export interface AutomationRun {
  automationId: string
  trigger: AutomationTrigger
  /** e.g. agent id for an "agente" trigger, or changed file. */
  detail?: string
  startedAt: number
  endedAt: number
  ok: boolean
  /** Why it did not run or stopped early (not approved, stopped…). */
  note?: string
  steps: AutomationStepResult[]
}

export interface BrainApi {
  getAutomations(): Promise<AutomationInfo[]>
  onAutomations(cb: (list: AutomationInfo[]) => void): () => void
  /** Last runs of one automation, newest first. */
  getAutomationRuns(id: string): Promise<AutomationRun[]>
  onAutomationRun(cb: (run: AutomationRun) => void): () => void
  /** Approves the automation as it is written now and switches it on. */
  approveAutomation(id: string): Promise<void>
  setAutomationEnabled(id: string, enabled: boolean): Promise<void>
  runAutomation(id: string): Promise<void>
  stopAutomation(id: string): Promise<void>
  getUsage(): Promise<UsageSnapshot>
  onUsage(cb: (usage: UsageSnapshot) => void): () => void
  getAgents(): Promise<AgentInfo[]>
  getHistory(): Promise<ChatMessage[]>
  getStatus(): Promise<AppStatus>
  send(prompt: string, files: IncomingFile[]): Promise<void>
  stop(): Promise<void>
  newConversation(): Promise<void>
  setApiKey(key: string): Promise<void>
  /** Switches provider (saved in config.json); starts a new conversation. */
  setProvider(provider: ProviderId): Promise<void>
  setSkin(skin: SkinId): Promise<void>
  /** Checks sign-in for the current provider (may take a few seconds). */
  checkProvider(): Promise<ProviderAuth>
  /** Asks for a folder and adds it as a read-only repo; resolves with its name, or undefined if cancelled. */
  addRepo(): Promise<string | undefined>
  setRepoAccess(name: string, write: boolean): Promise<void>
  removeRepo(name: string): Promise<void>
  /** Saved conversations, newest first; `query` searches titles and messages. */
  listConversations(query?: string): Promise<ConversationMeta[]>
  /** Makes a saved conversation the active one and resolves with its messages. Costs no tokens. */
  openConversation(id: string): Promise<ChatMessage[]>
  renameConversation(id: string, title: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  /** Overrides how the next message resumes an old conversation; undefined = automatic. */
  setResumeMode(mode: ResumeMode | undefined): Promise<void>
  /** Switches an agent on or off (saved in config.json `disabledAgents`). */
  setAgentEnabled(id: string, enabled: boolean): Promise<void>
  respondPermission(id: string, allow: boolean): Promise<void>
  openPath(path: string): Promise<void>
  pathForFile(file: File): string
  onAgents(cb: (agents: AgentInfo[]) => void): () => void
  onStatus(cb: (status: AppStatus) => void): () => void
  /** The conversation was reset from the main process (e.g. provider switch). */
  onReset(cb: () => void): () => void
  onThought(cb: (t: ThoughtEvent) => void): () => void
  onDelta(cb: (text: string) => void): () => void
  onMessage(cb: (m: ChatMessage) => void): () => void
  onBusy(cb: (busy: boolean) => void): () => void
  onPermission(cb: (p: PermissionRequest) => void): () => void
}
