import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import { BRAIN_ID, type AgentInfo, type SpriteSpec } from '@shared/types'

/** Provider-neutral description of an agent; each provider turns it into its own format. */
export interface AgentSpec {
  description: string
  prompt: string
  /** Canonical tool names (Read, Write, WebFetch…). Undefined = every tool. */
  tools?: string[]
  /** Names of servers from mcp.json this agent uses. */
  mcp: string[]
  /** Alias or model id as written in agent.md. */
  model?: string
  /** Bubble templates per tool (and _encargo/_listo/_error). */
  bubbles?: Record<string, string>
  /** Permission-prompt templates per tool. */
  permissions?: Record<string, string>
  /** Names of config.json repos it may use; undefined = all of them. */
  repos?: string[]
}

export interface AgentRecord {
  info: AgentInfo
  spec: AgentSpec
  /** Shipped with the app (brain/agents) rather than the user's folder. */
  builtin: boolean
}

export interface LoadResult {
  agents: AgentRecord[]
  errors: string[]
}

export interface AgentSource {
  dir: string
  builtin: boolean
}

/** Tool names an agent.md may list. Providers translate them. */
export const CANONICAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'] as const

/** Office room for agents that do not say where they sit. */
export const DEFAULT_ZONE = 'General'

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const HEX_RE = /^#[0-9a-fA-F]{6}$/

const PALETTE: SpriteSpec[] = [
  { hair: '#7a3b12', shirt: '#2f7dd1', skin: '#f2c9a0' },
  { hair: '#22222a', shirt: '#3aa66b', skin: '#d9a273' },
  { hair: '#c9a227', shirt: '#b8478f', skin: '#f6d7b8' },
  { hair: '#5b2a86', shirt: '#e0803a', skin: '#a8714a' },
  { hair: '#a33b2a', shirt: '#3bb0b8', skin: '#f2c9a0' }
]

function hashString(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

function hex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value) ? value : fallback
}

/** Replaces `{{NAME}}` with values; unknown placeholders are left as written. */
export function fillPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => vars[name] ?? whole)
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
    throw new Error(`"${field}" debe ser una lista, por ejemplo [Read, Write]`)
  }
  return (value as string[]).map((t) => t.trim()).filter(Boolean)
}

function templates(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`"${field}" debe ser una lista "herramienta: texto" (por ejemplo Read: Leyendo {file_path})`)
  }
  const out: Record<string, string> = {}
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text !== 'string' && typeof text !== 'number') {
      throw new Error(`"${field}.${key}" debe ser un texto`)
    }
    out[key] = String(text)
  }
  return out
}

/**
 * Parses one agent.md file. Throws an Error with a human-readable reason when
 * the file cannot become an agent.
 */
export function parseAgentFile(
  content: string,
  folderName: string,
  /** Server names defined in mcp.json. */
  mcpServers: ReadonlySet<string> = new Set(),
  vars: Record<string, string> = {}
): AgentRecord {
  const { data, content: body } = matter(content)
  const id = String(data.id ?? folderName).trim()
  if (!ID_RE.test(id)) {
    throw new Error(`id inválido "${id}" (minúsculas, números y guiones; 2-32 caracteres)`)
  }
  if (id === BRAIN_ID) throw new Error(`"${BRAIN_ID}" está reservado para el Cerebro`)

  const description = fillPlaceholders(String(data.description ?? '').trim(), vars)
  if (!description) throw new Error('falta "description" (cuándo debe usarlo el Cerebro)')

  const prompt = fillPlaceholders(body.trim(), vars)
  if (!prompt) throw new Error('falta el cuerpo del archivo (instrucciones del agente)')

  let tools: string[] | undefined
  if (data.tools !== undefined) {
    tools = stringList(data.tools, 'tools')
    const unknown = tools.filter((t) => !(CANONICAL_TOOLS as readonly string[]).includes(t) && !t.startsWith('mcp__'))
    if (unknown.length) {
      throw new Error(`herramienta desconocida: ${unknown.join(', ')} (disponibles: ${CANONICAL_TOOLS.join(', ')})`)
    }
  }

  let mcp: string[] = []
  if (data.mcp !== undefined) {
    mcp = stringList(data.mcp, 'mcp')
    const unknown = mcp.filter((s) => !mcpServers.has(s))
    if (unknown.length) {
      const available = [...mcpServers].join(', ') || 'ninguno'
      throw new Error(`servidor mcp desconocido: ${unknown.join(', ')} (en mcp.json hay: ${available})`)
    }
  }

  const base = PALETTE[hashString(id) % PALETTE.length]
  const raw = (data.sprite ?? {}) as Record<string, unknown>
  const sprite: SpriteSpec = {
    hair: hex(raw.hair, base.hair),
    shirt: hex(raw.shirt, base.shirt),
    skin: hex(raw.skin, base.skin)
  }

  const name = String(data.name ?? id).trim()
  const role = String(data.role ?? '').trim()
  const zone = String(data.zona ?? data.zone ?? '').trim() || DEFAULT_ZONE
  const model = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : undefined
  const bubbles = templates(data.burbujas, 'burbujas')
  const permissions = templates(data.permisos, 'permisos')

  const spec: AgentSpec = { description, prompt, tools, mcp, model }
  if (bubbles) spec.bubbles = bubbles
  if (permissions) spec.permissions = permissions
  if (data.repos !== undefined) spec.repos = stringList(data.repos, 'repos')

  return {
    info: { id, name, role, description, sprite, zone },
    spec,
    builtin: false
  }
}

