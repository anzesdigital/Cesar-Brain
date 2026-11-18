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
      if (toolName.startsWith('mcp__presupuesto__')) {
        return truncate(budgetThought(toolName.slice('mcp__presupuesto__'.length), input))
      }
      if (toolName.startsWith('mcp__')) {
        return truncate(`Usando ${toolName.split('__').slice(1).join(' › ')}`)
      }
      return truncate(`Usando ${toolName}`)
  }
}

function count(value: unknown, one: string, many: string): string {
  const n = Array.isArray(value) ? value.length : 0
  return n === 1 ? `1 ${one}` : `${n} ${many}`
}

function budgetThought(tool: string, input: Record<string, unknown>): string {
  const periodo = str(input.periodo).replace(/^Budget\s+/i, '')
  switch (tool) {
    case 'estado':
      return 'Mirando cómo va el presupuesto'
    case 'listar_movimientos':
      return `Repasando movimientos${periodo ? ` de ${periodo}` : ''}`
    case 'buscar_reglas':
      return 'Viendo si ya conozco estos comercios'
    case 'guardar_regla':
      return `Me apunto: ${str(input.patron)} → ${str(input.categoria)}`
    case 'registrar_movimientos':
      return `Anotando ${count(input.movimientos, 'movimiento', 'movimientos')}`
    case 'guardar_pendientes':
      return `Tengo ${count(input.pendientes, 'duda', 'dudas')} de categoría`
    case 'resolver_pendiente':
      return input.descartar ? 'Descartando un pendiente' : `Resuelto: va a ${str(input.categoria)}`
    case 'comparar_presupuesto':
      return `Comparando ${periodo || 'el periodo'} con lo gastado`
    case 'crear_periodo':
      return `Abriendo periodo desde ${str(input.inicio)}`
    case 'aplicar_presupuesto':
      return 'Aplicando el presupuesto aprobado'
    default:
      return `Presupuesto: ${tool}`
  }
}

function budgetPermission(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'crear_periodo') {
    const fin = str(input.fin) ? ` hasta ${str(input.fin)}` : ' (fin provisional el día 24)'
    return `Abrir un periodo nuevo en tu hoja de Google desde ${str(input.inicio)}${fin}. Duplica la plantilla, copia categorías y presupuesto del periodo anterior y lo cierra el día previo.`
  }
  if (tool === 'aplicar_presupuesto') {
    const lines: string[] = []
    const cambios = Array.isArray(input.cambios) ? (input.cambios as Record<string, unknown>[]) : []
    const nuevas = Array.isArray(input.nuevas) ? (input.nuevas as Record<string, unknown>[]) : []
    for (const c of cambios) lines.push(`${str(c.categoria)} → ${String(c.presupuesto)} €`)
    for (const n of nuevas) lines.push(`Nueva categoría ${str(n.nombre)} → ${String(n.presupuesto)} €`)
    const where = str(input.periodo) || 'el periodo actual'
    return `Cambiar el presupuesto de ${where} en tu hoja de Google:\n${lines.join('\n')}`
  }
  return undefined
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
      if (toolName.startsWith('mcp__presupuesto__')) {
        const summary = budgetPermission(toolName.slice('mcp__presupuesto__'.length), input)
        if (summary) return summary
      }
      return `Usar la herramienta ${toolName}`
  }
}
