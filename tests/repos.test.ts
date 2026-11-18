import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brainPrompt } from '../src/main/brain/orchestrator'
import { decide } from '../src/main/brain/permissions'
import { parseAgentFile } from '../src/main/brain/registry'
import { parseConfig } from '../src/main/config'
import { agentReposText, brainReposText, parseRepos, reposFor, usesFiles, type Repo } from '../src/main/repos'

const api = resolve('/code/api')
const web = resolve('/code/web')
const REPOS: Repo[] = [
  { name: 'api', path: api, write: true },
  { name: 'web', path: web, write: false }
]

describe('repos in config.json', () => {
  it('reads good entries and reports bad ones', () => {
    const { repos, errors } = parseRepos({
      api: { ruta: api, acceso: 'escritura' },
      web: { ruta: web },
      rel: { ruta: 'relativa/x' },
      raro: { ruta: api, acceso: 'total' },
      'mal nombre': { ruta: api }
    })
    expect(repos).toEqual(REPOS)
    expect(errors).toHaveLength(3)
    expect(parseRepos(undefined)).toEqual({ repos: [], errors: [] })
    expect(parseRepos([1]).errors).toHaveLength(1)
  })

  it('is part of the config and a bad repo does not break it', () => {
    const c = parseConfig({ provider: 'copilot', repos: { api: { ruta: api, acceso: 'escritura' }, x: 3 } })
    expect(c.provider).toBe('copilot')
    expect(c.repos).toEqual([REPOS[0]])
    expect(parseConfig({}).repos).toEqual([])
  })
})

describe('repo access per agent', () => {
  it('reads the repos field from agent.md', () => {
    expect(parseAgentFile('---\ndescription: x\nrepos: [api]\n---\ncuerpo', 'a-b').spec.repos).toEqual(['api'])
    expect(parseAgentFile('---\ndescription: x\nrepos: []\n---\ncuerpo', 'a-b').spec.repos).toEqual([])
    expect(parseAgentFile('---\ndescription: x\n---\ncuerpo', 'a-b').spec.repos).toBeUndefined()
    expect(() => parseAgentFile('---\ndescription: x\nrepos: api\n---\ncuerpo', 'a-b')).toThrow(/repos/)
  })

  it('gives all repos by default, or only the listed ones', () => {
    expect(reposFor(REPOS, undefined)).toEqual(REPOS)
    expect(reposFor(REPOS, ['web']).map((r) => r.name)).toEqual(['web'])
    expect(reposFor(REPOS, [])).toEqual([])
  })

  it('only tells agents that work with files', () => {
    expect(usesFiles(undefined)).toBe(true)
    expect(usesFiles(['Read'])).toBe(true)
    expect(usesFiles(['WebSearch', 'WebFetch'])).toBe(false)
    const text = agentReposText(REPOS)
    expect(text).toContain(`- api: ${api} (lectura y escritura)`)
    expect(text).toContain(`- web: ${web} (solo lectura)`)
    expect(agentReposText([])).toBe('')
  })

  it('lists repos and limited agents for the brain', () => {
    const text = brainReposText(REPOS, { tester: ['web'], dev: undefined })
    expect(text).toContain('- api:')
    expect(text).toContain('- "tester": web')
    expect(text).not.toContain('"dev"')
    expect(brainReposText([], {})).toBe('(Ninguno configurado.)')
    expect(brainPrompt('{{REPOS}}', { roster: '', memory: '', user: '', delegation: '', repos: 'X' })).toBe('X')
  })
})

describe('repo permissions', () => {
  const ws = resolve('/tmp/ws')
  const base = { workspaceDir: ws, repos: REPOS }

  it('reads repos freely and writes only where allowed', () => {
    expect(decide('Read', { file_path: join(api, 'src', 'a.ts') }, base)).toBe('allow')
    expect(decide('Grep', { pattern: 'x', path: web }, base)).toBe('allow')
    expect(decide('Edit', { file_path: join(api, 'src', 'a.ts') }, base)).toBe('allow')
    expect(decide('Write', { file_path: join(web, 'b.ts') }, base)).toEqual({ deny: expect.stringMatching(/solo lectura/) })
  })

  it('refuses repos the agent was not given', () => {
    const tester = { ...base, allowedRepos: new Set(['web']) }
    expect(decide('Read', { file_path: join(web, 'b.ts') }, tester)).toBe('allow')
    expect(decide('Read', { file_path: join(api, 'a.ts') }, tester)).toEqual({ deny: expect.stringMatching(/No tienes acceso.*api/) })
  })

  it('uses the innermost repo and still asks outside repos and for commands', () => {
    const nested: Repo[] = [...REPOS, { name: 'api-docs', path: join(api, 'docs'), write: false }]
    expect(decide('Write', { file_path: join(api, 'docs', 'x.md') }, { ...base, repos: nested })).toEqual({
      deny: expect.stringMatching(/api-docs/)
    })
    expect(decide('Write', { file_path: resolve('/otra/x.md') }, base)).toBe('ask')
    expect(decide('Bash', { command: 'git status' }, base)).toBe('ask')
  })
})
