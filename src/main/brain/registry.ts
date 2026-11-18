import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { BRAIN_ID, type AgentInfo, type SpriteSpec } from '@shared/types'

export interface AgentRecord {
  info: AgentInfo
  definition: AgentDefinition
}

export interface LoadResult {
  agents: AgentRecord[]
  errors: string[]
}

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

/**
 * Parses one agent.md file. Throws an Error with a human-readable reason when
 * the file cannot become an agent.
 */
export function parseAgentFile(
  content: string,
  folderName: string,
  /** Built-in tool servers an agent may ask for with `mcp: [name]`: server name -> full tool names. */
  mcpTools: Record<string, string[]> = {}
): AgentRecord {
  const { data, content: body } = matter(content)
  const id = String(data.id ?? folderName).trim()
  if (!ID_RE.test(id)) {
    throw new Error(`id inválido "${id}" (minúsculas, números y guiones; 2-32 caracteres)`)
  }
  if (id === BRAIN_ID) throw new Error(`"${BRAIN_ID}" está reservado para el Cerebro`)

  const description = String(data.description ?? '').trim()
  if (!description) throw new Error('falta "description" (cuándo debe usarlo el Cerebro)')

  const prompt = body.trim()
  if (!prompt) throw new Error('falta el cuerpo del archivo (instrucciones del agente)')

  let tools: string[] | undefined
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.some((t) => typeof t !== 'string')) {
      throw new Error('"tools" debe ser una lista de nombres de herramienta')
    }
    tools = data.tools as string[]
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

  let servers: string[] = []
  if (data.mcp !== undefined) {
    if (!Array.isArray(data.mcp) || data.mcp.some((s) => typeof s !== 'string')) {
      throw new Error('"mcp" debe ser una lista de nombres de servidor')
    }
    servers = data.mcp as string[]
    const unknown = servers.filter((s) => !mcpTools[s])
    if (unknown.length) {
      const available = Object.keys(mcpTools).join(', ') || 'ninguno'
      throw new Error(`servidor mcp desconocido: ${unknown.join(', ')} (disponibles: ${available})`)
    }
  }

  const definition: AgentDefinition = { description, prompt }
  // With no `tools` list the agent inherits everything, server tools included.
  if (tools) definition.tools = [...tools, ...servers.flatMap((s) => mcpTools[s])]
  if (servers.length) definition.mcpServers = servers
  if (typeof data.model === 'string' && data.model.trim()) definition.model = data.model.trim()

  return { info: { id, name, role, description, sprite }, definition }
}

/** Reads every `<agentsDir>/<folder>/agent.md`. Bad files are reported, not fatal. */
export async function loadAgents(
  agentsDir: string,
  mcpTools: Record<string, string[]> = {}
): Promise<LoadResult> {
  const agents: AgentRecord[] = []
  const errors: string[] = []
  let folders: string[] = []
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true })
    folders = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return { agents, errors: [`No existe la carpeta de agentes: ${agentsDir}`] }
  }

  const seen = new Set<string>()
  for (const folder of folders) {
    const file = join(agentsDir, folder, 'agent.md')
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      continue // folder without agent.md is simply not an agent
    }
    try {
      const record = parseAgentFile(content, folder, mcpTools)
      if (seen.has(record.info.id)) throw new Error(`id duplicado "${record.info.id}"`)
      seen.add(record.info.id)
      agents.push(record)
    } catch (err) {
      errors.push(`${folder}/agent.md: ${(err as Error).message}`)
    }
  }
  return { agents, errors }
}

/** Roster text injected into the brain's system prompt. */
export function rosterText(agents: AgentRecord[]): string {
  if (agents.length === 0) return '(No hay agentes disponibles; responde tú mismo.)'
  return agents
    .map((a) => {
      const role = a.info.role ? ` — ${a.info.role}` : ''
      return `- subagent_type "${a.info.id}": ${a.info.name}${role}. ${a.info.description}`
    })
    .join('\n')
}
