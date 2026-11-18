import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, parseConfig } from '../src/main/config'

describe('skin in config.json', () => {
  it('defaults to the classic one and accepts ing', () => {
    expect(parseConfig({}).skin).toBe('clasica')
    expect(parseConfig({ skin: 'ing' }).skin).toBe('ing')
  })

  it('falls back to classic with a warning on an unknown skin', async () => {
    expect(parseConfig({ skin: 'rosa', provider: 'copilot' })).toMatchObject({ skin: 'clasica', provider: 'copilot' })
    const file = join(await mkdtemp(join(tmpdir(), 'cb-skin-')), 'config.json')
    await writeFile(file, JSON.stringify({ skin: 'rosa' }))
    const { config, warnings, error } = await loadConfig(file)
    expect(error).toBeUndefined()
    expect(config.skin).toBe('clasica')
    expect(warnings).toEqual([expect.stringMatching(/skin "rosa"/)])
  })
})
