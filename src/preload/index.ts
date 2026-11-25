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
  getAutomations: () => ipcRenderer.invoke('automations:get'),
  onAutomations: on('automations'),
  getAutomationRuns: (id) => ipcRenderer.invoke('automations:runs', id),
  onAutomationRun: on('automation-run'),
  approveAutomation: (id) => ipcRenderer.invoke('automations:approve', id),
  setAutomationEnabled: (id, enabled) => ipcRenderer.invoke('automations:enabled', id, enabled),
  runAutomation: (id) => ipcRenderer.invoke('automations:run', id),
  stopAutomation: (id) => ipcRenderer.invoke('automations:stop', id),
  getAgents: () => ipcRenderer.invoke('agents:get'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  send: (prompt, files) => ipcRenderer.invoke('brain:send', prompt, files),
  stop: () => ipcRenderer.invoke('brain:stop'),
  newConversation: () => ipcRenderer.invoke('brain:new'),
  setApiKey: (key) => ipcRenderer.invoke('apikey:set', key),
  setProvider: (provider) => ipcRenderer.invoke('provider:set', provider),
  checkProvider: () => ipcRenderer.invoke('provider:check'),
  setSkin: (skin) => ipcRenderer.invoke('skin:set', skin),
  addRepo: () => ipcRenderer.invoke('repos:add'),
  setRepoAccess: (name, write) => ipcRenderer.invoke('repos:access', name, write),
  removeRepo: (name) => ipcRenderer.invoke('repos:remove', name),
  listConversations: (query) => ipcRenderer.invoke('conversations:list', query),
  openConversation: (id) => ipcRenderer.invoke('conversations:open', id),
  renameConversation: (id, title) => ipcRenderer.invoke('conversations:rename', id, title),
  deleteConversation: (id) => ipcRenderer.invoke('conversations:delete', id),
  setResumeMode: (mode) => ipcRenderer.invoke('conversations:resume-mode', mode),
  setAgentEnabled:(id, enabled) => ipcRenderer.invoke('agents:enabled', id, enabled),
  respondPermission: (id, answer) => ipcRenderer.invoke('permission:respond', id, answer),
  setPermissionMode: (mode) => ipcRenderer.invoke('permissions:set-mode', mode),
  addPermissionRule: (kind, rule) => ipcRenderer.invoke('permissions:add-rule', kind, rule),
  removePermissionRule: (kind, index) => ipcRenderer.invoke('permissions:remove-rule', kind, index),
  onPermissionResolved: on('permission-resolved'),
  openPath: (path) => ipcRenderer.invoke('path:open', path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onUsage: on('usage'),
  onAgents: on('agents'),
  onStatus: on('status'),
  onReset: on('reset'),
  onThought: on('thought'),
  onDelta: on('delta'),
  onMessage: on('message'),
  onBusy: on('busy'),
  onPermission: on('permission'),
  setNotifications: (settings) => ipcRenderer.invoke('notifications:set', settings),
  pickNotificationSound: () => ipcRenderer.invoke('notifications:pick-sound'),
  testNotification: () => ipcRenderer.invoke('notifications:test'),
  setBadge: (dataUrl, count) => ipcRenderer.invoke('badge:set', dataUrl, count),
  onNotifySound: on('notify-sound')
}

contextBridge.exposeInMainWorld('brain', api)
