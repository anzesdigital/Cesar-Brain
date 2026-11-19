/** One choice the brain offers at the end of a message. */
export interface ChoiceOption {
  /** What gets sent back when the user picks it. */
  label: string
  /** Optional short clarification shown under the label. */
  detail?: string
}

export interface ParsedReply {
  /** Message text without the options block. */
  body: string
  options: ChoiceOption[]
}

// ```opciones … ``` (also "options"); the closing fence may be missing while streaming.
const BLOCK_RE = /(?:^|\r?\n)[ \t]*```[ \t]*(?:opciones|options)[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```[ \t]*(?=\r?\n|$)|$)/i

/**
 * Splits the brain's `opciones` block off a reply. Lines look like
 * `- Label | detail`; bullets and numbers are optional.
 */
export function parseOptions(text: string): ParsedReply {
  const match = BLOCK_RE.exec(text)
  if (!match) return { body: text, options: [] }
  const options: ChoiceOption[] = []
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()
    if (!line) continue
    const bar = line.indexOf(' | ')
    const label = (bar >= 0 ? line.slice(0, bar) : line).replace(/^\*\*(.+)\*\*$/, '$1').trim()
    const detail = bar >= 0 ? line.slice(bar + 3).trim() : ''
    if (label) options.push(detail ? { label, detail } : { label })
  }
  const before = text.slice(0, match.index).trim()
  const after = text.slice(match.index + match[0].length).trim()
  const body = [before, after].filter(Boolean).join('\n\n')
  return { body, options }
}
