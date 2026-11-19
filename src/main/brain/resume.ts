import type { ChatMessage, ResumeMode } from '@shared/types'

/** Default size above which an old conversation resumes from a summary. */
export const DEFAULT_RESUME_MAX_TOKENS = 20_000
const SUMMARY_MESSAGES = 12
const SUMMARY_CHARS = 800

/**
 * Rough size of the brain's history in tokens: ~4 characters per token, times
 * two for the agents' reports and tool calls the chat does not show.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.text.length, 0)
  return Math.round((chars / 4) * 2)
}

/**
 * How to continue a conversation opened from the history: the whole session
 * when it is short enough and still exists for this provider, otherwise a
 * summary.
 */
export function chooseResumeMode(opts: { canFull: boolean; tokens: number; maxTokens: number }): ResumeMode {
  return opts.canFull && opts.tokens <= opts.maxTokens ? 'full' : 'summary'
}

function clip(text: string): string {
  const flat = text.replace(/```(?:opciones|options)[\s\S]*?(```|$)/gi, '').trim()
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 1)}…` : flat
}

/** The last visible messages, as context for a session that starts fresh. */
export function summaryPreamble(messages: ChatMessage[]): string {
  const last = messages.slice(-SUMMARY_MESSAGES).filter((m) => m.text.trim())
  if (!last.length) return ''
  const lines = last.map((m) => `${m.role === 'user' ? 'Usuario' : 'Cerebro'}: ${clip(m.text)}`)
  const skipped = messages.length - last.length
  return [
    'Contexto: esta conversación es la continuación de una anterior. Sus últimos mensajes' +
      (skipped > 0 ? ` (se omiten ${skipped} más antiguos)` : '') +
      ':',
    '',
    ...lines,
    '',
    'Nuevo mensaje del usuario:'
  ].join('\n')
}

/** Puts the summary in front of the prompt. */
export function withHistory(prompt: string, history: string | undefined): string {
  return history ? `${history}\n${prompt}` : prompt
}
