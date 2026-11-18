import type { AgentInfo } from '@shared/types'

/** The brain's room; agents with `zona: Dirección` sit with it. */
export const BRAIN_ZONE = 'Dirección'

export interface Zone {
  key: string
  name: string
  color: string
  agents: AgentInfo[]
}

/** Case- and accent-insensitive key, so "basicos" and "Básicos" are one room. */
export function zoneKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

/** Rooms in this order first; any other zone follows alphabetically; "General" last. */
const ORDER = ['direccion', 'decisiones', 'negocio', 'desarrollo', 'developers', 'pruebas', 'testers', 'basicos']

const COLORS: Record<string, string> = {
  direccion: '#6b4fd8',
  decisiones: '#d9659a',
  negocio: '#e0a03a',
  desarrollo: '#3aa6b8',
  developers: '#3aa6b8',
  pruebas: '#58c98b',
  testers: '#58c98b',
  basicos: '#7b86b8',
  general: '#7b86b8'
}

const PALETTE = ['#b8478f', '#2f7dd1', '#c9a227', '#a33b2a', '#3aa66b', '#8a5ad8', '#e0803a']

function colorOf(key: string): string {
  if (COLORS[key]) return COLORS[key]
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function rank(key: string): number {
  if (key === 'general') return Number.MAX_SAFE_INTEGER
  const i = ORDER.indexOf(key)
  return i === -1 ? ORDER.length : i
}

/**
 * Groups agents into office rooms. The brain's room always exists and comes
 * first, even when nobody else sits there.
 */
export function groupZones(agents: AgentInfo[]): Zone[] {
  const zones = new Map<string, Zone>()
  const add = (name: string): Zone => {
    const key = zoneKey(name)
    let zone = zones.get(key)
    if (!zone) {
      zone = { key, name, color: colorOf(key), agents: [] }
      zones.set(key, zone)
    }
    return zone
  }
  add(BRAIN_ZONE)
  for (const agent of agents) add(agent.zone || 'General').agents.push(agent)
  return [...zones.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.name.localeCompare(b.name, 'es'))
}

export const MIN_ZOOM = 0.35
export const MAX_ZOOM = 2.5

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

export interface View {
  zoom: number
  x: number
  y: number
}

/**
 * Zoom that fits `box` (a part of the world, by default from its origin) in
 * the viewport, centred, never above `max` (sprites stay small by default).
 */
export function fitView(
  box: { x?: number; y?: number; w: number; h: number },
  viewport: { w: number; h: number },
  margin = 16,
  max = 1.25
): View {
  if (box.w <= 0 || box.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return { zoom: 1, x: 0, y: 0 }
  const zoom = clampZoom(Math.min((viewport.w - margin * 2) / box.w, (viewport.h - margin * 2) / box.h, max))
  return {
    zoom,
    x: (viewport.w - box.w * zoom) / 2 - (box.x ?? 0) * zoom,
    y: (viewport.h - box.h * zoom) / 2 - (box.y ?? 0) * zoom
  }
}

/** Zooms by `factor` keeping the point (px, py) of the viewport still. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const zoom = clampZoom(view.zoom * factor)
  const k = zoom / view.zoom
  return { zoom, x: px - (px - view.x) * k, y: py - (py - view.y) * k }
}
