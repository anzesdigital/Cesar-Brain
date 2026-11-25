import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { SKINS, type NotificationSettings, type NotificationSound, type ProviderId, type SkinId } from '@shared/types'
import { DEFAULT_RESUME_MAX_TOKENS } from './brain/resume'
import { parseRepos, type Repo } from './repos'

/** Model names for one provider. */
export interface ProviderModels {
  /** Model for the brain; empty = provider default. Claude defaults to sonnet. */
  brain: string
  /** Agent `model:` aliases -> real model id for this provider. */
  aliases: Record<string, string>
}

export interface AppConfig {
  provider: ProviderId
  /** How the brain and agents call the user. */
  userName: string
  models: Record<ProviderId, ProviderModels>
  /** Local code repositories agents may work in. */
  repos: Repo[]
  /** Looks of the app. */
  skin: SkinId
  /** Agent ids the user switched off; the brain does not see them. */
  disabledAgents: string[]
  /** Above this estimated size, an old conversation resumes from a summary. */
  resumeMaxTokens: number
  /** Windows notifications when the brain waits for the user or finishes. */
  notifications: NotificationSettings
}

const modelsSchema = z
  .object({
    brain: z.string().optional(),
    aliases: z.record(z.string(), z.string()).optional()
  })
  .optional()

const configSchema = z.object({
  provider: z.enum(['claude', 'copilot']).optional(),
  userName: z.string().optional(),
  models: z
    .object({
      claude: modelsSchema,
      copilot: modelsSchema
    })
    .optional(),
  // Checked entry by entry in parseRepos, so one bad repo does not break the file.
  repos: z.unknown().optional(),
  // An unknown skin only falls back to the default, see skinOf.
  skin: z.unknown().optional(),
  // Anything that is not a list of ids is ignored, see disabledOf.
  disabledAgents: z.unknown().optional(),
  resumeMaxTokens: z.number().int().min(0).optional(),
  // Bad values fall back to the defaults, see notificationsOf.
  notifications: z.unknown().optional()
})

const SOUNDS: NotificationSound[] = ['sistema', 'ninguno', 'personalizado']

function notificationsOf(raw: unknown): NotificationSettings {
  const base: NotificationSettings = { enabled: true, sound: 'sistema' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const value = raw as Record<string, unknown>
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : base.enabled,
    sound: SOUNDS.includes(value.sound as NotificationSound) ? (value.sound as NotificationSound) : base.sound
  }
}

function disabledOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
}

function isSkin(value: unknown): value is SkinId {
  return typeof value === 'string' && Object.hasOwn(SKINS, value)
}

/** Problem with the `skin` key, if any. */
function skinWarning(raw: unknown): string | undefined {
  if (raw === undefined || isSkin(raw)) return undefined
  return `config.json: skin "${String(raw)}" no existe (usa ${Object.keys(SKINS).join(' o ')}); se usa la clásica.`
}

export function defaultConfig(): AppConfig {
  return {
    provider: 'claude',
    userName: '',
    models: {
      // Tiers used by agents and delegations: cheapest model that does the job.
      claude: { brain: 'sonnet', aliases: { rapido: 'haiku', normal: 'sonnet', potente: 'opus' } },
      copilot: { brain: '', aliases: {} }
    },
    repos: [],
    skin: 'clasica',
    disabledAgents: [],
    resumeMaxTokens: DEFAULT_RESUME_MAX_TOKENS,
    notifications: { enabled: true, sound: 'sistema' }
  }
}

/** Fills defaults; throws with a readable reason when the shape is wrong. */
export function parseConfig(raw: unknown): AppConfig {
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`config.json: ${issue.path.join('.') || '(raíz)'}: ${issue.message}`)
  }
  const data = result.data
  const base = defaultConfig()
  const models = (id: ProviderId): ProviderModels => ({
    brain: data.models?.[id]?.brain?.trim() ?? base.models[id].brain,
    aliases: { ...base.models[id].aliases, ...(data.models?.[id]?.aliases ?? {}) }
  })
  return {
    provider: data.provider ?? base.provider,
    userName: data.userName?.trim() ?? '',
    models: { claude: models('claude'), copilot: models('copilot') },
    repos: parseRepos(data.repos).repos,
    skin: isSkin(data.skin) ? data.skin : base.skin,
    disabledAgents: disabledOf(data.disabledAgents),
    resumeMaxTokens: data.resumeMaxTokens ?? base.resumeMaxTokens,
    notifications: notificationsOf(data.notifications)
  }
}

export interface ConfigLoad {
  config: AppConfig
  error?: string
  /** Entries that were skipped (e.g. a bad repo). */
  warnings?: string[]
}

/** Reads config.json. A missing or broken file falls back to defaults and says why. */
export async function loadConfig(file: string): Promise<ConfigLoad> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { config: defaultConfig() }
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null
    const skin = skinWarning(raw?.skin)
    const warnings = [...parseRepos(raw?.repos).errors, ...(skin ? [skin] : [])]
    return { config: parseConfig(raw), ...(warnings.length ? { warnings } : {}) }
  } catch (err) {
    const reason = err instanceof SyntaxError ? `config.json no es JSON válido (${err.message})` : (err as Error).message
    return { config: defaultConfig(), error: reason }
  }
}

/**
 * Changes some top-level keys of config.json, keeping everything else the user
 * wrote (unknown keys included). Written through a temp file so a crash never
 * leaves half a file.
 */
export async function updateConfigFile(file: string, patch: Record<string, unknown>): Promise<void> {
  let current: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>
  } catch {
    // missing or broken: start from the patch alone
  }
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

/** Reads config.json as written (unknown keys included); {} when missing or broken. */
export async function readRawConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // missing or broken
  }
  return {}
}

/** Edits the `repos` object of config.json, keeping everything else. */
export async function updateReposInFile(
  file: string,
  change: (repos: Record<string, { ruta: string; acceso: string }>) => void
): Promise<void> {
  const raw = await readRawConfig(file)
  const repos =
    raw.repos && typeof raw.repos === 'object' && !Array.isArray(raw.repos)
      ? { ...(raw.repos as Record<string, { ruta: string; acceso: string }>) }
      : {}
  change(repos)
  await updateConfigFile(file, { repos })
}

// Claude aliases and tier names Copilot does not understand on their own.
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable', 'inherit', 'rapido', 'normal', 'potente'])

/**
 * Turns an agent's `model:` value into what the provider understands.
 * Configured aliases win. Claude understands its own aliases; for Copilot an
 * unmapped Claude alias is dropped so the agent uses the session model.
 */
export function resolveModel(config: AppConfig, provider: ProviderId, model: string | undefined): string | undefined {
  const wanted = model?.trim()
  if (!wanted) return undefined
  const mapped = config.models[provider].aliases[wanted]?.trim()
  if (mapped) return mapped
  if (provider === 'copilot' && CLAUDE_ALIASES.has(wanted.toLowerCase())) return undefined
  return wanted
}
