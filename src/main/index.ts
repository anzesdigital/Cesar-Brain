import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import chokidar from 'chokidar'
import { SKINS, type AppStatus, type IncomingFile, type ProviderId, type RepoStatus, type SkinId } from '@shared/types'
import { BrainOrchestrator } from './brain/orchestrator'
import { isInside, PermissionGate } from './brain/permissions'
import { ClaudeProvider } from './brain/providers/claude'
import { CopilotProvider } from './brain/providers/copilot'
import { COPILOT_MISSING } from './brain/providers/toolmap'
import type { BrainProvider } from './brain/providers/types'
import { CANONICAL_TOOLS, loadAgents, type AgentRecord } from './brain/registry'
import { SessionStore } from './brain/sessions'
import { UsageStore } from './brain/usage'
import { defaultConfig, loadConfig, readRawConfig, updateConfigFile, updateReposInFile, type AppConfig } from './config'
import { defaultHomeDir, ensureHome, homePaths } from './home'
import { emptyCatalog, loadMcp, type McpCatalog } from './mcp'
import { agentReposText, REPO_NAME_RE, reposFor, usesFiles } from './repos'

const here = dirname(fileURLToPath(import.meta.url))

// Shipped with the app: the brain prompt, built-in agents and examples.
const appRoot = app.getAppPath()
const brainDir = join(appRoot, 'brain')
const builtinAgentsDir = join(brainDir, 'agents')
const examplesAgentsDir = join(appRoot, 'examples', 'agents')

// The user's own folder: agents, config, MCP servers, memory, workspace.
const home = homePaths(defaultHomeDir())

// Private app state.
const keyFile = join(app.getPath('userData'), 'api-key.bin')

let win: BrowserWindow | undefined
let agents: AgentRecord[] = []
let mcp: McpCatalog = emptyCatalog()
let config: AppConfig = defaultConfig()
let problems: string[] = []
let repoStatus: RepoStatus[] = []
let apiKey: string | undefined

const providers: Record<ProviderId, BrainProvider> = {
  claude: new ClaudeProvider(() => apiKey),
  copilot: new CopilotProvider()
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Warnings that only matter for the chosen provider. */
function providerWarnings(): string[] {
  if (config.provider !== 'copilot') return []
  return agents.flatMap((a) => {
    const missing = (a.spec.tools ?? []).filter((t) => COPILOT_MISSING.has(t))
    return missing.length ? [`${a.info.id}: con Copilot no existe ${missing.join(', ')}; usará solo el resto.`] : []
  })
}

/** Re-reads config.json, mcp.json and every agent.md. */
async function reload(): Promise<void> {
  const loaded = await loadConfig(home.configFile)
  config = loaded.config
  mcp = await loadMcp(home.mcpFile)
  const mcpList = Object.keys(mcp.servers)
  const sharedRules = await readFile(join(brainDir, 'estilo.md'), 'utf8').catch(() => '')
  const result = await loadAgents(
    [
      { dir: builtinAgentsDir, builtin: true },
      { dir: home.agentsDir, builtin: false }
    ],
    new Set(mcpList),
    {
      AGENTS_DIR: home.agentsDir,
      MCP_SERVERS: mcpList.length ? mcpList.join(', ') : '(ninguno; se añaden en mcp.json)',
      MCP_FILE: home.mcpFile,
      TOOLS: CANONICAL_TOOLS.join(', '),
      USER: config.userName || 'el usuario',
      REPOS: config.repos.length ? config.repos.map((r) => r.name).join(', ') : '(ninguno; se añaden en Ajustes)'
    },
    sharedRules
  )
  agents = result.agents
  const disabled = new Set(config.disabledAgents)
  for (const agent of agents) if (disabled.has(agent.info.id)) agent.info.disabled = true

  // Repos: tell each agent that works with files which ones it may use.
  const repoNames = new Set(config.repos.map((r) => r.name))
  const repoProblems: string[] = []
  for (const agent of agents) {
    const unknown = (agent.spec.repos ?? []).filter((n) => !repoNames.has(n))
    if (unknown.length) repoProblems.push(`${agent.info.id}: repos que no existen en config.json: ${unknown.join(', ')}`)
    if (!usesFiles(agent.spec.tools)) continue
    const text = agentReposText(reposFor(config.repos, agent.spec.repos))
    if (text) agent.spec.prompt = `${agent.spec.prompt}\n\n${text}`
  }
  repoStatus = await Promise.all(
    config.repos.map(async (r) => ({
      name: r.name,
      path: r.path,
      write: r.write,
      exists: await stat(r.path).then((s) => s.isDirectory()).catch(() => false)
    }))
  )
  for (const r of repoStatus) if (!r.exists) repoProblems.push(`repo "${r.name}": no existe la carpeta ${r.path}`)

  problems = [
    ...(loaded.error ? [loaded.error] : []),
    ...(loaded.warnings ?? []),
    ...mcp.errors,
    ...result.errors,
    ...repoProblems,
    ...providerWarnings()
  ]
  for (const p of problems) console.warn('[config]', p)
  send('agents', agents.map((a) => a.info))
  send('status', status())
}

let busy = (): boolean => false

function status(): AppStatus {
  return {
    hasApiKey: Boolean(apiKey),
    busy: busy(),
    provider: config.provider,
    skin: config.skin,
    homeDir: home.root,
    workspaceDir: home.workspaceDir,
    agentsDir: home.agentsDir,
    problems,
    repos: repoStatus
  }
}

async function loadApiKey(): Promise<void> {
  try {
    apiKey = safeStorage.decryptString(await readFile(keyFile))
  } catch {
    apiKey = undefined
  }
}

async function saveApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    apiKey = undefined
    await rm(keyFile, { force: true })
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('El sistema no ofrece cifrado para guardar la clave.')
  }
  await mkdir(dirname(keyFile), { recursive: true })
  await writeFile(keyFile, safeStorage.encryptString(trimmed))
  apiKey = trimmed
}

