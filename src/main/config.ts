import { readFile, rename, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ProviderId } from '@shared/types'

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
    .optional()
})

export function defaultConfig(): AppConfig {
  return {
    provider: 'claude',
    userName: '',
    models: {
      // Tiers used by agents and delegations: cheapest model that does the job.
      claude: { brain: 'sonnet', aliases: { rapido: 'haiku', normal: 'sonnet', potente: 'opus' } },
      copilot: { brain: '', aliases: {} }
    }
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
    models: { claude: models('claude'), copilot: models('copilot') }
  }
}

export interface ConfigLoad {
  config: AppConfig
  error?: string
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
    return { config: parseConfig(JSON.parse(text)) }
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
