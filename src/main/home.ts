import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's own folder, outside the repo: their agents, config, MCP servers,
 * memory and workspace. Everything here can change without touching code.
 */
export interface HomePaths {
  root: string
  configFile: string
  mcpFile: string
  memoryFile: string
  agentsDir: string
  workspaceDir: string
  inboxDir: string
  outputDir: string
}

export function defaultHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CESAR_BRAIN_HOME?.trim()
  return custom || join(homedir(), 'CesarBrain')
}

export function homePaths(root: string): HomePaths {
  const workspaceDir = join(root, 'workspace')
  return {
    root,
    configFile: join(root, 'config.json'),
    mcpFile: join(root, 'mcp.json'),
    memoryFile: join(root, 'memory.md'),
    agentsDir: join(root, 'agents'),
    workspaceDir,
    inboxDir: join(workspaceDir, 'inbox'),
    outputDir: join(workspaceDir, 'output')
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  if (!(await exists(file))) await writeFile(file, content, 'utf8')
}

export const DEFAULT_CONFIG = {
  provider: 'claude',
  userName: '',
  models: {
    claude: { brain: 'sonnet', aliases: { rapido: 'haiku', normal: 'sonnet', potente: 'opus' } },
    // Fill with the model ids your Copilot plan offers (see /model in Copilot CLI).
    copilot: { brain: '', aliases: { rapido: '', normal: '', potente: '' } }
  }
}

const DEFAULT_MEMORY = `<!-- Preferencias duraderas para el Cerebro. Escribe aquí lo que siempre debe tener en cuenta. -->
`

/**
 * Creates the home folder on first run. The example agents are copied only
 * when the agents folder does not exist yet, so deleting every agent later
 * does not bring the examples back.
 */
export async function ensureHome(paths: HomePaths, examplesAgentsDir: string): Promise<void> {
  const seed = !(await exists(paths.agentsDir))
  await Promise.all([paths.inboxDir, paths.outputDir, paths.agentsDir].map((d) => mkdir(d, { recursive: true })))
  if (seed && (await exists(examplesAgentsDir))) {
    await cp(examplesAgentsDir, paths.agentsDir, { recursive: true, errorOnExist: false, force: false })
  }
  await writeIfMissing(paths.configFile, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
  await writeIfMissing(paths.mcpFile, JSON.stringify({ servers: {} }, null, 2) + '\n')
  await writeIfMissing(paths.memoryFile, DEFAULT_MEMORY)
}
