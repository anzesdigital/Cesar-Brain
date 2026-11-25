import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import matter from 'gray-matter'
import type { AutomationInfo, AutomationStepInfo } from '@shared/types'
import { CANONICAL_TOOLS, fillPlaceholders } from '../brain/registry'

/**
 * An automation is a folder with an automation.md, like an agent: no code.
 * It runs by itself (every X time, at start-up, when files change, before the
 * brain hands work to an agent, or by hand) and chains commands and agents.
 */

export interface CommandStep {
  kind: 'comando'
  name: string
  command: string
  /** Name of a config.json repo to run in. */
  repo?: string
  /** Folder inside the workspace to run in (relative). */
  folder?: string
  timeoutMs: number
}

export interface AgentStep {
  kind: 'agente'
  name: string
  agent: string
  /** Task for the agent; `{salida}` becomes the previous step's output. */
  task: string
  /** Model tier or id for this step only. */
  model?: string
  timeoutMs: number
}

export type Step = CommandStep | AgentStep

/** Folder watched by an `archivos` trigger. */
export interface WatchTarget {
  repo?: string
  /** Relative to the workspace. */
  folder?: string
}

export interface AutomationSpec {
  id: string
  name: string
  description: string
  /** `cada`: interval in ms. */
  everyMs?: number
  onStartup: boolean
  watch?: WatchTarget
  /** Runs before the brain hands a job to any of these agents. */
  beforeAgents: string[]
  steps: Step[]
  /** Tools agent steps may use without asking (canonical names or mcp__server). */
  allow: string[]
  onFailure: 'parar' | 'seguir'
  color: string
  notes: string
  /** sha256 of the file; approval is tied to it. */
  hash: string
  dir: string
}

export interface ParseContext {
  /** Ids of every loaded agent. */
  agentIds: ReadonlySet<string>
  /** Names of config.json repos. */
  repoNames: ReadonlySet<string>
  vars?: Record<string, string>
}

const ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const MIN_INTERVAL_MS = 60_000
const DEFAULT_COMMAND_TIMEOUT_S = 120
const DEFAULT_AGENT_TIMEOUT_S = 900
const MAX_TIMEOUT_S = 3600
const COLORS = ['#3aa6b8', '#58c98b', '#e0a03a', '#8a5ad8', '#d9659a', '#7b86b8']

const UNITS: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }

