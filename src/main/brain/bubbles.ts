/**
 * Per-agent bubble and permission texts written in agent.md.
 *
 * Templates take values from the tool's input:
 *   {campo}                 value (nested: {a.b}); empty if missing
 *   {campo?texto}           value, or `texto` when missing/empty
 *   {#campo}                number of items of a list
 *   {#campo|uno|varios}     "1 uno" / "3 varios"
 *   {campo.*:plantilla}     each item of a list through `plantilla` (its own
 *                           {fields} refer to the item), joined by the list separator
 */

/** Special keys for moments that are not tool calls. */
export const BUBBLE_MOMENTS = ['_encargo', '_listo', '_error'] as const

function lookup(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('.')) {
    if (!part) continue
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function show(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(show).filter(Boolean).join(', ')
  return JSON.stringify(value)
}

/** Index of the `}` closing the `{` at `start`, honouring nesting; -1 if none. */
function closing(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

function expression(expr: string, input: unknown, separator: string): string {
  // {lista.*:plantilla}
  const each = /^([\w.]+)\.\*:([\s\S]*)$/.exec(expr)
  if (each) {
    const list = lookup(input, each[1])
    if (!Array.isArray(list)) return ''
    return list.map((item) => render(each[2], item, separator)).filter(Boolean).join(separator)
  }
  // {#lista} / {#lista|uno|varios}
  if (expr.startsWith('#')) {
    const [path, one, many] = expr.slice(1).split('|')
    const list = lookup(input, path.trim())
    const n = Array.isArray(list) ? list.length : 0
    if (one === undefined) return String(n)
    return `${n} ${n === 1 ? one : (many ?? one)}`
  }
  // {campo} / {campo?por defecto}
  const q = expr.indexOf('?')
  const path = (q === -1 ? expr : expr.slice(0, q)).trim()
  const value = show(lookup(input, path))
  return value || (q === -1 ? '' : expr.slice(q + 1))
}

/** Fills a template with values from `input`. */
export function render(template: string, input: unknown, separator = ', '): string {
  let out = ''
  let i = 0
  while (i < template.length) {
    const open = template.indexOf('{', i)
    if (open === -1) {
      out += template.slice(i)
      break
    }
    const close = closing(template, open)
    if (close === -1) {
      out += template.slice(i)
      break
    }
    out += template.slice(i, open) + expression(template.slice(open + 1, close), input, separator)
    i = close + 1
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

/**
 * Template for a tool: by its full name (Read, mcp__srv__tool) or, for MCP
 * tools, by the tool's own name (tool).
 */
export function templateFor(templates: Record<string, string> | undefined, tool: string): string | undefined {
  if (!templates) return undefined
  if (templates[tool]) return templates[tool]
  const m = /^mcp__.+?__(.+)$/.exec(tool)
  return m ? templates[m[1]] : undefined
}
