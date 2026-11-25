import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Notification, type BrowserWindow } from 'electron'
import type { ChatMessage, NotificationSettings, PermissionRequest } from '@shared/types'
import { classifyMessage, findCustomSound, permissionAlert, shouldAlert } from './alerts'

export interface NotifierDeps {
  getWindow(): BrowserWindow | undefined
  getSettings(): NotificationSettings
  /** Folder that holds the custom sound. */
  soundsDir: string
  send(channel: string, payload: unknown): void
}

/** Windows toasts, taskbar flashing and sound when the brain needs the user. */
export class Notifier {
  private flashHooked = new WeakSet<BrowserWindow>()

  constructor(private deps: NotifierDeps) {}

  permission(req: PermissionRequest, agentName: string): void {
    const { title, body } = permissionAlert(req, agentName)
    void this.alert(title, body)
  }

  message(message: ChatMessage): void {
    if (message.role !== 'brain') return
    const { title, body } = classifyMessage(message)
    void this.alert(title, body)
  }

  test(): Promise<void> {
    return this.alert('Cesar Brain', 'Así se verán los avisos.', true)
  }

  private async alert(title: string, body: string, force = false): Promise<void> {
    const win = this.deps.getWindow()
    if (!win || win.isDestroyed()) return
    const settings = this.deps.getSettings()
    if (!shouldAlert(settings, win.isFocused(), force)) return

    const custom = settings.sound === 'personalizado' ? await findCustomSound(this.deps.soundsDir) : undefined
    // Without a custom file the system sound plays instead.
    const silent = settings.sound === 'ninguno' || Boolean(custom)

    if (Notification.isSupported()) {
      const toast = new Notification({ title, body, silent })
      toast.on('click', () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      toast.show()
    }

    if (!win.isFocused()) {
      win.flashFrame(true)
      if (!this.flashHooked.has(win)) {
        this.flashHooked.add(win)
        win.on('focus', () => win.flashFrame(false))
      }
    }

    if (custom) {
      const bytes = await readFile(join(this.deps.soundsDir, custom)).catch(() => undefined)
      if (bytes) this.deps.send('notify-sound', new Uint8Array(bytes))
    }
  }
}
