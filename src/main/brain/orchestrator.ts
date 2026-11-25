import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import matter from 'gray-matter'
import {
  BRAIN_ID,
  type AgentState,
  type ChatMessage,
  type ConversationState,
  type PermissionRule,
  type ResumeMode,
  type ThoughtEvent,
  type UsageSnapshot
} from '@shared/types'
import type { AppConfig } from '../config'
import type { McpCatalog } from '../mcp'
import { brainReposText } from '../repos'
import { fillPlaceholders, rosterText, type AgentRecord } from './registry'
import { decide, type PermissionGate } from './permissions'
import { matchRule, resolvePermission, suggestRule } from './rules'
import type { BrainProvider, RunResult, RunSink } from './providers/types'
import { chooseResumeMode, estimateTokens, summaryPreamble } from './resume'
import type { ConversationStore } from './sessions'
import { render, templateFor } from './bubbles'
import { firstSentence, permissionSummary, thoughtForTool, truncate } from './thoughts'
import type { UsageStore } from './usage'

export interface BrainEvents {
  thought(event: ThoughtEvent): void
  delta(text: string): void
  message(message: ChatMessage): void
  busy(busy: boolean): void
  usage(usage: UsageSnapshot): void
}

export interface BrainConfig {
  workspaceDir: string
  brainPromptFile: string
  memoryFile: string
  /** Folders agents may read without asking (agents folder). */
  readableDirs: string[]
  getAgents(): AgentRecord[]
  getMcp(): McpCatalog
  getConfig(): AppConfig
  getProvider(): BrainProvider
  usage: UsageStore
  /** Automations to run (and wait for) before an agent gets a job. */
  beforeDelegation?(agentId: string): Promise<void>
  /** Saves a rule from "Permitir siempre" in config.json. */
  addAllowRule?(rule: PermissionRule): Promise<void>
}

const IDLE_DELAY_MS = 3000

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/** Builds the brain's system prompt from brain.md. */
export function brainPrompt(
  template: string,
  values: { roster: string; memory: string; user: string; delegation: string; repos?: string }
): string {
  return fillPlaceholders(matter(template).content, {
    ROSTER: values.roster,
    MEMORY: values.memory || '(vacía)',
    USER: values.user || 'el usuario',
    DELEGATION: values.delegation,
    REPOS: values.repos ?? '(Ninguno configurado.)'
  }).trim()
}

export class BrainOrchestrator {
  private abort?: AbortController
  /** delegation call id -> agent id doing that job */
  private jobs = new Map<string, string>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  private active = new Set<string>()
  /** "Permitir en esta conversación" rules, by conversation id. */
  private sessionRules = new Map<string, PermissionRule[]>()

  constructor(
    private config: BrainConfig,
    private sessions: ConversationStore,
    private gate: PermissionGate,
    private events: BrainEvents
  ) {}

  get busy(): boolean {
    return this.abort !== undefined
  }

  stop(): void {
    this.abort?.abort()
    this.gate.denyAll()
  }

  /** The active conversation and, if it was just reopened, how it will resume. */
  conversationState(): ConversationState {
    const state: ConversationState = { id: this.sessions.id }
    if (!this.sessions.resumePending) return state
    const canFull = Boolean(this.sessions.sessionId(this.config.getProvider().id))
    const tokens = estimateTokens(this.sessions.messages)
    const auto = chooseResumeMode({ canFull, tokens, maxTokens: this.config.getConfig().resumeMaxTokens })
    const forced = this.sessions.forcedMode
    state.resume = { auto, canFull, tokens, ...(forced && forced !== auto ? { forced } : {}) }
    return state
  }

  /** How this run continues the conversation (decided before the new message is saved). */
  private resumePlan(providerId: BrainProvider['id']): { resumeId?: string; history?: string; mode?: ResumeMode } {
    const previous = this.sessions.messages
    if (!previous.length) return {}
    const sessionId = this.sessions.sessionId(providerId)
    const history = summaryPreamble(previous)
    let mode: ResumeMode = sessionId ? 'full' : 'summary'
    if (this.sessions.resumePending) {
      const resume = this.conversationState().resume
      mode = resume?.forced ?? resume?.auto ?? mode
      if (mode === 'full' && !sessionId) mode = 'summary'
    }
    // The summary also travels with a full resume, in case the session is gone.
    return mode === 'full' ? { resumeId: sessionId, history, mode } : { history, mode }
  }