/** Folders starting with `_` or `.` are switched off. */
function isDisabled(folder: string): boolean {
  return folder.startsWith('_') || folder.startsWith('.')
}

/**
 * Reads every `<dir>/<folder>/agent.md` of each source, in order. Bad files are
 * reported, not fatal. On a repeated id the first source wins, so built-in
 * agents cannot be replaced by accident.
 */
export async function loadAgents(
  sources: AgentSource[],
  mcpServers: ReadonlySet<string> = new Set(),
  vars: Record<string, string> = {},
  /** Rules every agent gets after its own prompt (brain/estilo.md). */
  sharedRules = ''
): Promise<LoadResult> {
  const rules = fillPlaceholders(sharedRules.trim(), vars)
  const agents: AgentRecord[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const source of sources) {
    let folders: string[]
    try {
      const entries = await readdir(source.dir, { withFileTypes: true })
      folders = entries
        .filter((e) => e.isDirectory() && !isDisabled(e.name))
        .map((e) => e.name)
        .sort()
    } catch {
      errors.push(`No existe la carpeta de agentes: ${source.dir}`)
      continue
    }

    for (const folder of folders) {
      const file = join(source.dir, folder, 'agent.md')
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue // a folder without agent.md is simply not an agent
      }
      try {
        const record = parseAgentFile(content, folder, mcpServers, vars)
        if (seen.has(record.info.id)) throw new Error(`id duplicado "${record.info.id}"`)
        seen.add(record.info.id)
        if (rules) record.spec.prompt = `${record.spec.prompt}\n\n${rules}`
        agents.push({ ...record, builtin: source.builtin })
      } catch (err) {
        errors.push(`${folder}/agent.md: ${(err as Error).message}`)
      }
    }
  }
  return { agents, errors }
}

/**
 * Roster text injected into the brain's system prompt. Switched-off agents are
 * only named, so the brain can tell the user to switch them on.
 */
export function rosterText(agents: AgentRecord[]): string {
  const enabled = agents.filter((a) => !a.info.disabled)
  const off = agents.filter((a) => a.info.disabled)
  const lines = enabled.length
    ? enabled.map((a) => {
        const role = a.info.role ? ` — ${a.info.role}` : ''
        return `- "${a.info.id}": ${a.info.name}${role}. ${a.info.description}`
      })
    : ['(No hay agentes disponibles; responde tú mismo.)']
  if (off.length) {
    const names = off.map((a) => `${a.info.name}${a.info.role ? ` (${a.info.role})` : ''}`).join(', ')
    lines.push(
      '',
      `Desactivados por el usuario (no puedes usarlos; si uno hace falta, dile que lo active pulsando sobre él en la oficina): ${names}.`
    )
  }
  return lines.join('\n')
}
