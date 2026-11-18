import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import chokidar from 'chokidar'
import type { AppStatus, IncomingFile } from '@shared/types'
import { BrainOrchestrator } from './brain/orchestrator'
import { isInside, PermissionGate } from './brain/permissions'
import { loadAgents, type AgentRecord } from './brain/registry'
import { SessionStore } from './brain/sessions'
import { UsageStore } from './brain/usage'
import { createFinanceServer, FINANCE_APPROVAL_TOOLS, FINANCE_SERVER, FINANCE_TOOLS, financeToolName } from './finance/server'
import { FinanceService } from './finance/service'
import { GoogleSheets, parseCredentials, parseSpreadsheetId, type GoogleConfig } from './finance/sheets'
import { FinanceStore } from './finance/store'

const here = dirname(fileURLToPath(import.meta.url))

// In development everything lives in the project folder; a packaged app keeps
// its editable data next to the user's profile.
const dataRoot = app.isPackaged ? app.getPath('userData') : app.getAppPath()
const agentsDir = join(dataRoot, 'agents')
const brainDir = join(dataRoot, 'brain')
const workspaceDir = join(dataRoot, 'workspace')
const inboxDir = join(workspaceDir, 'inbox')
const outputDir = join(workspaceDir, 'output')
const keyFile = join(app.getPath('userData'), 'api-key.bin')
const googleFile = join(app.getPath('userData'), 'google.bin')

/** Built-in tool servers an agent.md can request with `mcp: [name]`. */
const MCP_TOOLS: Record<string, string[]> = { [FINANCE_SERVER]: FINANCE_TOOLS.map(financeToolName) }
const TRUSTED_TOOLS = new Set(
  FINANCE_TOOLS.filter((t) => !FINANCE_APPROVAL_TOOLS.includes(t)).map(financeToolName)
)

let win: BrowserWindow | undefined
let agents: AgentRecord[] = []
let apiKey: string | undefined
let google: GoogleConfig | undefined
let sheets: GoogleSheets | undefined

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function loadGoogle(): Promise<void> {
  try {
    google = JSON.parse(safeStorage.decryptString(await readFile(googleFile))) as GoogleConfig
    sheets = new GoogleSheets(google)
  } catch {
    google = undefined
    sheets = undefined
  }
}

/**
 * Connects the budget spreadsheet. The connection is tested before anything is
 * saved; returns the sheet titles found so the user can see it worked.
 */
async function connectGoogle(keyJson: string, url: string): Promise<string[]> {
  const credentials = keyJson.trim() ? parseCredentials(keyJson) : google?.credentials
  if (!credentials) throw new Error('Falta el archivo de clave de la cuenta de servicio.')
  const config: GoogleConfig = { credentials, spreadsheetId: parseSpreadsheetId(url) }
  const client = new GoogleSheets(config)
  const titles = (await client.listSheets()).map((s) => s.title)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('El sistema no ofrece cifrado para guardar la clave.')
  await mkdir(dirname(googleFile), { recursive: true })
  await writeFile(googleFile, safeStorage.encryptString(JSON.stringify(config)))
  google = config
  sheets = client
  return titles
}

async function disconnectGoogle(): Promise<void> {
  google = undefined
  sheets = undefined
  await rm(googleFile, { force: true })
}

async function reloadAgents(): Promise<void> {
  const result = await loadAgents(agentsDir, MCP_TOOLS)
  agents = result.agents
  for (const error of result.errors) console.warn('[agentes]', error)
  send('agents', agents.map((a) => a.info))
}

async function loadApiKey(): Promise<void> {
  try {
    const encrypted = await readFile(keyFile)
    apiKey = safeStorage.decryptString(encrypted)
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
  const target = join(inboxDir, `${Date.now()}-${safeName}`)
  if (file.path) await copyFile(file.path, target)
  else if (file.data) await writeFile(target, Buffer.from(file.data))
  else throw new Error(`No pude leer el archivo ${file.name}`)
  return target
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
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
  await Promise.all([inboxDir, outputDir, agentsDir, brainDir].map((d) => mkdir(d, { recursive: true })))
  await loadApiKey()
  await loadGoogle()

  const finance = new FinanceService(() => sheets, new FinanceStore(join(brainDir, 'finanzas')))
  const sessions = new SessionStore(join(app.getPath('userData'), 'session.json'))
  await sessions.load()
  const usage = new UsageStore(join(app.getPath('userData'), 'usage.json'))
  await usage.load()
  const gate = new PermissionGate((request) => send('permission', request))
  const brain = new BrainOrchestrator(
    {
      workspaceDir,
      brainPromptFile: join(brainDir, 'brain.md'),
      memoryFile: join(brainDir, 'memory.md'),
      getAgents: () => agents,
      getApiKey: () => apiKey,
      mcpServers: { [FINANCE_SERVER]: createFinanceServer(finance) },
      trustedTools: TRUSTED_TOOLS,
      usage
    },
    sessions,
    gate,
    {
      thought: (event) => send('thought', event),
      delta: (text) => send('delta', text),
      message: (message) => send('message', message),
      busy: (busy) => send('busy', busy),
      usage: (snapshot) => send('usage', snapshot)
    }
  )

  await reloadAgents()
  let reloadTimer: NodeJS.Timeout | undefined
  chokidar.watch(agentsDir, { ignoreInitial: true, depth: 1 }).on('all', () => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => void reloadAgents(), 300)
  })

  ipcMain.handle('agents:get', () => agents.map((a) => a.info))
  ipcMain.handle('history:get', () => sessions.messages)
  ipcMain.handle('usage:get', () => usage.snapshot())
  ipcMain.handle(
    'status:get',
    (): AppStatus => ({
      hasApiKey: Boolean(apiKey),
      busy: brain.busy,
      workspaceDir,
      agentsDir,
      google: google
        ? { connected: true, email: google.credentials.client_email, spreadsheetId: google.spreadsheetId }
        : { connected: false }
    })
  )
  ipcMain.handle('google:connect', (_e, keyJson: string, url: string) =>
    connectGoogle(String(keyJson ?? ''), String(url ?? ''))
  )
  ipcMain.handle('google:disconnect', () => disconnectGoogle())
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
    if (isInside(target, workspaceDir) || isInside(target, agentsDir)) await shell.openPath(target)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

void main()
