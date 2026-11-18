import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage, ProviderId } from '@shared/types'

interface SessionData {
  /** Provider session id, one per provider (they cannot resume each other's). */
  sessionIds: Partial<Record<ProviderId, string>>
  messages: ChatMessage[]
}

/** One persisted conversation: the provider session ids plus what the UI showed. */
export class SessionStore {
  private data: SessionData = { sessionIds: {}, messages: [] }

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<SessionData> & { sessionId?: string }
      // Files from before providers existed hold one Claude session id.
      const sessionIds = parsed.sessionIds ?? (parsed.sessionId ? { claude: parsed.sessionId } : {})
      this.data = { sessionIds, messages: parsed.messages ?? [] }
    } catch {
      this.data = { sessionIds: {}, messages: [] }
    }
  }

  sessionId(provider: ProviderId): string | undefined {
    return this.data.sessionIds[provider]
  }

  get messages(): ChatMessage[] {
    return this.data.messages
  }

  async setSessionId(provider: ProviderId, id: string): Promise<void> {
    if (this.data.sessionIds[provider] === id) return
    this.data.sessionIds[provider] = id
    await this.save()
  }

  async add(message: ChatMessage): Promise<void> {
    this.data.messages.push(message)
    await this.save()
  }

  async reset(): Promise<void> {
    this.data = { sessionIds: {}, messages: [] }
    await this.save()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }
}
