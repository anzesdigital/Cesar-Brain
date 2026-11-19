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
  ts: number
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
  /** Problems found while reading config.json, mcp.json or agent files. */
  problems: string[]
  repos: RepoStatus[]
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

export interface BrainApi {
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
