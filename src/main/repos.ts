import { isAbsolute, resolve } from 'node:path'

/** A local code repository the agents may work in (config.json `repos`). */
export interface Repo {
  name: string
  /** Absolute folder path. */
  path: string
  /** true = "escritura" (read and write), false = "lectura" (read only). */
  write: boolean
}

export const REPO_NAME_RE = /^[a-zA-Z0-9_-]{1,40}$/

/**
 * Parses config.json `repos`: `{ "api": { "ruta": "C:/x", "acceso": "escritura" } }`.
 * A bad entry is reported and skipped; the rest still load.
 */
export function parseRepos(raw: unknown): { repos: Repo[]; errors: string[] } {
  const repos: Repo[] = []
  const errors: string[] = []
  if (raw === undefined || raw === null) return { repos, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { repos, errors: ['config.json › repos: debe ser un objeto { "nombre": { "ruta": "…", "acceso": "lectura" } }'] }
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const where = `config.json › repos › ${name}`
    if (!REPO_NAME_RE.test(name)) {
      errors.push(`${where}: nombre inválido (letras, números, - y _)`)
      continue
    }
    const v = (value ?? {}) as Record<string, unknown>
    const path = typeof v.ruta === 'string' ? v.ruta.trim() : ''
    if (!path || !isAbsolute(path)) {
      errors.push(`${where}: "ruta" debe ser una ruta completa de carpeta, por ejemplo C:/proyectos/${name}`)
      continue
    }
    const access = v.acceso ?? 'lectura'
    if (access !== 'lectura' && access !== 'escritura') {
      errors.push(`${where}: "acceso" debe ser "lectura" o "escritura"`)
      continue
    }
    repos.push({ name, path: resolve(path), write: access === 'escritura' })
  }
  return { repos, errors }
}

/** Repos an agent may use: the ones it lists in agent.md, or all when it lists none. */
export function reposFor(all: Repo[], wanted: string[] | undefined): Repo[] {
  if (!wanted) return all
  return all.filter((r) => wanted.includes(r.name))
}

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']

/** Whether an agent can touch files at all (so telling it about repos is worth the tokens). */
export function usesFiles(tools: string[] | undefined): boolean {
  return !tools || tools.some((t) => FILE_TOOLS.includes(t))
}

function line(r: Repo): string {
  return `- ${r.name}: ${r.path} (${r.write ? 'lectura y escritura' : 'solo lectura'})`
}

/** Section appended to an agent's prompt listing the repos it may use. */
export function agentReposText(repos: Repo[]): string {
  if (!repos.length) return ''
  return [
    '## Repositorios de código',
    'Puedes trabajar en estas carpetas (usa siempre rutas completas). No toques otras carpetas de código.',
    ...repos.map(line)
  ].join('\n')
}

/** Repos list for the brain's prompt. */
export function brainReposText(repos: Repo[], agentRepos: Record<string, string[] | undefined>): string {
  if (!repos.length) return '(Ninguno configurado.)'
  const limited = Object.entries(agentRepos).filter(([, r]) => r !== undefined)
  const lines = repos.map(line)
  if (limited.length) {
    lines.push('', 'Agentes limitados a algunos repos:')
    for (const [id, names] of limited) lines.push(`- "${id}": ${names!.length ? names!.join(', ') : 'ninguno'}`)
  }
  return lines.join('\n')
}
