import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { PROVIDERS, type ChatMessage } from '@shared/types'
import { useStore } from '../store'
import { UsageButton } from '../usage/UsagePanel'

function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true })),
    [text]
  )
  // Links open in the system browser (main process handles window.open).
  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute('href') ?? ''
    if (/^https?:\/\//.test(href)) window.open(href)
  }
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <article className="msg msg-user">
        <p>{message.text}</p>
        {message.files?.length ? (
          <ul className="msg-files">
            {message.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
      </article>
    )
  }
  return (
    <article className={`msg msg-brain${message.error ? ' msg-error' : ''}`}>
      <Markdown text={message.text} />
    </article>
  )
}

export function OutputPanel({ onSettings, onUsage }: { onSettings: () => void; onUsage: () => void }) {
  const messages = useStore((s) => s.messages)
  const streamText = useStore((s) => s.streamText)
  const busy = useStore((s) => s.busy)
  const status = useStore((s) => s.status)
  const clearConversation = useStore((s) => s.clearConversation)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages, streamText])

  const startNew = async (): Promise<void> => {
    await window.brain.newConversation()
    clearConversation()
  }

  return (
    <section className="output" aria-label="Conversación">
      <header className="output-header">
        <h1>
          Cesar Brain
          {status && <span className="output-provider">{PROVIDERS[status.provider]}</span>}
        </h1>
        <div>
          {status && (
            <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(status.workspaceDir)}>
              Archivos
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={() => void startNew()} disabled={messages.length === 0 && !busy}>
            Nueva
          </button>
          <UsageButton onClick={onUsage} />
          <button
            type="button"
            className="btn-ghost"
            onClick={onSettings}
            title={status?.problems.length ? `${status.problems.length} cosas que revisar en los agentes o la configuración` : undefined}
          >
            Ajustes{status?.problems.length ? ' ⚠' : ''}
          </button>
        </div>
      </header>

      <div className="output-scroll">
        {messages.length === 0 && !busy && (
          <div className="output-empty">
            <p>Escribe lo que necesitas o suelta un archivo.</p>
            <p>El Cerebro decide quién del equipo lo resuelve y verás lo que piensa cada uno.</p>
          </div>
        )}
        {messages.map((m) => (
          <Message key={`${m.ts}-${m.role}`} message={m} />
        ))}
        {busy && (
          <article className="msg msg-brain msg-streaming">
            {streamText ? <Markdown text={streamText} /> : <p className="msg-waiting">El equipo está trabajando…</p>}
          </article>
        )}
        <div ref={end} />
      </div>
    </section>
  )
}
