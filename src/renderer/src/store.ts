import { create } from 'zustand'
import type {
  AgentInfo,
  AppStatus,
  AutomationInfo,
  ChatMessage,
  PermissionRequest,
  ThoughtEvent,
  UsageSnapshot
} from '@shared/types'

const HISTORY_LIMIT = 50

interface State {
  agents: AgentInfo[]
  thoughts: Record<string, ThoughtEvent>
  history: Record<string, ThoughtEvent[]>
  messages: ChatMessage[]
  streamText: string
  busy: boolean
  permissions: PermissionRequest[]
  selectedAgent?: string
  status?: AppStatus
  usage?: UsageSnapshot
  automations: AutomationInfo[]
  /** Automations panel open; `automationFocus` is the one shown. */
  automationsOpen: boolean
  automationFocus?: string
  setAutomations(list: AutomationInfo[]): void
  openAutomations(id?: string): void
  closeAutomations(): void
  setUsage(usage: UsageSnapshot): void
  setAgents(agents: AgentInfo[]): void
  addThought(thought: ThoughtEvent): void
  setMessages(messages: ChatMessage[]): void
  addMessage(message: ChatMessage): void
  setStreamText(text: string): void
  setBusy(busy: boolean): void
  pushPermission(request: PermissionRequest): void
  shiftPermission(): void
  /** Removes a prompt the main process answered by itself. */
  dropPermission(id: string): void
  select(agentId?: string): void
  setStatus(status: AppStatus): void
  clearConversation(): void
  /** Shows a conversation opened from the history. */
  openConversation(messages: ChatMessage[]): void
}

export const useStore = create<State>((set) => ({
  agents: [],
  thoughts: {},
  history: {},
  messages: [],
  streamText: '',
  busy: false,
  permissions: [],
  automations: [],
  automationsOpen: false,
  setAutomations: (automations) => set({ automations }),
  openAutomations: (automationFocus) => set((s) => ({ automationsOpen: true, automationFocus: automationFocus ?? s.automationFocus })),
  closeAutomations: () => set({ automationsOpen: false }),
  setAgents: (agents) => set({ agents }),
  addThought: (thought) =>
    set((s) => {
      const previous = s.history[thought.agentId] ?? []
      const history = thought.text
        ? { ...s.history, [thought.agentId]: [...previous, thought].slice(-HISTORY_LIMIT) }
        : s.history
      return { thoughts: { ...s.thoughts, [thought.agentId]: thought }, history }
    }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) =>
    set((s) => ({
      messages: [...s.messages, message],
      streamText: message.role === 'brain' ? '' : s.streamText
    })),
  setStreamText: (streamText) => set({ streamText }),
  setBusy: (busy) => set((s) => ({ busy, permissions: busy ? s.permissions : [] })),
  pushPermission: (request) => set((s) => ({ permissions: [...s.permissions, request] })),
  shiftPermission: () => set((s) => ({ permissions: s.permissions.slice(1) })),
  dropPermission: (id) => set((s) => ({ permissions: s.permissions.filter((p) => p.id !== id) })),
  select: (selectedAgent) => set({ selectedAgent }),
  setStatus: (status) => set({ status }),
  setUsage: (usage) => set({ usage }),
  clearConversation: () => set({ messages: [], streamText: '', thoughts: {}, history: {} }),
  openConversation: (messages) => set({ messages, streamText: '', thoughts: {}, history: {} })
}))
