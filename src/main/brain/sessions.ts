import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, ConversationMeta, ProviderId, ResumeMode } from '@shared/types'

/** Conversations kept on disk; the oldest beyond this are deleted. */
export const KEEP_CONVERSATIONS = 200
const TITLE_MAX = 60
const ID_RE = /^[a-z0-9]{6,20}-[a-f0-9]{6}$/

interface ConversationData extends ConversationMeta {
  /** Provider session id, one per provider (they cannot resume each other's). */
  sessionIds: Partial<Record<ProviderId, string>>
  messages: ChatMessage[]
  /** The user renamed it; the first message no longer sets the title. */
  renamed?: boolean
}

interface IndexData {
  active?: string
  items: ConversationMeta[]
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/** Title from the first thing the user wrote; no model involved. */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return 'Archivos adjuntos'
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat
}

function meta(c: ConversationData): ConversationMeta {
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length }
}

function empty(now: number): ConversationData {
  return { id: newId(), title: 'Conversación nueva', createdAt: now, updatedAt: now, count: 0, sessionIds: {}, messages: [] }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * Every conversation, one file each, plus a small index. One of them is
 * active: that is the one the brain continues. Opening an old one only reads
 * a local file; nothing is sent to a provider until the user writes.
 */
export class ConversationStore {
  private index: IndexData = { items: [] }
  private current: ConversationData = empty(Date.now())
  /** Opened from the history and not answered since: the next run is a resume. */
  private reopened = false
  /** How the user wants that resume done; undefined = automatic. */
  forcedMode?: ResumeMode

  constructor(
    private dir: string,
    /** session.json from before the history existed; becomes the first conversation. */
    private legacyFile?: string,
    private now: () => number = Date.now
  ) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.indexFile, 'utf8')) as Partial<IndexData>
      this.index = { active: parsed.active, items: Array.isArray(parsed.items) ? parsed.items : [] }
    } catch {
      this.index = { items: [] }
      await this.migrate()
    }
    const active = this.index.active ? await this.read(this.index.active) : undefined
    this.current = active ?? empty(this.now())
    this.reopened = false
  }

  get id(): string {
    return this.current.id
  }

  get messages(): ChatMessage[] {
    return this.current.messages
  }

  /** True until the first run after opening a conversation from the history. */
  get resumePending(): boolean {
    return this.reopened
  }

  sessionId(provider: ProviderId): string | undefined {
    return this.current.sessionIds[provider]
  }

  async setSessionId(provider: ProviderId, id: string): Promise<void> {
    if (this.current.sessionIds[provider] === id) return
    this.current.sessionIds[provider] = id
    await this.save()
  }

  async add(message: ChatMessage): Promise<void> {
    const c = this.current
    if (message.role === 'user' && !c.renamed && !c.messages.some((m) => m.role === 'user')) {
      c.title = titleFrom(message.text)
    }
    c.messages.push(message)
    c.updatedAt = this.now()
    this.reopened = false
    this.forcedMode = undefined
    await this.save()
  }

  /** Conversations, newest first. `query` matches the title or any message text. */
  async list(query = ''): Promise<ConversationMeta[]> {
    const items = [...this.index.items].sort((a, b) => b.updatedAt - a.updatedAt)
    const q = query.trim().toLowerCase()
    if (!q) return items
    const found: ConversationMeta[] = []
    for (const item of items) {
      if (item.title.toLowerCase().includes(q)) {
        found.push(item)
        continue
      }
      const data = item.id === this.current.id ? this.current : await this.read(item.id)
      if (data?.messages.some((m) => m.text.toLowerCase().includes(q))) found.push(item)
    }
    return found
  }

  /** Makes an archived conversation the active one. Reads disk only. */
  async open(id: string): Promise<boolean> {
    if (id === this.current.id) return true
    const data = await this.read(id)
    if (!data) return false
    this.current = data
    this.reopened = data.messages.length > 0
    this.forcedMode = undefined
    this.index.active = id
    await this.saveIndex()
    return true
  }

  /** Starts an empty conversation; the previous one stays in the history. */
  async startNew(): Promise<void> {
    this.current = empty(this.now())
    this.reopened = false
    this.forcedMode = undefined
    this.index.active = undefined
    await this.saveIndex()
  }

  async rename(id: string, title: string): Promise<void> {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!clean) return
    const data = id === this.current.id ? this.current : await this.read(id)
    if (!data) return
    data.title = clean
    data.renamed = true
    if (data === this.current && data.messages.length === 0) return
    await this.write(data)
  }

  async remove(id: string): Promise<void> {
    if (!ID_RE.test(id)) return
    this.index.items = this.index.items.filter((i) => i.id !== id)
    await rm(this.file(id), { force: true })
    if (id === this.current.id) await this.startNew()
    else await this.saveIndex()
  }

  private get indexFile(): string {
    return join(this.dir, 'index.json')
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private async read(id: string): Promise<ConversationData | undefined> {
    if (!ID_RE.test(id)) return undefined
    try {
      const data = JSON.parse(await readFile(this.file(id), 'utf8')) as ConversationData
      return { ...data, sessionIds: data.sessionIds ?? {}, messages: data.messages ?? [] }
    } catch {
      return undefined
    }
  }

  /** Empty conversations are not written: they would only clutter the history. */
  private async save(): Promise<void> {
    if (this.current.messages.length === 0) return
    this.index.active = this.current.id
    await this.write(this.current)
  }

  private async write(data: ConversationData): Promise<void> {
    await writeJson(this.file(data.id), { ...data, count: data.messages.length })
    this.index.items = [meta(data), ...this.index.items.filter((i) => i.id !== data.id)]
    await this.prune()
    await this.saveIndex()
  }

  private async prune(): Promise<void> {
    const sorted = [...this.index.items].sort((a, b) => b.updatedAt - a.updatedAt)
    const old = sorted.slice(KEEP_CONVERSATIONS).filter((i) => i.id !== this.current.id)
    if (!old.length) return
    const drop = new Set(old.map((i) => i.id))
    this.index.items = this.index.items.filter((i) => !drop.has(i.id))
    await Promise.all(old.map((i) => rm(this.file(i.id), { force: true })))
  }

  private async saveIndex(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeJson(this.indexFile, this.index)
  }

  private async migrate(): Promise<void> {
    if (!this.legacyFile) return
    try {
      const parsed = JSON.parse(await readFile(this.legacyFile, 'utf8')) as {
        sessionIds?: Partial<Record<ProviderId, string>>
        sessionId?: string
        messages?: ChatMessage[]
      }
      const messages = parsed.messages ?? []
      if (!messages.length) return
      const first = messages[0].ts || this.now()
      const data: ConversationData = {
        id: newId(),
        title: titleFrom(messages.find((m) => m.role === 'user')?.text ?? ''),
        createdAt: first,
        updatedAt: messages[messages.length - 1].ts || first,
        count: messages.length,
        // Files from before providers existed hold one Claude session id.
        sessionIds: parsed.sessionIds ?? (parsed.sessionId ? { claude: parsed.sessionId } : {}),
        messages
      }
      this.index.active = data.id
      await this.write(data)
    } catch {
      // nothing to migrate
    }
  }
}
