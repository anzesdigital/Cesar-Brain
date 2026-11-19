import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { chooseResumeMode, estimateTokens, summaryPreamble, withHistory } from '../src/main/brain/resume'
import { ConversationStore, KEEP_CONVERSATIONS, titleFrom } from '../src/main/brain/sessions'

const user = (text: string, ts = 1): ChatMessage => ({ role: 'user', text, ts })
const brain = (text: string, ts = 2): ChatMessage => ({ role: 'brain', text, ts })

async function store(legacy?: unknown): Promise<{ s: ConversationStore; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'conv-'))
  const legacyFile = join(root, 'session.json')
  if (legacy) await writeFile(legacyFile, JSON.stringify(legacy), 'utf8')
  let clock = 1000
  const s = new ConversationStore(join(root, 'conversations'), legacyFile, () => clock++)
  await s.load()
  return { s, dir: join(root, 'conversations') }
}

describe('ConversationStore', () => {
  it('keeps the old conversation when starting a new one, and reopens it', async () => {
    const { s, dir } = await store()
    expect(await s.list()).toEqual([])
    await s.add(user('Hazme un informe   de ventas'))
    await s.setSessionId('claude', 'abc')
    await s.add(brain('Hecho'))
    const first = s.id
    expect(s.resumePending).toBe(false)

    await s.startNew()
    expect(s.messages).toEqual([])
    expect(s.sessionId('claude')).toBeUndefined()
    // An empty conversation is not saved.
    expect((await s.list()).map((c) => c.id)).toEqual([first])

    expect(await s.open(first)).toBe(true)
    expect(s.resumePending).toBe(true)
    expect(s.sessionId('claude')).toBe('abc')
    expect(s.messages.map((m) => m.text)).toEqual(['Hazme un informe   de ventas', 'Hecho'])
    expect((await s.list())[0]).toMatchObject({ title: 'Hazme un informe de ventas', count: 2 })

    s.forcedMode = 'summary'
    await s.add(user('Sigue'))
    expect(s.resumePending).toBe(false)
    expect(s.forcedMode).toBeUndefined()

    // The active conversation survives a restart.
    const again = new ConversationStore(dir)
    await again.load()
    expect(again.id).toBe(first)
    expect(again.messages).toHaveLength(3)
    expect(again.resumePending).toBe(false)
  })

  it('searches, renames and deletes', async () => {
    const { s } = await store()
    await s.add(user('Presupuesto de marketing'))
    await s.add(brain('El total es 4.200 €'))
    const a = s.id
    await s.startNew()
    await s.add(user('Otra cosa'))
    const b = s.id

    expect((await s.list('4.200')).map((c) => c.id)).toEqual([a])
    expect((await s.list('otra')).map((c) => c.id)).toEqual([b])

    await s.rename(a, '  Marketing Q4 ')
    await s.open(a)
    await s.add(user('y en enero?'))
    expect((await s.list())[0]).toMatchObject({ id: a, title: 'Marketing Q4' })

    await s.remove(a)
    expect(s.id).not.toBe(a)
    expect(s.messages).toEqual([])
    expect((await s.list()).map((c) => c.id)).toEqual([b])
    expect(await s.open(a)).toBe(false)
    expect(await s.open('../../etc/passwd')).toBe(false)
  })

  it('turns the old session.json into the first conversation', async () => {
    const { s } = await store({ sessionId: 'old-claude', messages: [user('Hola', 5), brain('¡Hola!', 6)] })
    expect(s.sessionId('claude')).toBe('old-claude')
    expect(s.messages).toHaveLength(2)
    expect(await s.list()).toEqual([expect.objectContaining({ title: 'Hola', createdAt: 5, updatedAt: 6, count: 2 })])
  })

  it('deletes the oldest conversations beyond the limit', async () => {
    const { s, dir } = await store()
    for (let i = 0; i < KEEP_CONVERSATIONS + 2; i++) {
      await s.startNew()
      await s.add(user(`n${i}`))
    }
    const list = await s.list()
    expect(list).toHaveLength(KEEP_CONVERSATIONS)
    expect(list.at(-1)?.title).toBe('n2')
    expect((await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json')).toHaveLength(KEEP_CONVERSATIONS)
  }, 20_000)

  it('makes short titles from the first message', () => {
    expect(titleFrom('  hola\n mundo ')).toBe('hola mundo')
    expect(titleFrom('')).toBe('Archivos adjuntos')
    expect(titleFrom('x'.repeat(100))).toHaveLength(60)
  })
})

describe('resume', () => {
  it('picks full only when the session exists and the history is small', () => {
    expect(chooseResumeMode({ canFull: true, tokens: 5000, maxTokens: 20_000 })).toBe('full')
    expect(chooseResumeMode({ canFull: true, tokens: 30_000, maxTokens: 20_000 })).toBe('summary')
    expect(chooseResumeMode({ canFull: false, tokens: 10, maxTokens: 20_000 })).toBe('summary')
  })

  it('estimates tokens with room for what the chat does not show', () => {
    expect(estimateTokens([user('a'.repeat(400)), brain('b'.repeat(400))])).toBe(400)
  })

  it('builds a summary of the last messages without option blocks', () => {
    const many = Array.from({ length: 15 }, (_, i) => user(`m${i}`))
    const text = summaryPreamble([...many, brain('Elige:\n```opciones\n- A\n- B\n```')])
    expect(text).toContain('se omiten 4 más antiguos')
    expect(text).not.toContain('m3\n')
    expect(text).toContain('Usuario: m14')
    expect(text).toContain('Cerebro: Elige:')
    expect(text).not.toContain('opciones')
    expect(summaryPreamble([])).toBe('')
    expect(summaryPreamble([brain('x'.repeat(2000))])).toContain('…')
    expect(withHistory('hola', undefined)).toBe('hola')
    expect(withHistory('hola', 'CTX')).toBe('CTX\nhola')
  })
})