  async run(prompt: string, filePaths: string[]): Promise<void> {
    if (this.busy) throw new Error('El Cerebro ya está trabajando')
    const abort = new AbortController()
    this.abort = abort
    this.events.busy(true)

    const provider = this.config.getProvider()
    const reopened = this.sessions.resumePending
    const plan = this.resumePlan(provider.id)

    const files =filePaths.map((p) => relative(this.config.workspaceDir, p).replace(/\\/g, '/'))
    const userMessage: ChatMessage = { role: 'user', text: prompt, files, ts: Date.now() }
    await this.sessions.add(userMessage)
    this.events.message(userMessage)
    this.think(BRAIN_ID, 'thinking', 'Déjame pensar…')

    const appConfig = this.config.getConfig()
    const allAgents = this.config.getAgents()
    // Switched-off agents are not given to the provider, so they cannot be called.
    const agents = allAgents.filter((a) => !a.info.disabled)
    const { resumeId, history } = plan
    let result: RunResult
    try {
      const template = await readOptional(this.config.brainPromptFile)
      const memory = (await readOptional(this.config.memoryFile)).replace(/<!--[\s\S]*?-->/g, '').trim()
      const fullPrompt = files.length
        ? `${prompt}\n\nArchivos adjuntos (rutas relativas al directorio de trabajo):\n${files.map((f) => `- ${f}`).join('\n')}`
        : prompt
      result = await provider.run(
        {
          prompt: fullPrompt,
          systemPrompt: brainPrompt(template, {
            roster: rosterText(allAgents),
            memory,
            user: appConfig.userName,
            delegation: provider.delegationText(appConfig),
            repos: brainReposText(appConfig.repos, Object.fromEntries(agents.map((a) => [a.info.id, a.spec.repos])))
          }),
          agents,
          mcp: this.config.getMcp(),
          config: appConfig,
          workspaceDir: this.config.workspaceDir,
          resumeId,
          history,
          signal: abort.signal
        },
        this.sink(provider.id)
      )
    } catch (err) {
      result = { text: `Error: ${(err as Error).message}`, failed: true, tokens: {} }
    } finally {
      this.abort = undefined
      this.jobs.clear()
    }

    try {
      await this.config.usage.recordRun(
        result.tokens,
        result.sessionId,
        result.sessionCostUsd,
        Boolean(resumeId),
        result.premiumRequests
      )
      this.events.usage(this.config.usage.snapshot())
    } catch (err) {
      console.warn('[uso]', err)
    }

    for (const id of [...this.active]) {
      if (id !== BRAIN_ID) this.think(id, 'idle', '')
    }
    const failed = result.failed
    this.think(BRAIN_ID, failed ? 'error' : 'done', failed ? 'Algo salió mal' : '¡Listo!')
    this.scheduleIdle(BRAIN_ID)

    const reply: ChatMessage = {
      role: 'brain',
      text: result.text || '(sin respuesta)',
      error: failed,
      ts: Date.now()
    }
    if (result.resumeLost) reply.note = 'Retomada con resumen: la sesión original ya no existe.'
    else if (reopened && plan.mode === 'summary') reply.note = 'Retomada con resumen de los últimos mensajes.'
    else if (reopened && plan.mode === 'full') reply.note = 'Retomada con el contexto completo.'
    await this.sessions.add(reply)
    this.events.message(reply)
    this.events.busy(false)
  }

