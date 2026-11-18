import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import matter from 'gray-matter'
import { query, type McpServerConfig, type Options, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { BRAIN_ID, type AgentState, type ChatMessage, type ThoughtEvent, type UsageSnapshot } from '@shared/types'
import { rosterText, type AgentRecord } from './registry'
import { decide, type PermissionGate } from './permissions'
import type { SessionStore } from './sessions'
import { firstSentence, permissionSummary, thoughtForTool, truncate } from './thoughts'
import { RunMeter, type ApiUsage, type PlanUsage, type UsageStore } from './usage'

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
  getAgents(): AgentRecord[]
  getApiKey(): string | undefined
  /** Built-in tool servers, by name. */
  mcpServers: Record<string, McpServerConfig>
  /** Full names of built-in tools that never need César's approval. */
  trustedTools: ReadonlySet<string>
  usage: UsageStore
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

const DELEGATION_TOOLS = new Set(['Agent', 'Task'])
const IDLE_DELAY_MS = 3000
const LIMITS_TIMEOUT_MS = 5000
const MAIN_STREAM = 'main'

async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

export class BrainOrchestrator {
  private abort?: AbortController
  /** tool_use id of a delegation call -> agent id doing that job */
  private jobs = new Map<string, string>()
  /** tool_use id of any tool call -> agent id that made it (for permission prompts) */
  private toolOwners = new Map<string, string>()
  private idleTimers = new Map<string, NodeJS.Timeout>()
  private active = new Set<string>()
  private meter = new RunMeter()
  private current?: Query
  private cost?: { sessionId: string; totalUsd: number }
  private resumed = false

  constructor(
    private config: BrainConfig,
    private sessions: SessionStore,
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

  async run(prompt: string, filePaths: string[]): Promise<void> {
    if (this.busy) throw new Error('El Cerebro ya está trabajando')
    const abort = new AbortController()
    this.abort = abort
    this.events.busy(true)

    const files = filePaths.map((p) => relative(this.config.workspaceDir, p).replace(/\\/g, '/'))
    const userMessage: ChatMessage = { role: 'user', text: prompt, files, ts: Date.now() }
    await this.sessions.add(userMessage)
    this.events.message(userMessage)
    this.think(BRAIN_ID, 'thinking', 'Déjame pensar…')

    let finalText = ''
    let failed = false
    this.meter = new RunMeter()
    this.cost = undefined
    try {
      const options = await this.buildOptions(abort)
      const fullPrompt = files.length
        ? `${prompt}\n\nArchivos adjuntos (rutas relativas al directorio de trabajo):\n${files
            .map((f) => `- ${f}`)
            .join('\n')}`
        : prompt

      const running = query({ prompt: fullPrompt, options })
      this.current = running
      for await (const message of running) {
        const result = await this.handle(message)
        if (result) {
          finalText = result.text
          failed = result.failed
        }
      }
    } catch (err) {
      failed = true
      finalText = abort.signal.aborted ? 'Detenido.' : `Error: ${(err as Error).message}`
    } finally {
      this.abort = undefined
      this.current = undefined
      this.jobs.clear()
      this.toolOwners.clear()
    }

    try {
      // Set while handling the result message; the compiler cannot see that from here.
      const cost = this.cost as { sessionId: string; totalUsd: number } | undefined
      await this.config.usage.recordRun(this.meter.totals(), cost?.sessionId, cost?.totalUsd, this.resumed)
      this.events.usage(this.config.usage.snapshot())
    } catch (err) {
      console.warn('[uso]', err)
    }

    for (const id of [...this.active]) {
      if (id !== BRAIN_ID) this.think(id, 'idle', '')
    }
    this.think(BRAIN_ID, failed ? 'error' : 'done', failed ? 'Algo salió mal' : '¡Listo!')
    this.scheduleIdle(BRAIN_ID)

    const reply: ChatMessage = {
      role: 'brain',
      text: finalText || '(sin respuesta)',
      error: failed,
      ts: Date.now()
    }
    await this.sessions.add(reply)
    this.events.message(reply)
    this.events.busy(false)
  }

  private async buildOptions(abort: AbortController): Promise<Options> {
    const agents = this.config.getAgents()
    const brainFile = matter(await readOptional(this.config.brainPromptFile))
    const memory = (await readOptional(this.config.memoryFile)).trim()
    const systemPrompt = brainFile.content
      .replace('{{ROSTER}}', rosterText(agents))
      .replace('{{MEMORY}}', memory || '(vacía)')
      .trim()

    const env: Record<string, string | undefined> = { ...process.env }
    const apiKey = this.config.getApiKey()
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey

    const options: Options = {
      abortController: abort,
      cwd: this.config.workspaceDir,
      systemPrompt,
      agents: Object.fromEntries(agents.map((a) => [a.info.id, a.definition])),
      mcpServers: this.config.mcpServers,
      allowedTools: ['Agent', 'WebSearch', 'WebFetch', ...this.config.trustedTools],
      // Do not inherit the user's Claude Code settings, hooks or plugins.
      settingSources: [],
      includePartialMessages: true,
      forwardSubagentText: true,
      env,
      canUseTool: async (toolName, input, ctx) => {
        if (decide(toolName, input, this.config.workspaceDir, this.config.trustedTools) === 'allow') {
          return { behavior: 'allow', updatedInput: input }
        }
        const agentId = this.toolOwners.get(ctx.toolUseID) ?? BRAIN_ID
        const summary = permissionSummary(toolName, input)
        this.think(agentId, 'asking', truncate(`¿Puedo? ${summary}`))
        const allowed = await this.gate.ask(agentId, toolName, summary, ctx.signal)
        this.think(agentId, 'working', allowed ? 'Gracias, sigo…' : 'Entendido, no lo hago')
        return allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'El usuario no autorizó esta acción.' }
      }
    }
    const model = (brainFile.data as Record<string, unknown> | null)?.model
    if (typeof model === 'string' && model.trim()) options.model = model.trim()
    this.resumed = Boolean(this.sessions.sessionId)
    if (this.sessions.sessionId) options.resume = this.sessions.sessionId
    return options
  }

  private streamText = ''

  private async handle(msg: SDKMessage): Promise<{ text: string; failed: boolean } | undefined> {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          await this.sessions.setSessionId(msg.session_id)
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
          this.events.delta(this.streamText)
        }
        return undefined
      }

      case 'assistant': {
        const speaker = this.speakerOf(msg.parent_tool_use_id)
        this.meter.message(speaker, msg.message.id, msg.message.usage as ApiUsage)
        const blocks = msg.message.content as Array<{ type: string; text?: string }>
        for (const block of blocks) {
          if (block.type === 'text' && block.text && speaker !== BRAIN_ID) {
            const sentence = firstSentence(block.text)
            if (sentence) this.think(speaker, 'working', sentence)
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
          if (block.type !== 'tool_result') continue
          const agentId = this.jobs.get(block.tool_use_id)
          if (!agentId) continue
          this.jobs.delete(block.tool_use_id)
          // An agent may hold several jobs at once; only finish on the last one.
          if (![...this.jobs.values()].includes(agentId)) {
            this.think(agentId, block.is_error ? 'error' : 'done', block.is_error ? 'No pude…' : '¡Listo!')
            this.scheduleIdle(agentId)
          }
          this.think(BRAIN_ID, 'thinking', 'Reviso lo que me entregaron…')
        }
        return undefined
      }

      case 'result':
        this.cost = { sessionId: msg.session_id, totalUsd: msg.total_cost_usd }
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
      await this.config.usage.setPlan(plan as PlanUsage)
      this.events.usage(this.config.usage.snapshot())
    } catch {
      // The call is experimental; without it the panel just keeps the last values.
    } finally {
      clearTimeout(timer)
    }
  }

  private onToolUse(speaker: string, block: ToolUseBlock): void {
    this.toolOwners.set(block.id, speaker)
    if (speaker === BRAIN_ID && DELEGATION_TOOLS.has(block.name)) {
      const target = String(block.input.subagent_type ?? '')
      const agent = this.config.getAgents().find((a) => a.info.id === target)
      if (!agent) {
        this.think(BRAIN_ID, 'working', 'Delegando una tarea…')
        return
      }
      this.jobs.set(block.id, agent.info.id)
      this.think(BRAIN_ID, 'working', truncate(`Esto es para ${agent.info.name}…`))
      const task = String(block.input.description ?? '')
      this.think(agent.info.id, 'thinking', truncate(task ? `Encargo: ${task}` : 'Recibí un encargo'))
      return
    }
    this.think(speaker, 'working', thoughtForTool(block.name, block.input))
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
