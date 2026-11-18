import type { SpriteSpec } from '@shared/types'

export const SPRITE_SIZE = 16

/**
 * Pixel grids, one character per pixel:
 * H hair · S skin · K eye · M mouth · T shirt · L laptop · D desk top · d desk leg
 * B brain · W brain fold · . transparent
 */
const PERSON = [
  '....HHHHHHHH....',
  '...HHHHHHHHHH...',
  '...HHSSSSSSHH...',
  '...HSSSSSSSSH...',
  '...SSKSSSSKSS...',
  '...SSSSSSSSSS...',
  '....SSSMMSSS....',
  '.....SSSSSS.....',
  '...TTTTTTTTTT...',
  '..TTTTTTTTTTTT..',
  '..TTTLLLLLLTTT..',
  '..SSTLLLLLLTSS..',
  'DDDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDDD',
  'dd............dd',
  'dd............dd'
]

const BRAIN = [
  '....BBWBBWBB....',
  '...BWBBWBBBWB...',
  '...BBWBBBWBBB...',
  '...WSSSSSSSSW...',
  ...PERSON.slice(4)
]

export const BRAIN_SPRITE: SpriteSpec = { hair: '#f29ac0', shirt: '#6b4fd8', skin: '#f2c9a0' }

/** Color from a CSS variable on <html> (set by the skin), or the classic one. */
function skinColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function colors(spec: SpriteSpec, isBrain: boolean): Record<string, string> {
  return {
    H: isBrain ? skinColor('--brain-hair', spec.hair) : spec.hair,
    S: spec.skin,
    T: isBrain ? skinColor('--brain-shirt', spec.shirt) : spec.shirt,
    K: skinColor('--sprite-eye', '#1b1c2b'),
    M: '#b0563f',
    L: skinColor('--sprite-laptop', '#c9d3e6'),
    D: skinColor('--sprite-desk', '#8a5a3b'),
    d: skinColor('--sprite-desk-leg', '#5e3c27'),
    B: skinColor('--brain-hair', '#f29ac0'),
    W: skinColor('--brain-fold', '#d9659a')
  }
}

export function drawSprite(canvas: HTMLCanvasElement, spec: SpriteSpec, isBrain: boolean): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const grid = isBrain ? BRAIN : PERSON
  const palette = colors(spec, isBrain)
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row[x]]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  })
}