  private sink(providerId: BrainProvider['id']): RunSink {
    const before = this.config.beforeDelegation
    return {
      ...(before ? { beforeDelegation: (agentId: string) => before(agentId) } : {}),
      sessionId: (id) => void this.sessions.setSessionId(providerId, id),
      textDelta: (text) => this.events.delta(text),
      agentText: (agentId, text) => {
        const sentence = firstSentence(text)
        if (sentence) this.think(agentId, 'working', sentence)
      },
      toolStart: (agentId, tool, input) => {
        const custom = templateFor(this.bubblesOf(agentId), tool)
        const text = custom ? truncate(render(custom, input)) : ''
        this.think(agentId, 'working', text || thoughtForTool(tool, input))
      },
      delegationStart: (callId, agentId, task) => {
        const agent = this.config.getAgents().find((a) => a.info.id === agentId)
        this.jobs.set(callId, agentId)
        this.think(BRAIN_ID, 'working', truncate(`Esto es para ${agent?.info.name ?? agentId}…`))
        const custom = this.bubblesOf(agentId)?._encargo
        const text = custom ? render(custom, { tarea: task }) : task ? `Encargo: ${task}` : 'Recibí un encargo'
        this.think(agentId, 'thinking', truncate(text))
      },
      delegationEnd: (callId, ok) => {
        const agentId = this.jobs.get(callId)
        if (!agentId) return
        this.jobs.delete(callId)
        // An agent may hold several jobs at once; only finish on the last one.
        if (![...this.jobs.values()].includes(agentId)) {
          const bubbles = this.bubblesOf(agentId)
          const text = ok ? (bubbles?._listo ?? '¡Listo!') : (bubbles?._error ?? 'No pude…')
          this.think(agentId, ok ? 'done' : 'error', truncate(text))
          this.scheduleIdle(agentId)
        }
        this.think(BRAIN_ID, 'thinking', 'Reviso lo que me entregaron…')
      },
      limits: (limits, available, plan) => {
        void this.config.usage
          .setLimits(providerId, limits, available, plan)
          .then(() => this.events.usage(this.config.usage.snapshot()))
          .catch((err) => console.warn('[uso]', err))
      },
      authorize: async (agentId, tool, input, signal) => {
        const repoLimit = agentId === BRAIN_ID ? undefined : this.agentOf(agentId)?.spec.repos
        const decision = decide(tool, input, {
          workspaceDir: this.config.workspaceDir,
          readableDirs: this.config.readableDirs,
          trustedServers: this.config.getMcp().trusted,
          trustedTools: this.config.getMcp().trustedTools,
          repos: this.config.getConfig().repos,
          allowedRepos: repoLimit ? new Set(repoLimit) : undefined
        })
        const workspaceDir = this.config.workspaceDir
        const conversationId = this.sessions.id
        const final = resolvePermission(decision, {
          agentId,
          tool,
          input,
          workspaceDir,
          settings: this.config.getConfig().permissions,
          session: this.sessionRules.get(conversationId)
        })
        if (final === 'allow') return true
        if (typeof final === 'object') {
          this.think(agentId, 'working', truncate(final.deny))
          return final.deny
        }
        const custom = templateFor(this.agentOf(agentId)?.spec.permissions, tool)
        const summary = (custom && render(custom, input, '\n')) || permissionSummary(tool, input)
        const suggestion = suggestRule(agentId, tool, input, workspaceDir)
        this.think(agentId, 'asking', truncate(`¿Puedo? ${summary}`))
        const answer = await this.gate.ask(agentId, tool, summary, signal, input, suggestion)
        this.think(agentId, 'working', answer.allow ? 'Gracias, sigo…' : 'Entendido, no lo hago')
        if (answer.allow && answer.remember) await this.remember(answer.remember, suggestion, conversationId)
        return answer.allow
      }
    }
  }

  /** Keeps a "this conversation" or "always" answer and lets matching waiting prompts through. */
  private async remember(
    remember: 'conversation' | { rule: PermissionRule },
    suggestion: PermissionRule,
    conversationId: string
  ): Promise<void> {
    const rule = remember === 'conversation' ? suggestion : remember.rule
    if (remember === 'conversation') {
      this.sessionRules.set(conversationId, [...(this.sessionRules.get(conversationId) ?? []), rule])
    } else {
      try {
        await this.config.addAllowRule?.(rule)
      } catch (err) {
        console.warn('[permisos]', err)
      }
    }
    this.gate.allowWhere((p) => matchRule(rule, p.agentId, p.toolName, p.input, this.config.workspaceDir))
  }

  private agentOf(agentId: string): AgentRecord | undefined {
    return this.config.getAgents().find((a) => a.info.id === agentId)
  }

  private bubblesOf(agentId: string): Record<string, string> | undefined {
    return this.agentOf(agentId)?.spec.bubbles
  }

  private think(agentId: string, state: AgentState, text: string): void {
    const timer = this.idleTimers.get(agentId)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(agentId)
    }
    if (state === 'idle') this.active.delete(agentId)
    else this.active.add(agentId)
    this.events.thought({ agentId, state, text, ts: Date.now() })
  }

  private scheduleIdle(agentId: string): void {
    this.idleTimers.set(
      agentId,
      setTimeout(() => this.think(agentId, 'idle', ''), IDLE_DELAY_MS)
    )
  }
}
