import { readdir } from 'node:fs/promises'
import type { ChatMessage, NotificationSettings, PermissionRequest } from '@shared/types'
import { parseOptions } from '@shared/options'

const MAX_BODY = 140
export const SOUND_EXTENSIONS = ['wav', 'mp3', 'ogg']
/** Base name of the custom sound inside the sounds folder (`aviso.mp3`…). */
export const SOUND_BASENAME = 'aviso'

/** Markdown turned into one plain line, cut to fit a notification. */
export function plainText(text: string, max = MAX_BODY): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

export interface MessageAlert {
  kind: 'question' | 'response'
  title: string
  body: string
}

/** What a finished brain message means for the user: a question to answer or a reply to read. */
export function classifyMessage(message: Pick<ChatMessage, 'text' | 'error'>): MessageAlert {
  const { body, options } = parseOptions(message.text)
  if (options.length) {
    // The question is usually the last paragraph before the choices.
    const paragraphs = body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim())
    const question = plainText(paragraphs.at(-1) ?? '') || options.map((o) => o.label).join(' · ')
    return { kind: 'question', title: 'El Cerebro te pregunta', body: plainText(question) }
  }
  return {
    kind: 'response',
    title: message.error ? 'El Cerebro tuvo un problema' : 'Respuesta lista',
    body: plainText(body) || 'Ha terminado.'
  }
}

export function permissionAlert(req: PermissionRequest, agentName: string): { title: string; body: string } {
  return { title: `${agentName} pide permiso`, body: plainText(`${req.toolName}: ${req.summary}`) }
}

/** Notifications only when they are on and the user is not looking at the app. */
export function shouldAlert(settings: NotificationSettings, focused: boolean, force = false): boolean {
  return force || (settings.enabled && !focused)
}

/** The custom sound file in `dir`, if there is one. */
export async function findCustomSound(dir: string): Promise<string | undefined> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.find((n) => SOUND_EXTENSIONS.some((ext) => n.toLowerCase() === `${SOUND_BASENAME}.${ext}`))
}
