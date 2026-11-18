import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import type { PermissionRequest } from '@shared/types'
import { mcpServerOf } from '../mcp'
import type { Repo } from '../repos'

/** 'allow', 'ask' the user, or refuse with a reason the agent is told. */
export type Decision = 'allow' | 'ask' | { deny: string }

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

export interface PolicyContext {
  workspaceDir: string
  /** Folders that may be read without asking (e.g. the agents folder). */
  readableDirs?: readonly string[]
  /** MCP servers whose tools run without asking. */
  trustedServers?: ReadonlySet<string>
  /** Single MCP tools (`mcp__srv__tool`) that run without asking. */
  trustedTools?: ReadonlySet<string>
  /** Every configured code repository. */
  repos?: readonly Repo[]
  /** Names of the repos this caller may use (undefined = all). */
  allowedRepos?: ReadonlySet<string>
}

/** The configured repo a path is in (the innermost one if they nest). */
function repoOf(target: string, repos: readonly Repo[]): Repo | undefined {
  return repos
    .filter((r) => isInside(target, r.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/**
 * Policy, on canonical tool names: delegation and web are free; file reads are
 * free inside the workspace and readable folders, file writes only inside the
 * workspace; tools of trusted MCP servers are free.
 * Code repos: reading is free and writing is free only in "escritura" repos;
 * writing a read-only repo or touching a repo the agent was not given is
 * refused. Everything else (commands included) asks.
 */
export function decide(toolName: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  if (DELEGATION.has(toolName) || WEB.has(toolName)) return 'allow'
  const server = mcpServerOf(toolName)
  if (server !== undefined) return ctx.trustedServers?.has(server) || ctx.trustedTools?.has(toolName) ? 'allow' : 'ask'
  if (FILE_READ.has(toolName) || FILE_WRITE.has(toolName)) {
    const raw = input.file_path ?? input.path
    if (typeof raw !== 'string' || !raw) {
      // Glob/Grep without a path search the working directory (the workspace).
      return FILE_READ.has(toolName) ? 'allow' : 'ask'
    }
    const target = resolve(ctx.workspaceDir, raw)
    if (isInside(target, ctx.workspaceDir)) return 'allow'
    const repo = repoOf(target, ctx.repos ?? [])
    if (repo) {
      if (ctx.allowedRepos && !ctx.allowedRepos.has(repo.name)) {
        return { deny: `No tienes acceso al repositorio "${repo.name}". Avisa al Cerebro de que este encargo necesita ese repo.` }
      }
      if (FILE_READ.has(toolName) || repo.write) return 'allow'
      return { deny: `El repositorio "${repo.name}" es de solo lectura: no se puede modificar.` }
    }
    if (FILE_READ.has(toolName) && (ctx.readableDirs ?? []).some((d) => isInside(target, d))) return 'allow'
    return 'ask'
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
