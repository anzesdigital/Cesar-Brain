import { useEffect } from 'react'
import { parseOptions } from '@shared/options'
import { useStore } from './store'

/** Things waiting for the user: permission prompts plus an unanswered question. */
function usePendingCount(): number {
  return useStore((s) => {
    const last = s.messages.at(-1)
    const question = !s.busy && last?.role === 'brain' && parseOptions(last.text).options.length > 0
    return s.permissions.length + (question ? 1 : 0)
  })
}

/** Red circle with the number, as a PNG data URL for the taskbar overlay. */
function drawBadge(count: number): string {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.fillStyle = '#e5383b'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `bold ${count > 9 ? 16 : 20}px "Segoe UI", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(count > 9 ? '9+' : String(count), size / 2, size / 2 + 1)
  return canvas.toDataURL('image/png')
}

/** Keeps the number on the taskbar icon in step with what waits for the user. */
export function useTaskbarBadge(): void {
  const count = usePendingCount()
  const enabled = useStore((s) => s.status?.notifications.enabled ?? true)
  useEffect(() => {
    const shown = enabled ? count : 0
    void window.brain.setBadge(shown > 0 ? drawBadge(shown) || null : null, shown).catch(() => undefined)
  }, [count, enabled])
}

/** Plays the custom notification sound sent by the main process. */
export function playSound(bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
  const audio = new Audio(url)
  const release = (): void => URL.revokeObjectURL(url)
  audio.addEventListener('ended', release, { once: true })
  audio.addEventListener('error', release, { once: true })
  void audio.play().catch(release)
}
