/**
 * Translation between the canonical tool names used in agent.md (Claude's
 * names) and GitHub Copilot's built-in tools.
 */

const shell = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'powershell' : 'bash')

/** Canonical names Copilot has no equivalent for. */
export const COPILOT_MISSING = new Set(['WebSearch'])

/** Copilot tool names for an agent's canonical list. Undefined = every tool. */
export function toCopilotTools(
  tools: string[] | undefined,
  mcpServers: string[],
  platform: NodeJS.Platform = process.platform
): string[] | undefined {
  if (!tools) return undefined
  const sh = shell(platform)
  const out = new Set<string>()
  for (const tool of tools) {
    switch (tool) {
      case 'Read':
        out.add('view')
        break
      case 'Write':
        out.add('create')
        break
      case 'Edit':
        out.add('edit')
        break
      case 'Glob':
        out.add('glob')
        break
      case 'Grep':
        out.add('grep')
        break
      case 'WebFetch':
        out.add('web_fetch')
        break
      case 'Bash':
        for (const t of [sh, `read_${sh}`, `stop_${sh}`, `list_${sh}`]) out.add(t)
        break
      default: {
        // An explicit MCP tool: mcp__srv__tool -> srv-tool
        const m = /^mcp__(.+?)__(.+)$/.exec(tool)
        if (m) out.add(`${m[1]}-${m[2]}`)
      }
    }
  }
  for (const server of mcpServers) out.add(`${server}/*`)
  return [...out]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Copilot tool call -> canonical name and Claude-like input, for bubbles and policy. */
export function fromCopilotTool(
  toolName: string,
  args: Record<string, unknown>,
  mcp?: { server?: string; tool?: string }
): { tool: string; input: Record<string, unknown> } {
  if (mcp?.server && mcp.tool) return { tool: `mcp__${mcp.server}__${mcp.tool}`, input: args }
  switch (toolName) {
    case 'view':
      return { tool: 'Read', input: { file_path: str(args.path) ?? '' } }
    case 'create':
      return { tool: 'Write', input: { file_path: str(args.path) ?? '' } }
    case 'edit':
      return { tool: 'Edit', input: { file_path: str(args.path) ?? '' } }
    case 'glob':
      return { tool: 'Glob', input: { pattern: str(args.pattern) ?? '', path: Array.isArray(args.paths) ? str(args.paths[0]) : undefined } }
    case 'grep':
      return { tool: 'Grep', input: { pattern: str(args.pattern) ?? '', path: Array.isArray(args.paths) ? str(args.paths[0]) : undefined } }
    case 'web_fetch':
      return { tool: 'WebFetch', input: { url: str(args.url) ?? '' } }
    case 'powershell':
    case 'bash':
      return { tool: 'Bash', input: { command: str(args.command) ?? '', description: str(args.description) } }
    default:
      return { tool: toolName, input: args }
  }
}

/** The parts of a Copilot permission request this app reads. */
export interface CopilotPermission {
  kind: string
  toolCallId?: string
  path?: string
  fileName?: string
  fullCommandText?: string
  url?: string
  serverName?: string
  toolName?: string
  args?: unknown
}

/** Copilot permission request -> canonical tool and input for the policy. */
export function permissionToCanonical(req: CopilotPermission): { tool: string; input: Record<string, unknown> } {
  switch (req.kind) {
    case 'read':
      return { tool: 'Read', input: { file_path: req.path ?? '' } }
    case 'write':
      return { tool: 'Write', input: { file_path: req.fileName ?? '' } }
    case 'shell':
      return { tool: 'Bash', input: { command: req.fullCommandText ?? '' } }
    case 'url':
      return { tool: 'WebFetch', input: { url: req.url ?? '' } }
    case 'mcp': {
      const args = req.args && typeof req.args === 'object' ? (req.args as Record<string, unknown>) : {}
      return { tool: `mcp__${req.serverName ?? 'mcp'}__${req.toolName ?? 'tool'}`, input: args }
    }
    default:
      return { tool: req.kind, input: {} }
  }
}
