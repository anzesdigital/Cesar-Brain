import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import type { PermissionRequest } from '@shared/types'

export type Decision = 'allow' | 'ask'

const DELEGATION = new Set(['Agent', 'Task'])
const WEB = new Set(['WebSearch', 'WebFetch'])
const FILE_READ = new Set(['Read', 'Glob', 'Grep'])
const FILE_WRITE = new Set(['Write', 'Edit'])

export function isInside(target: string, root: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  const t = norm(target)
  const r = norm(root)
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Policy: delegation and web are free; file access is free only inside the
 * workspace; everything else (commands, files elsewhere, unknown tools) asks.
 */
export function decide(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string,
  /** Tools of built-in servers that may run without asking. */
  trustedTools: ReadonlySet<string> = new Set()
): Decision {
  if (DELEGATION.has(toolName) || WEB.has(toolName) || trustedTools.has(toolName)) return 'allow'
  if (FILE_READ.has(toolName) || FILE_WRITE.has(toolName)) {
    const raw = input.file_path ?? input.path
    if (typeof raw !== 'string' || !raw) {
      // Glob/Grep without a path search the working directory (the workspace).
      return FILE_READ.has(toolName) ? 'allow' : 'ask'
    }
    return isInside(resolve(workspaceDir, raw), workspaceDir) ? 'allow' : 'ask'
  }
  return 'ask'
}

/** Holds permission prompts open until the user answers in the UI. */
export class PermissionGate {
  private pending = new Map<string, (allow: boolean) => void>()

  constructor(private notify: (req: PermissionRequest) => void) {}

  ask(agentId: string, toolName: string, summary: string, signal?: AbortSignal): Promise<boolean> {
    const id = randomUUID()
    return new Promise<boolean>((resolvePromise) => {
      this.pending.set(id, resolvePromise)
      signal?.addEventListener('abort', () => this.respond(id, false), { once: true })
      this.notify({ id, agentId, toolName, summary })
    })
  }

  respond(id: string, allow: boolean): void {
    const done = this.pending.get(id)
    if (!done) return
    this.pending.delete(id)
    done(allow)
  }

  denyAll(): void {
    for (const id of [...this.pending.keys()]) this.respond(id, false)
  }
}
