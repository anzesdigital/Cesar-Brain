import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PermissionSettings } from '@shared/types'
import { parseConfig, parsePermissions } from '../src/main/config'
import { decide } from '../src/main/brain/permissions'
import {
  DENIED_BY_RULE,
  isSafeCommand,
  matchesPrefix,
  matchRule,
  resolvePermission,
  suggestRule
} from '../src/main/brain/rules'

const ws = resolve('/tmp/cb-ws')
const repoDir = resolve('/tmp/cb-repos/web')
const readOnlyDir = resolve('/tmp/cb-repos/docs')
const outside = resolve('/tmp/elsewhere/file.txt')
const repos = [
  { name: 'web', path: repoDir, write: true },
  { name: 'docs', path: readOnlyDir, write: false }
]

function settings(patch: Partial<PermissionSettings> = {}): PermissionSettings {
  return { mode: 'preguntar', allow: [], deny: [], ...patch }
}

function final(tool: string, input: Record<string, unknown>, s: PermissionSettings, agentId = 'dev', session = []) {
  const base = decide(tool, input, { workspaceDir: ws, repos })
  return resolvePermission(base, { agentId, tool, input, workspaceDir: ws, settings: s, session })
}

describe('isSafeCommand', () => {
  it.each(['git status', 'git diff --stat', 'npm test', 'npm run lint', 'ls -la', 'Get-ChildItem', 'pytest -q', 'git branch'])(
    'allows %s',
    (cmd) => expect(isSafeCommand(cmd)).toBe(true)
  )
  it.each([
    'npm test && rm -rf /',
    'git status; git push',
    'cat a > b',
    'git log | sh',
    'npm test & del x',
    'echo $(whoami)',
    'git push',
    'git branch -D main',
    'Remove-Item x',
    'npm install',
    'curl http://x',
    ''
  ])('asks for %s', (cmd) => expect(isSafeCommand(cmd)).toBe(false))
})

describe('matchesPrefix', () => {
  it('needs a word boundary and no chaining', () => {
    expect(matchesPrefix('npm test', 'npm test')).toBe(true)
    expect(matchesPrefix('npm   test --watch', 'npm test')).toBe(true)
    expect(matchesPrefix('npm testx', 'npm test')).toBe(false)
    expect(matchesPrefix('npm test && rm -rf x', 'npm test')).toBe(false)
    expect(matchesPrefix('NPM TEST', 'npm test*')).toBe(true)
  })
})

describe('matchRule', () => {
  it('limits by agent', () => {
    const rule = { tool: 'Bash', pattern: 'npm test', agent: 'dev' }
    expect(matchRule(rule, 'dev', 'Bash', { command: 'npm test' }, ws)).toBe(true)
    expect(matchRule(rule, 'otro', 'Bash', { command: 'npm test' }, ws)).toBe(false)
    expect(matchRule({ tool: 'Bash', pattern: 'npm test' }, 'otro', 'Bash', { command: 'npm test' }, ws)).toBe(true)
  })
  it('treats Bash and PowerShell, Write and Edit as one', () => {
    expect(matchRule({ tool: 'Bash' }, 'a', 'PowerShell', { command: 'x' }, ws)).toBe(true)
    expect(matchRule({ tool: 'Write', pattern: repoDir }, 'a', 'Edit', { file_path: join(repoDir, 'a.ts') }, ws)).toBe(true)
    expect(matchRule({ tool: 'Write', pattern: repoDir }, 'a', 'Edit', { file_path: outside }, ws)).toBe(false)
  })
  it('a server rule covers its tools', () => {
    expect(matchRule({ tool: 'mcp__gh' }, 'a', 'mcp__gh__list', {}, ws)).toBe(true)
    expect(matchRule({ tool: 'mcp__gh' }, 'a', 'mcp__ghx__list', {}, ws)).toBe(false)
    expect(matchRule({ tool: 'mcp__gh__list' }, 'a', 'mcp__gh__delete', {}, ws)).toBe(false)
  })
})

