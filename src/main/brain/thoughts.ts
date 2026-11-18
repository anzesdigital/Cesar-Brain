import { basename } from 'node:path'

export const MAX_BUBBLE = 60

export function truncate(text: string, max = MAX_BUBBLE): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1).trimEnd() + '…'
}

/** First sentence of free text, stripped of markdown noise, bubble-sized. */
export function firstSentence(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  const match = clean.match(/^.*?[.!?…](?=\s|$)/)
  return truncate(match ? match[0] : clean)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fileName(value: unknown): string {
  const p = str(value)
  return p ? basename(p.replace(/\\/g, '/')) : 'archivo'
}

function domain(value: unknown): string {
  try {
    return new URL(str(value)).hostname.replace(/^www\./, '')
  } catch {
    return 'la web'
  }
}

/** Short Spanish phrase describing what a tool call is doing. */
export function thoughtForTool(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'WebSearch':
      return truncate(`Buscando: «${str(input.query)}»`)
    case 'WebFetch':
      return truncate(`Leyendo ${domain(input.url)}`)
    case 'Read':
      return truncate(`Abriendo ${fileName(input.file_path)}`)
    case 'Write':
      return truncate(`Escribiendo ${fileName(input.file_path)}`)
    case 'Edit':
      return truncate(`Editando ${fileName(input.file_path)}`)
    case 'Glob':
      return truncate(`Buscando archivos ${str(input.pattern)}`)
    case 'Grep':
      return truncate(`Buscando «${str(input.pattern)}» en archivos`)
    case 'Bash':
    case 'PowerShell':
      return truncate(`Ejecutando: ${str(input.description) || str(input.command)}`)
    default:
      if (toolName.startsWith('mcp__')) {
        return truncate(`Usando ${toolName.split('__').slice(1).join(' › ')}`)
      }
      return truncate(`Usando ${toolName}`)
  }
}

/** Sentence shown to the user when a tool needs approval. */
export function permissionSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Write':
    case 'Edit':
      return `Escribir el archivo ${str(input.file_path)}`
    case 'Read':
      return `Leer el archivo ${str(input.file_path)}`
    case 'Bash':
    case 'PowerShell':
      return `Ejecutar el comando: ${str(input.command)}`
    default:
      if (toolName.startsWith('mcp__')) {
        const args = JSON.stringify(input)
        const shown = args.length > 300 ? args.slice(0, 299) + '…' : args
        return `Usar ${toolName.split('__').slice(1).join(' › ')} con ${shown}`
      }
      return `Usar la herramienta ${toolName}`
  }
}
