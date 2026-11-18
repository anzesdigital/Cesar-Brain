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

export interface AppStatus {
  hasApiKey: boolean
  busy: boolean
  workspaceDir: string
  agentsDir: string
  google: { connected: boolean; email?: string; spreadsheetId?: string }
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
  /** Tokens per agent id (the brain included). */
  agents: Record<string, TokenCount>
}

/** One plan limit window, as the Claude account reports it. */
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
  /** Tests and saves the Google Sheets connection; resolves with the sheet titles found. */
  connectGoogle(keyJson: string, sheetUrl: string): Promise<string[]>
  disconnectGoogle(): Promise<void>
  respondPermission(id: string, allow: boolean): Promise<void>
  openPath(path: string): Promise<void>
  pathForFile(file: File): string
  onAgents(cb: (agents: AgentInfo[]) => void): () => void
  onThought(cb: (t: ThoughtEvent) => void): () => void
  onDelta(cb: (text: string) => void): () => void
  onMessage(cb: (m: ChatMessage) => void): () => void
  onBusy(cb: (busy: boolean) => void): () => void
  onPermission(cb: (p: PermissionRequest) => void): () => void
}