describe('suggestRule', () => {
  it('takes two words for runners and one otherwise', () => {
    expect(suggestRule('dev', 'Bash', { command: 'npm test -- --watch' }, ws)).toEqual({ tool: 'Bash', pattern: 'npm test', agent: 'dev' })
    expect(suggestRule('dev', 'Bash', { command: 'make build' }, ws)).toEqual({ tool: 'Bash', pattern: 'make', agent: 'dev' })
    expect(suggestRule('dev', 'Bash', { command: 'git;rm x' }, ws).pattern).toBe('git')
  })
  it('suggests the folder for files', () => {
    expect(suggestRule('dev', 'Edit', { file_path: outside }, ws)).toEqual({
      tool: 'Write',
      pattern: resolve('/tmp/elsewhere'),
      agent: 'dev'
    })
  })
})

describe('resolvePermission', () => {
  it('asks by default, as before', () => {
    expect(final('Bash', { command: 'npm test' }, settings())).toBe('ask')
    expect(final('Write', { file_path: outside }, settings())).toBe('ask')
  })
  it('deny rules win over everything, even free tools and mode todo', () => {
    const s = settings({ mode: 'todo', deny: [{ tool: 'WebFetch' }], allow: [{ tool: 'WebFetch' }] })
    expect(final('WebFetch', { url: 'x' }, s)).toEqual({ deny: DENIED_BY_RULE })
  })
  it('keeps read-only repo denials in mode todo', () => {
    expect(final('Write', { file_path: join(readOnlyDir, 'a.md') }, settings({ mode: 'todo' }))).toHaveProperty('deny')
  })
  it('ediciones lets file tools through but not commands', () => {
    const s = settings({ mode: 'ediciones' })
    expect(final('Write', { file_path: outside }, s)).toBe('allow')
    expect(final('Bash', { command: 'git status' }, s)).toBe('ask')
  })
  it('automatico runs safe commands, reads anywhere, asks for writes outside repos', () => {
    const s = settings({ mode: 'automatico' })
    expect(final('Bash', { command: 'git status' }, s)).toBe('allow')
    expect(final('Bash', { command: 'git push' }, s)).toBe('ask')
    expect(final('Read', { file_path: outside }, s)).toBe('allow')
    expect(final('Write', { file_path: outside }, s)).toBe('ask')
    expect(final('Write', { file_path: join(repoDir, 'a.ts') }, s)).toBe('allow')
    expect(final('mcp__gh__delete', {}, s)).toBe('ask')
  })
  it('remembered and conversation rules allow', () => {
    const rule = { tool: 'Bash', pattern: 'npm run dev', agent: 'dev' }
    expect(final('Bash', { command: 'npm run dev' }, settings({ allow: [rule] }))).toBe('allow')
    expect(final('Bash', { command: 'npm run dev --port 3' }, settings({ allow: [rule] }))).toBe('allow')
    expect(final('Bash', { command: 'npm run build' }, settings({ allow: [rule] }))).toBe('ask')
    expect(final('Bash', { command: 'npm run dev' }, settings(), 'dev', [rule] as never)).toBe('allow')
    expect(final('Bash', { command: 'npm run dev' }, settings(), 'otro', [rule] as never)).toBe('ask')
  })
})

describe('permissions in config.json', () => {
  it('defaults to preguntar with no rules', () => {
    expect(parseConfig({}).permissions).toEqual({ mode: 'preguntar', allow: [], deny: [] })
  })
  it('reads rules and skips bad ones with a warning', () => {
    const { permissions, errors } = parsePermissions({
      mode: 'automatico',
      allow: [{ tool: 'Bash', pattern: ' npm test ', agent: 'dev' }, { pattern: 'x' }, 'nope'],
      deny: 'no'
    })
    expect(permissions).toEqual({ mode: 'automatico', allow: [{ tool: 'Bash', pattern: 'npm test', agent: 'dev' }], deny: [] })
    expect(errors).toHaveLength(3)
  })
  it('falls back on an unknown mode', () => {
    const { permissions, errors } = parsePermissions({ mode: 'yolo' })
    expect(permissions.mode).toBe('preguntar')
    expect(errors[0]).toMatch(/yolo/)
  })
})
