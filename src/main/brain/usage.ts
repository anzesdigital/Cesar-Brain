import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ProviderId, TokenCount, UsageDay, UsageLimit, UsageSnapshot } from '@shared/types'

const KEEP_DAYS = 90

/** Token fields as the API reports them on a message. */
export interface ApiUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function emptyCount(): TokenCount {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addCount(a: TokenCount, b: TokenCount): TokenCount {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Adds up the tokens of one run, per agent.
 *
 * The same API message is reported several times while it streams (once when
 * it starts, again as output grows, and once per content block), so counts are
 * kept per message id and only the highest value seen for each field is used.
 */
export class RunMeter {
  private messages = new Map<string, { agentId: string; count: TokenCount }>()
  /** stream key (main loop or a delegation id) -> message being streamed */
  private streaming = new Map<string, string>()

  start(streamKey: string, agentId: string, messageId: string, usage?: ApiUsage): void {
    this.streaming.set(streamKey, messageId)
    this.merge(agentId, messageId, usage)
  }

  delta(streamKey: string, usage?: ApiUsage): void {
    const messageId = this.streaming.get(streamKey)
    const entry = messageId ? this.messages.get(messageId) : undefined
    if (messageId && entry) this.merge(entry.agentId, messageId, usage)
  }

  message(agentId: string, messageId: string, usage?: ApiUsage): void {
    this.merge(agentId, messageId, usage)
  }

  totals(): Record<string, TokenCount> {
    const out: Record<string, TokenCount> = {}
    for (const { agentId, count } of this.messages.values()) {
      out[agentId] = addCount(out[agentId] ?? emptyCount(), count)
    }
    return out
  }

  private merge(agentId: string, messageId: string, usage?: ApiUsage): void {
    if (!messageId || !usage) return
    const entry = this.messages.get(messageId) ?? { agentId, count: emptyCount() }
    const c = entry.count
    c.input = Math.max(c.input, usage.input_tokens ?? 0)
    c.output = Math.max(c.output, usage.output_tokens ?? 0)
    c.cacheRead = Math.max(c.cacheRead, usage.cache_read_input_tokens ?? 0)
    c.cacheWrite = Math.max(c.cacheWrite, usage.cache_creation_input_tokens ?? 0)
    this.messages.set(messageId, entry)
  }
}

interface LimitWindow {
  utilization: number | null
  resets_at: string | null
}

/** The part of the SDK's usage answer this app reads. */
export interface PlanUsage {
  subscription_type: string | null
  rate_limits_available: boolean
  rate_limits: {
    five_hour?: LimitWindow | null
    seven_day?: LimitWindow | null
    seven_day_opus?: LimitWindow | null
    seven_day_sonnet?: LimitWindow | null
    model_scoped?: Array<LimitWindow & { display_name: string }>
  } | null
}

function toLimit(id: string, label: string, window?: LimitWindow | null): UsageLimit[] {
  if (!window || typeof window.utilization !== 'number') return []
  const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN
  return [
    {
      id,
      label,
      percent: Math.min(100, Math.max(0, window.utilization)),
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {})
    }
  ]
}

export function limitsFromPlan(plan: PlanUsage): UsageLimit[] {
  const r = plan.rate_limits
  if (!r) return []
  const scoped = (r.model_scoped ?? []).flatMap((m) =>
    toLimit(`model:${m.display_name}`, `Semana · ${m.display_name}`, m)
  )
  return [
    ...toLimit('five_hour', 'Sesión (5 horas)', r.five_hour),
    ...toLimit('seven_day', 'Semana', r.seven_day),
    // Older accounts report per-model weeks as fixed fields instead of a list.
    ...(scoped.length
      ? scoped
      : [
          ...toLimit('seven_day_opus', 'Semana · Opus', r.seven_day_opus),
          ...toLimit('seven_day_sonnet', 'Semana · Sonnet', r.seven_day_sonnet)
        ])
  ]
}

interface UsageData {
  days: Record<string, UsageDay>
  limits: UsageLimit[]
  limitsAt?: number
  limitsAvailable?: boolean
  plan?: string
  limitsProvider?: ProviderId
  /** Running cost total last reported for a session, to charge each run only its own part. */
  session?: { id: string; costUsd: number }
}

/** Usage history kept on disk: tokens per agent per day, plus the last known plan limits. */
export class UsageStore {
  private data: UsageData = { days: {}, limits: [] }

  constructor(
    private file: string,
    private now: () => Date = () => new Date()
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<UsageData>
      this.data = { ...parsed, days: parsed.days ?? {}, limits: parsed.limits ?? [] }
    } catch {
      this.data = { days: {}, limits: [] }
    }
  }

  snapshot(): UsageSnapshot {
    const { limits, limitsAt, limitsAvailable, plan, limitsProvider } = this.data
    const days = Object.values(this.data.days).sort((a, b) => a.date.localeCompare(b.date))
    return { days, limits, limitsAt, limitsAvailable, plan, limitsProvider }
  }

  /**
   * Records one finished run. `sessionCostUsd` is the session's running total
   * as the SDK reports it; only what was added since the previous run counts.
   * A resumed session with no earlier total on record cannot be split, so that
   * run sets the starting point and is charged nothing.
   * `premiumRequests` is what this run alone spent (Copilot).
   */
  async recordRun(
    agents: Record<string, TokenCount>,
    sessionId?: string,
    sessionCostUsd?: number,
    resumed = false,
    premiumRequests?: number
  ): Promise<void> {
    const date = dayKey(this.now())
    const day = this.data.days[date] ?? { date, runs: 0, costUsd: 0, agents: {} }
    day.runs += 1
    if (typeof premiumRequests === 'number' && premiumRequests > 0) {
      day.premiumRequests = (day.premiumRequests ?? 0) + premiumRequests
    }
    for (const [agentId, count] of Object.entries(agents)) {
      day.agents[agentId] = addCount(day.agents[agentId] ?? emptyCount(), count)
    }
    if (typeof sessionCostUsd === 'number' && sessionCostUsd >= 0) {
      const previous = this.data.session
      const known = previous !== undefined && previous.id === sessionId && previous.costUsd <= sessionCostUsd
      const before = known ? previous.costUsd : resumed ? sessionCostUsd : 0
      day.costUsd += sessionCostUsd - before
      if (sessionId) this.data.session = { id: sessionId, costUsd: sessionCostUsd }
    }
    this.data.days[date] = day

    const dates = Object.keys(this.data.days).sort()
    for (const old of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) delete this.data.days[old]
    await this.save()
  }

  /** Stores the limits last read from a provider account. */
  async setLimits(provider: ProviderId, limits: UsageLimit[], available: boolean, plan?: string): Promise<void> {
    this.data.limitsProvider = provider
    this.data.limitsAvailable = available
    this.data.plan = plan
    this.data.limits = limits
    this.data.limitsAt = this.now().getTime()
    await this.save()
  }

  /** Forgets limits read from another provider (they would be misleading). */
  async clearLimits(): Promise<void> {
    this.data.limits = []
    this.data.limitsAt = undefined
    this.data.limitsAvailable = undefined
    this.data.plan = undefined
    this.data.limitsProvider = undefined
    await this.save()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.data), 'utf8')
  }
}
