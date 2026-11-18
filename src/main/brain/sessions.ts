import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage } from '@shared/types'

interface SessionData {
  sessionId?: string
  messages: ChatMessage[]
}

/** One persisted conversation: the SDK session id plus what the UI showed. */
export class SessionStore {
  private data: SessionData = { messages: [] }

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as SessionData
      this.data = { sessionId: parsed.sessionId, messages: parsed.messages ?? [] }
    } catch {
      this.data = { messages: [] }
    }
  }

  get sessionId(): string | undefined {
    return this.data.sessionId
  }

  get messages(): ChatMessage[] {
    return this.data.messages
  }

  async setSessionId(id: string): Promise<void> {
    if (this.data.sessionId === id) return
    this.data.sessionId = id
    await this.save()
  }

  async add(message: ChatMessage): Promise<void> {
    this.data.messages.push(message)
    await this.save()
  }

  async reset(): Promise<void> {
    this.data = { messages: [] }
    await this.save()
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }
}
