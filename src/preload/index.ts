import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrainApi } from '@shared/types'

function on<T>(channel: string) {
  return (cb: (payload: T) => void): (() => void) => {
    const listener = (_event: unknown, payload: T): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: BrainApi = {
  getAgents: () => ipcRenderer.invoke('agents:get'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  send: (prompt, files) => ipcRenderer.invoke('brain:send', prompt, files),
  stop: () => ipcRenderer.invoke('brain:stop'),
  newConversation: () => ipcRenderer.invoke('brain:new'),
  setApiKey: (key) => ipcRenderer.invoke('apikey:set', key),
  connectGoogle: (keyJson, sheetUrl) => ipcRenderer.invoke('google:connect', keyJson, sheetUrl),
  disconnectGoogle: () => ipcRenderer.invoke('google:disconnect'),
  respondPermission: (id, allow) => ipcRenderer.invoke('permission:respond', id, allow),
  openPath: (path) => ipcRenderer.invoke('path:open', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onUsage: on('usage'),
  onAgents: on('agents'),
  onThought: on('thought'),
  onDelta: on('delta'),
  onMessage: on('message'),
  onBusy: on('busy'),
  onPermission: on('permission')
}

contextBridge.exposeInMainWorld('brain', api)
