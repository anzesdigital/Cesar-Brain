import { SKINS, type SkinId } from '@shared/types'

const KEY = 'cesar-brain-skin'

/** Puts the skin on <html>, where styles.css picks it up, and remembers it for the next start. */
export function applySkin(skin: SkinId): void {
  document.documentElement.dataset.skin = skin
  try {
    localStorage.setItem(KEY, skin)
  } catch {
    // Storage may be unavailable; the skin still applies now.
  }
}

/** Last skin used, so the first paint does not flash the other one. */
export function restoreSkin(): void {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved && Object.hasOwn(SKINS, saved)) document.documentElement.dataset.skin = saved
  } catch {
    // Nothing saved; config.json decides once the status arrives.
  }
}