/** "30m", "2h", "1d", "90s" -> ms. Throws on anything else. */
export function parseDuration(value: unknown): number {
  const text = String(value ?? '').trim().toLowerCase()
  const match = /^(\d+(?:[.,]\d+)?)\s*(s|m|min|h|d)$/.exec(text)
  if (!match) throw new Error(`"${text}" no es una duración (usa por ejemplo 30m, 2h, 1d)`)
  return Math.round(Number(match[1].replace(',', '.')) * UNITS[match[2]])
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`
  if (ms % 60_000 === 0) return `${ms / 60_000} min`
  return `${Math.round(ms / 1000)} s`
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') return [value.trim()].filter(Boolean)
  if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) {
    throw new Error(`"${field}" debe ser una lista, por ejemplo [dev, tester]`)
  }
  return (value as string[]).map((t) => t.trim()).filter(Boolean)
}

/** A folder inside the workspace, written relative; nothing outside it. */
function workspaceFolder(value: string, field: string): string {
  const folder = normalize(value.replace(/\\/g, '/')).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!folder || folder === '.' || isAbsolute(value) || folder.startsWith('..')) {
    throw new Error(`"${field}": "${value}" debe ser una carpeta dentro del directorio de trabajo (por ejemplo inbox)`)
  }
  return folder
}

function timeout(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback * 1000
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_TIMEOUT_S) {
    throw new Error(`"${field}" debe ser un número de segundos entre 1 y ${MAX_TIMEOUT_S}`)
  }
  return Math.round(n * 1000)
}

function parseWatch(value: unknown, repoNames: ReadonlySet<string>): WatchTarget | undefined {
  if (value === undefined || value === null || value === false) return undefined
  const text = String(value).trim()
  if (!text) return undefined
  if (text.startsWith('repo:')) {
    const repo = text.slice(5).trim()
    if (!repoNames.has(repo)) throw new Error(`"cuando.archivos": el repo "${repo}" no está en config.json`)
    return { repo }
  }
  return { folder: workspaceFolder(text, 'cuando.archivos') }
}

function parseStep(raw: unknown, index: number, ctx: ParseContext): Step {
  const where = `pasos[${index + 1}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where}: cada paso es "comando: …" o "agente: …"`)
  }
  const step = raw as Record<string, unknown>
  const name = typeof step.nombre === 'string' && step.nombre.trim() ? step.nombre.trim() : undefined
  if (step.comando !== undefined && step.agente !== undefined) {
    throw new Error(`${where}: un paso es o "comando" o "agente", no los dos`)
  }
  if (typeof step.comando === 'string') {
    const command = step.comando.trim()
    if (!command) throw new Error(`${where}: "comando" está vacío`)
    const result: CommandStep = {
      kind: 'comando',
      name: name ?? command.slice(0, 40),
      command,
      timeoutMs: timeout(step.timeout, DEFAULT_COMMAND_TIMEOUT_S, `${where}.timeout`)
    }
    if (step.repo !== undefined && step.carpeta !== undefined) {
      throw new Error(`${where}: usa "repo" o "carpeta", no los dos`)
    }
    if (step.repo !== undefined) {
      const repo = String(step.repo).trim()
      if (!ctx.repoNames.has(repo)) throw new Error(`${where}: el repo "${repo}" no está en config.json`)
      result.repo = repo
    } else if (step.carpeta !== undefined) {
      result.folder = workspaceFolder(String(step.carpeta), `${where}.carpeta`)
    }
    return result
  }
  if (typeof step.agente === 'string') {
    const agent = step.agente.trim()
    if (!ctx.agentIds.has(agent)) throw new Error(`${where}: no existe el agente "${agent}"`)
    const task = fillPlaceholders(String(step.encargo ?? '').trim(), ctx.vars ?? {})
    if (!task) throw new Error(`${where}: falta "encargo" (qué debe hacer ${agent})`)
    const result: AgentStep = {
      kind: 'agente',
      name: name ?? `Encargo a ${agent}`,
      agent,
      task,
      timeoutMs: timeout(step.timeout, DEFAULT_AGENT_TIMEOUT_S, `${where}.timeout`)
    }
    if (typeof step.modelo === 'string' && step.modelo.trim()) result.model = step.modelo.trim()
    return result
  }
  throw new Error(`${where}: cada paso es "comando: …" o "agente: …"`)
}

function colorFor(id: string, raw: unknown): string {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).body : raw
  if (typeof body === 'string' && HEX_RE.test(body)) return body
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

/** Parses one automation.md. Throws with a human-readable reason. */
export function parseAutomationFile(content: string, folderName: string, dir: string, ctx: ParseContext): AutomationSpec {
  const { data, content: body } = matter(content)
  const id = String(data.id ?? folderName).trim()
  if (!ID_RE.test(id)) throw new Error(`id inválido "${id}" (minúsculas, números y guiones; 2-32 caracteres)`)

  const name = String(data.name ?? data.nombre ?? id).trim() || id
  const description = fillPlaceholders(String(data.description ?? data.descripcion ?? '').trim(), ctx.vars ?? {})

  const when = (data.cuando ?? {}) as Record<string, unknown>
  if (typeof when !== 'object' || Array.isArray(when)) throw new Error('"cuando" debe ser una lista de disparadores')
  let everyMs: number | undefined
  if (when.cada !== undefined && when.cada !== null) {
    everyMs = parseDuration(when.cada)
    if (everyMs < MIN_INTERVAL_MS) throw new Error('"cuando.cada" debe ser de al menos 1m')
  }
  const onStartup = when['al-arrancar'] === true || when.arranque === true
  const watch = parseWatch(when.archivos, ctx.repoNames)
  const beforeAgents = stringList(when.agente ?? when.agentes, 'cuando.agente')
  const unknownAgents = beforeAgents.filter((a) => !ctx.agentIds.has(a))
  if (unknownAgents.length) throw new Error(`"cuando.agente": no existe ${unknownAgents.join(', ')}`)

  if (!Array.isArray(data.pasos) || data.pasos.length === 0) {
    throw new Error('faltan "pasos" (lista de comando: … o agente: …)')
  }
  const steps = (data.pasos as unknown[]).map((s, i) => parseStep(s, i, ctx))

  const allow = stringList(data.permitir, 'permitir')
  const badAllow = allow.filter((t) => !(CANONICAL_TOOLS as readonly string[]).includes(t) && !t.startsWith('mcp__'))
  if (badAllow.length) {
    throw new Error(`"permitir": herramienta desconocida ${badAllow.join(', ')} (disponibles: ${CANONICAL_TOOLS.join(', ')})`)
  }

  const onFailureRaw = String(data['si-falla'] ?? 'parar').trim()
  if (onFailureRaw !== 'parar' && onFailureRaw !== 'seguir') throw new Error('"si-falla" debe ser parar o seguir')

  return {
    id,
    name,
    description,
    everyMs,
    onStartup,
    watch,
    beforeAgents,
    steps,
    allow,
    onFailure: onFailureRaw,
    color: colorFor(id, data.sprite),
    notes: body.trim(),
    hash: hashContent(content),
    dir
  }
}

/** YAML's own messages are cryptic; the usual cause is a text with ": " and no quotes. */
export function yamlHint(message: string): string {
  if (!/mapping pair|bad indentation|can not read|unexpected end/i.test(message)) return message
  const first = message.split('\n')[0]
  return `${first} (suele ser un texto con «: » sin comillas: escríbelo entre comillas "…")`
}

export interface AutomationLoad {
  automations: AutomationSpec[]
  errors: string[]
}

/** Reads every `<dir>/<folder>/automation.md`. Bad files are reported, not fatal. */
export async function loadAutomations(dir: string, ctx: ParseContext): Promise<AutomationLoad> {
  const automations: AutomationSpec[] = []
  const errors: string[] = []
  let folders: string[]
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return { automations, errors }
  }
  const seen = new Set<string>()
  for (const folder of folders) {
    const file = join(dir, folder, 'automation.md')
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch {
      continue
    }
    try {
      const spec = parseAutomationFile(content, folder, join(dir, folder), ctx)
      if (seen.has(spec.id)) throw new Error(`id duplicado "${spec.id}"`)
      seen.add(spec.id)
      automations.push(spec)
    } catch (err) {
      errors.push(`automations/${folder}/automation.md: ${yamlHint((err as Error).message)}`)
    }
  }
  return { automations, errors }
}

/** Triggers in words, for the UI. */
export function triggerTexts(spec: AutomationSpec): string[] {
  const out: string[] = []
  if (spec.everyMs) out.push(`cada ${formatDuration(spec.everyMs)}`)
  if (spec.onStartup) out.push('al arrancar')
  if (spec.watch) out.push(`al cambiar ${spec.watch.repo ? `el repo ${spec.watch.repo}` : spec.watch.folder}`)
  if (spec.beforeAgents.length) out.push(`antes de encargos a ${spec.beforeAgents.join(', ')}`)
  out.push('manual')
  return out
}

export function stepInfos(spec: AutomationSpec): AutomationStepInfo[] {
  return spec.steps.map((s) =>
    s.kind === 'comando'
      ? {
          kind: s.kind,
          name: s.name,
          detail: s.command,
          where: s.repo ? `repo ${s.repo}` : s.folder ? `workspace/${s.folder}` : 'workspace'
        }
      : { kind: s.kind, name: s.name, detail: s.task, where: s.agent }
  )
}

export function baseInfo(spec: AutomationSpec): Omit<AutomationInfo, 'enabled' | 'needsApproval' | 'running' | 'lastRun' | 'nextRunAt'> {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    triggers: triggerTexts(spec),
    steps: stepInfos(spec),
    allow: spec.allow,
    onFailure: spec.onFailure,
    color: spec.color,
    dir: spec.dir
  }
}
