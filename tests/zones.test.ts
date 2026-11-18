import { describe, expect, it } from 'vitest'
import type { AgentInfo } from '../src/shared/types'
import { parseAgentFile } from '../src/main/brain/registry'
import { clampZoom, fitView, groupZones, MAX_ZOOM, MIN_ZOOM, zoomAt } from '../src/renderer/src/office/zones'

function agent(id: string, zone: string): AgentInfo {
  return { id, name: id, role: '', description: '', sprite: { hair: '#000000', shirt: '#000000', skin: '#000000' }, zone }
}

describe('office zones', () => {
  it('reads the zone from agent.md, General by default', () => {
    expect(parseAgentFile('---\ndescription: x\nzona: Pruebas\n---\ncuerpo', 'a-b').info.zone).toBe('Pruebas')
    expect(parseAgentFile('---\ndescription: x\n---\ncuerpo', 'a-b').info.zone).toBe('General')
  })

  it('groups agents into rooms in a stable order, merging spellings', () => {
    const zones = groupZones([
      agent('a', 'Básicos'),
      agent('b', 'Marketing'),
      agent('c', 'basicos'),
      agent('d', 'General'),
      agent('e', 'Negocio'),
      agent('f', 'Dirección')
    ])
    expect(zones.map((z) => z.name)).toEqual(['Dirección', 'Negocio', 'Básicos', 'Marketing', 'General'])
    expect(zones[2].agents.map((a) => a.id)).toEqual(['a', 'c'])
    expect(zones[0].agents.map((a) => a.id)).toEqual(['f'])
    expect(zones[3].color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('always has the brain room', () => {
    expect(groupZones([]).map((z) => z.name)).toEqual(['Dirección'])
  })
})

describe('office zoom', () => {
  it('fits the world centred in the viewport', () => {
    const v = fitView({ w: 800, h: 400 }, { w: 432, h: 600 })
    expect(v.zoom).toBeCloseTo(0.5)
    expect(v.x).toBeCloseTo(16)
    expect(v.y).toBeCloseTo(200)
    expect(fitView({ w: 100, h: 100 }, { w: 2000, h: 2000 }).zoom).toBe(1.25)
    expect(fitView({ w: 100, h: 100 }, { w: 2000, h: 2000 }, 16, 2).zoom).toBe(2)
    expect(fitView({ w: 0, h: 0 }, { w: 100, h: 100 })).toEqual({ zoom: 1, x: 0, y: 0 })
    // A box inside the world: its corner lands where the centred box starts.
    const inner = fitView({ x: 100, y: 50, w: 400, h: 200 }, { w: 432, h: 600 })
    expect(inner.zoom).toBeCloseTo(1)
    expect(inner.x).toBeCloseTo(16 - 100)
    expect(inner.y).toBeCloseTo(200 - 50)
  })

  it('zooms around a point and stays within limits', () => {
    const v = zoomAt({ zoom: 1, x: 0, y: 0 }, 2, 100, 50)
    expect(v).toEqual({ zoom: 2, x: -100, y: -50 })
    expect(clampZoom(10)).toBe(MAX_ZOOM)
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
  })
})