/** Copies an incoming file into workspace/inbox and returns its new path. */
async function receiveFile(file: IncomingFile): Promise<string> {
  const safeName = basename(file.name).replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'archivo'
  const target = join(home.inboxDir, `${Date.now()}-${safeName}`)
  if (file.path) await copyFile(file.path, target)
  else if (file.data) await writeFile(target, Buffer.from(file.data))
  else throw new Error(`No pude leer el archivo ${file.name}`)
  return target
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#1b1c2b',
    title: 'Cesar Brain',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // ESM preload scripts cannot run sandboxed
    }
  })

  // Links from agent answers open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (!devUrl || !url.startsWith(devUrl)) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(here, '../renderer/index.html'))
}

async function main(): Promise<void> {
  await app.whenReady()
  await ensureHome(home, examplesAgentsDir)
  await loadApiKey()

  const sessions = new SessionStore(join(app.getPath('userData'), 'session.json'))
  await sessions.load()
  const usage = new UsageStore(join(app.getPath('userData'), 'usage.json'))
  await usage.load()
  const gate = new PermissionGate((request) => send('permission', request))
  const brain = new BrainOrchestrator(
    {
      workspaceDir: home.workspaceDir,
      brainPromptFile: join(brainDir, 'brain.md'),
      memoryFile: home.memoryFile,
      readableDirs: [home.agentsDir, builtinAgentsDir],
      getAgents: () => agents,
      getMcp: () => mcp,
      getConfig: () => config,
      getProvider: () => providers[config.provider],
      usage
    },
    sessions,
    gate,
    {
      thought: (event) => send('thought', event),
      delta: (text) => send('delta', text),
      message: (message) => send('message', message),
      busy: (isBusy) => send('busy', isBusy),
      usage: (snapshot) => send('usage', snapshot)
    }
  )
  busy = () => brain.busy

  await reload()
  let reloadTimer: NodeJS.Timeout | undefined
  chokidar
    .watch([home.agentsDir, home.configFile, home.mcpFile, builtinAgentsDir, join(brainDir, 'estilo.md')], {
      ignoreInitial: true,
      depth: 2
    })
    .on('all', () => {
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => void reload(), 300)
    })

  ipcMain.handle('agents:get', () => agents.map((a) => a.info))
  ipcMain.handle('history:get', () => sessions.messages)
  ipcMain.handle('usage:get', () => usage.snapshot())
  ipcMain.handle('status:get', () => status())
  ipcMain.handle('provider:check', () => providers[config.provider].auth())
  ipcMain.handle('repos:add', async () => {
    const options = { title: 'Elige la carpeta del repositorio', properties: ['openDirectory' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const folder = picked.filePaths[0]
    if (picked.canceled || !folder) return undefined
    let added: string | undefined
    await updateReposInFile(home.configFile, (repos) => {
      const base = basename(folder).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'repo'
      let name = base
      for (let i = 2; repos[name]; i++) name = `${base}-${i}`
      // New repos start read-only; write access is a deliberate choice.
      repos[name] = { ruta: folder.replace(/\\/g, '/'), acceso: 'lectura' }
      added = name
    })
    await reload()
    return added
  })
  ipcMain.handle('repos:access', async (_e, name: string, write: boolean) => {
    if (!REPO_NAME_RE.test(String(name))) return
    await updateReposInFile(home.configFile, (repos) => {
      if (repos[name]) repos[name] = { ...repos[name], acceso: write === true ? 'escritura' : 'lectura' }
    })
    await reload()
  })
  ipcMain.handle('repos:remove', async (_e, name: string) => {
    await updateReposInFile(home.configFile, (repos) => {
      delete repos[String(name)]
    })
    await reload()
  })
  ipcMain.handle('agents:enabled', async (_e, id: string, enabled: boolean) => {
    const agentId = String(id)
    if (!agents.some((a) => a.info.id === agentId)) throw new Error(`Agente desconocido: ${agentId}`)
    // Read the list as written, so ids of agents that are missing right now are kept.
    const raw = await readRawConfig(home.configFile)
    const current = Array.isArray(raw.disabledAgents)
      ? raw.disabledAgents.filter((x): x is string => typeof x === 'string')
      : []
    const next = enabled === true ? current.filter((x) => x !== agentId) : [...new Set([...current, agentId])]
    await updateConfigFile(home.configFile, { disabledAgents: next })
    await reload()
  })
  ipcMain.handle('skin:set', async (_e, skin: SkinId) => {
    if (!Object.hasOwn(SKINS, skin)) throw new Error(`Aspecto desconocido: ${String(skin)}`)
    if (skin === config.skin) return
    await updateConfigFile(home.configFile, { skin })
    await reload()
  })
  ipcMain.handle('provider:set', async (_e, provider: ProviderId) => {
    if (provider !== 'claude' && provider !== 'copilot') throw new Error(`Proveedor desconocido: ${String(provider)}`)
    if (provider === config.provider) return
    if (brain.busy) throw new Error('Espera a que el Cerebro termine antes de cambiar de proveedor.')
    await updateConfigFile(home.configFile, { provider })
    // A conversation cannot move between providers.
    await sessions.reset()
    await usage.clearLimits()
    send('reset', null)
    send('usage', usage.snapshot())
    await reload()
  })
  ipcMain.handle('brain:send', async (_e, prompt: string, files: IncomingFile[]) => {
    const text = String(prompt ?? '').trim()
    if (!text && files.length === 0) return
    const paths = await Promise.all(files.map(receiveFile))
    // Not awaited: progress and the final answer arrive as events.
    void brain.run(text || 'Revisa los archivos adjuntos.', paths).catch((err) => {
      console.error('[cerebro]', err)
    })
  })
  ipcMain.handle('brain:stop', () => brain.stop())
  ipcMain.handle('brain:new', async () => {
    brain.stop()
    await sessions.reset()
  })
  ipcMain.handle('apikey:set', (_e, key: string) => saveApiKey(String(key ?? '')))
  ipcMain.handle('permission:respond', (_e, id: string, allow: boolean) => gate.respond(id, allow === true))
  ipcMain.handle('path:open', async (_e, target: string) => {
    // Only folders the app owns can be opened from the UI.
    if (isInside(target, home.root)) await shell.openPath(target)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  void Promise.all(Object.values(providers).map((p) => p.dispose?.()))
})

void main()
