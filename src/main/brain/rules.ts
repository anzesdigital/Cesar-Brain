import { dirname, resolve } from 'node:path'
import type { PermissionMode, PermissionRule, PermissionSettings } from '@shared/types'
import { mcpServerOf } from '../mcp'
import { isInside, type Decision } from './permissions'

const COMMAND = new Set(['Bash', 'PowerShell'])
const FILE_WRITE = new Set(['Write', 'Edit', 'NotebookEdit'])
const FILE_READ = new Set(['Read', 'Glob', 'Grep'])

/** Tools that a rule treats as one: any shell, any file write, any file read. */
function family(tool: string): string {
  if (COMMAND.has(tool)) return 'Bash'
  if (FILE_WRITE.has(tool)) return 'Write'
  if (FILE_READ.has(tool)) return 'Read'
  return tool
}

/** Chaining, pipes, redirection, background or substitution: a prefix says nothing about the rest. */
export function hasChaining(command: string): boolean {
  return /[;&|<>`\r\n]|\$\(/.test(command)
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

/** `command` is `prefix` or `prefix …`, and runs nothing else. */
export function matchesPrefix(command: string, prefix: string): boolean {
  const cmd = normalize(command)
  const pre = normalize(prefix).replace(/\s*\*$/, '')
  if (!pre || hasChaining(cmd)) return false
  const a = cmd.toLowerCase()
  const b = pre.toLowerCase()
  return a === b || a.startsWith(`${b} `)
}

// Commands that only read or check: the "automático" mode runs them without asking.
const SAFE_COMMANDS: RegExp[] = [
  /^git (status|diff|log|show|rev-parse|ls-files|blame|describe)( |$)/,
  /^git branch( (-a|-r|-v|-vv|--list|--show-current))*$/,
  /^git remote( -v)?$/,
  /^(ls|dir|pwd|cat|type|head|tail|wc|tree|which|where)( |$)/,
  /^(get-childitem|get-content|get-location|gci|gc)( |$)/,
  /^(npm|pnpm|yarn) (test|t|ls|list|outdated)( |$)/,
  /^(npm|pnpm|yarn) run (test|lint|typecheck|build|check)( |$)/,
  /^(pnpm|yarn) (lint|typecheck|build)( |$)/,
  /^npx (tsc|vitest|eslint|jest)( |$)/,
  /^npx prettier --check( |$)/,
  /^(node|npm|pnpm|yarn|python|python3|py|git|dotnet|go|cargo) (-v|--version|version)$/,
  /^(python|python3|py) -m (pytest|unittest)( |$)/,
  /^pytest( |$)/,
  /^dotnet (build|test)( |$)/,
  /^cargo (build|test|check|clippy)( |$)/,
  /^go (build|test|vet)( |$)/
]

/** A command that only reads or verifies, with nothing chained to it. */
export function isSafeCommand(command: string): boolean {
  const cmd = normalize(command)
  if (!cmd || hasChaining(cmd)) return false
  const lower = cmd.toLowerCase()
  return SAFE_COMMANDS.some((re) => re.test(lower))
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const raw = input.file_path ?? input.notebook_path ?? input.path
  return typeof raw === 'string' && raw ? raw : undefined
}

/** Whether a remembered rule covers this call. */
export function matchRule(
  rule: PermissionRule,
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
  workspaceDir: string
): boolean {
  if (rule.agent && rule.agent !== agentId) return false
  const server = mcpServerOf(tool)
  const sameTool =
    family(rule.tool) === family(tool) || (server !== undefined && rule.tool === `mcp__${server}`)
  if (!sameTool) return false
  if (!rule.pattern) return true
  if (COMMAND.has(tool)) return typeof input.command === 'string' && matchesPrefix(input.command, rule.pattern)
  if (FILE_WRITE.has(tool) || FILE_READ.has(tool)) {
    const raw = pathOf(input)
    if (!raw) return false
    return isInside(resolve(workspaceDir, raw), resolve(workspaceDir, rule.pattern))
  }
  return false
}

const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'npx', 'git', 'python', 'python3', 'py', 'dotnet', 'cargo', 'go', 'node', 'docker', 'gh'])

/** The rule "Permitir siempre" offers for this call, before the user edits it. */
export function suggestRule(
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
  workspaceDir: string
): PermissionRule {
  if (COMMAND.has(tool) && typeof input.command === 'string') {
    const words = normalize(input.command).split(' ')
    const take = RUNNERS.has(words[0]?.toLowerCase() ?? '') ? 2 : 1
    // Stop before anything chained so the suggestion is a clean prefix.
    const prefix = words.slice(0, take).join(' ').split(/[;&|<>`]|\$\(/)[0].trim()
    return prefix ? { tool: 'Bash', pattern: prefix, agent: agentId } : { tool: 'Bash', agent: agentId }
  }
  const raw = pathOf(input)
  if ((FILE_WRITE.has(tool) || FILE_READ.has(tool)) && raw) {
    return { tool: family(tool), pattern: dirname(resolve(workspaceDir, raw)), agent: agentId }
  }
  return { tool, agent: agentId }
}

/** What the mode lets through when the base policy would ask. */
function modeAllows(mode: PermissionMode, tool: string, input: Record<string, unknown>): boolean {
  switch (mode) {
    case 'todo':
      return true
    case 'ediciones':
      return FILE_WRITE.has(tool) || FILE_READ.has(tool)
    case 'automatico':
      // Writes outside the workspace and the agent's write repos still ask: decide() already allowed the rest.
      if (FILE_READ.has(tool)) return true
      if (COMMAND.has(tool)) return typeof input.command === 'string' && isSafeCommand(input.command)
      return false
    default:
      return false
  }
}

export interface ResolveContext {
  agentId: string
  tool: string
  input: Record<string, unknown>
  workspaceDir: string
  settings: PermissionSettings
  /** Rules granted for the current conversation only. */
  session?: readonly PermissionRule[]
}

export const DENIED_BY_RULE = 'Bloqueado por las reglas de permisos del usuario. No lo intentes de otra forma; avisa al Cerebro.'

/**
 * Final answer: the user's deny rules win over everything, then the base
 * policy's allow/deny, then remembered allows, then the mode.
 */
export function resolvePermission(base: Decision, ctx: ResolveContext): Decision {
  const match = (rule: PermissionRule): boolean => matchRule(rule, ctx.agentId, ctx.tool, ctx.input, ctx.workspaceDir)
  if (ctx.settings.deny.some(match)) return { deny: DENIED_BY_RULE }
  if (base !== 'ask') return base
  if (ctx.settings.allow.some(match) || (ctx.session ?? []).some(match)) return 'allow'
  return modeAllows(ctx.settings.mode, ctx.tool, ctx.input) ? 'allow' : 'ask'
}
