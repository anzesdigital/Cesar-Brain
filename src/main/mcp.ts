import { readFile } from 'node:fs/promises'

/** One MCP server as written in mcp.json (same shape Claude and Copilot accept). */
export type McpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export interface McpCatalog {
  servers: Record<string, McpServer>
  /** Servers marked `"trusted": true`: their tools run without asking. */
  trusted: Set<string>
  /** Single tools listed in `"trusted": ["tool", …]`, as `mcp__server__tool`. */
  trustedTools: Set<string>
  errors: string[]
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

/**
 * Parses mcp.json. Accepts `{ "servers": {...} }` and the common
 * `{ "mcpServers": {...} }` so configs can be pasted from other tools.
 * A bad server is reported and skipped; the rest still load.
 */
export function parseMcp(raw: unknown): McpCatalog {
  const catalog: McpCatalog = { servers: {}, trusted: new Set(), trustedTools: new Set(), errors: [] }
  if (!raw || typeof raw !== 'object') {
    catalog.errors.push('mcp.json: debe ser un objeto con "servers"')
    return catalog
  }
  const root = raw as Record<string, unknown>
  const servers = (root.servers ?? root.mcpServers ?? {}) as Record<string, unknown>
  if (typeof servers !== 'object' || Array.isArray(servers)) {
    catalog.errors.push('mcp.json: "servers" debe ser un objeto')
    return catalog
  }
  for (const [name, value] of Object.entries(servers)) {
    const where = `mcp.json › ${name}`
    if (!NAME_RE.test(name)) {
      catalog.errors.push(`${where}: nombre inválido (letras, números, - y _)`)
      continue
    }
    if (!value || typeof value !== 'object') {
      catalog.errors.push(`${where}: debe ser un objeto`)
      continue
    }
    const v = value as Record<string, unknown>
    if (v.disabled === true) continue
    const type = typeof v.type === 'string' ? v.type : undefined
    if (type === 'http' || type === 'sse' || (type === undefined && typeof v.url === 'string')) {
      if (typeof v.url !== 'string' || !v.url) {
        catalog.errors.push(`${where}: falta "url"`)
        continue
      }
      catalog.servers[name] = { type: type === 'sse' ? 'sse' : 'http', url: v.url, headers: stringRecord(v.headers) }
    } else if (type === undefined || type === 'stdio' || type === 'local') {
      if (typeof v.command !== 'string' || !v.command) {
        catalog.errors.push(`${where}: falta "command" (o "url" para un servidor remoto)`)
        continue
      }
      const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : undefined
      catalog.servers[name] = {
        type: 'stdio',
        command: v.command,
        args,
        env: stringRecord(v.env),
        cwd: typeof v.cwd === 'string' ? v.cwd : undefined
      }
    } else {
      catalog.errors.push(`${where}: tipo desconocido "${type}" (stdio, http o sse)`)
      continue
    }
    if (v.trusted === true) catalog.trusted.add(name)
    else if (Array.isArray(v.trusted)) {
      for (const t of v.trusted) if (typeof t === 'string' && t) catalog.trustedTools.add(`mcp__${name}__${t}`)
    }
  }
  return catalog
}

export function emptyCatalog(): McpCatalog {
  return { servers: {}, trusted: new Set(), trustedTools: new Set(), errors: [] }
}

export async function loadMcp(file: string): Promise<McpCatalog> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return emptyCatalog()
  }
  try {
    return parseMcp(JSON.parse(text))
  } catch (err) {
    return { ...emptyCatalog(), errors: [`mcp.json no es JSON válido (${(err as Error).message})`] }
  }
}

/** Server name of a canonical MCP tool name (`mcp__srv__tool`), if it is one. */
export function mcpServerOf(toolName: string): string | undefined {
  const m = /^mcp__(.+?)__/.exec(toolName)
  return m ? m[1] : undefined
}
