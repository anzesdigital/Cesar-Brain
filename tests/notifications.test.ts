import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyMessage, findCustomSound, permissionAlert, plainText, shouldAlert } from '../src/main/alerts'
import { parseConfig } from '../src/main/config'

describe('classifyMessage', () => {
  it('treats a reply with an opciones block as a question', () => {
    const text = 'He mirado el repo.\n\n¿Qué hago ahora?\n\n```opciones\n- Arreglar | rápido\n- Esperar\n```'
    expect(classifyMessage({ text })).toEqual({ kind: 'question', title: 'El Cerebro te pregunta', body: '¿Qué hago ahora?' })
  })

  it('falls back to the labels when the question has no text', () => {
    const text = '```opciones\n- Sí\n- No\n```'
    expect(classifyMessage({ text }).body).toBe('Sí · No')
  })

  it('treats a plain reply as a response and strips markdown', () => {
    const alert = classifyMessage({ text: '## Hecho\n\nHe creado **tres** archivos en [docs](http://x).' })
    expect(alert.kind).toBe('response')
    expect(alert.title).toBe('Respuesta lista')
    expect(alert.body).toBe('Hecho He creado tres archivos en docs.')
  })

  it('names errors', () => {
    expect(classifyMessage({ text: 'Falló', error: true }).title).toMatch(/problema/)
  })

  it('cuts long text', () => {
    const body = plainText('a'.repeat(500))
    expect(body.length).toBe(140)
    expect(body.endsWith('…')).toBe(true)
  })
})

describe('permissionAlert', () => {
  it('says who asks and for what', () => {
    expect(permissionAlert({ id: '1', agentId: 'dev', toolName: 'Bash', summary: 'npm test' }, 'Dev')).toEqual({
      title: 'Dev pide permiso',
      body: 'Bash: npm test'
    })
  })
})

describe('shouldAlert', () => {
  const on = { enabled: true, sound: 'sistema' as const }
  it('alerts only when on and the window is not in front', () => {
    expect(shouldAlert(on, false)).toBe(true)
    expect(shouldAlert(on, true)).toBe(false)
    expect(shouldAlert({ ...on, enabled: false }, false)).toBe(false)
  })
  it('a test always alerts', () => {
    expect(shouldAlert({ ...on, enabled: false }, true, true)).toBe(true)
  })
})

describe('notifications in config.json', () => {
  it('defaults to on with the system sound', () => {
    expect(parseConfig({}).notifications).toEqual({ enabled: true, sound: 'sistema' })
  })
  it('reads valid values and ignores bad ones', () => {
    expect(parseConfig({ notifications: { enabled: false, sound: 'personalizado' } }).notifications).toEqual({
      enabled: false,
      sound: 'personalizado'
    })
    expect(parseConfig({ notifications: { enabled: 'si', sound: 'trompeta' } }).notifications).toEqual({
      enabled: true,
      sound: 'sistema'
    })
    expect(parseConfig({ notifications: 'no' }).notifications).toEqual({ enabled: true, sound: 'sistema' })
  })
})

describe('findCustomSound', () => {
  it('finds aviso.<ext> and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-sound-'))
    expect(await findCustomSound(dir)).toBeUndefined()
    await writeFile(join(dir, 'otro.mp3'), '')
    expect(await findCustomSound(dir)).toBeUndefined()
    await writeFile(join(dir, 'aviso.MP3'), '')
    expect(await findCustomSound(dir)).toBe('aviso.MP3')
    expect(await findCustomSound(join(dir, 'no-existe'))).toBeUndefined()
  })
})
