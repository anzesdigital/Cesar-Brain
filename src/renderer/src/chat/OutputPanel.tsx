import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { parseOptions, type ChoiceOption } from '@shared/options'
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

/**
 * The brain's alternatives as clickable cards, plus a free answer. Only the
 * last answer is live; older ones show what was picked.
 */
function Choices({ options, live: canAnswer, chosen }: { options: ChoiceOption[]; live: boolean; chosen?: string }) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  // Blocks a second click before the app reports it is busy.
  const [sent, setSent] = useState(false)
  const other = useRef<HTMLTextAreaElement>(null)
  const live = canAnswer && !sent

  const send = async (answer: string): Promise<void> => {
    if (!live || !answer.trim()) return
    setError('')
    setSent(true)
    try {
      await window.brain.send(answer.trim(), [])
    } catch (err) {
      setSent(false)
      setError(`No se pudo enviar: ${(err as Error).message}`)
    }
  }

  // 1–9 pick an option while nothing else has the keyboard.
  useEffect(() => {
    if (!live) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const target = e.target as HTMLElement
      if (e.ctrlKey || e.metaKey || e.altKey || target.closest('input, textarea, [contenteditable]')) return
      if (document.querySelector('.modal-backdrop')) return
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault()
        void send(options[n - 1].label)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [live, options])

  useEffect(() => {
    if (writing) other.current?.focus()
  }, [writing])

  return (
    <div className={`choices${live ? '' : ' choices-past'}`} role="group" aria-label="Opciones">
      {options.map((o, i) => (
        <button
          key={o.label}
          type="button"
          className={`choice${chosen === o.label ? ' choice-picked' : ''}`}
          disabled={!live}
          onClick={() => void send(o.label)}
        >
          <span className="choice-key">{i + 1}</span>
          <span className="choice-text">
            <strong>{o.label}</strong>
            {o.detail && <small>{o.detail}</small>}
          </span>
        </button>
      ))}
      {live &&
        (writing ? (
          <form
            className="choice-other"
            onSubmit={(e) => {
              e.preventDefault()
              void send(text)
            }}
          >
            <textarea
              ref={other}
              value={text}
              rows={2}
              placeholder="Escribe tu propia propuesta…"
              aria-label="Otra propuesta"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send(text)
                } else if (e.key === 'Escape') {
                  setWriting(false)
                }
              }}
            />
            <div className="choice-other-actions">
              <button type="button" className="btn-ghost" onClick={() => setWriting(false)}>
                Cancelar
              </button>
              <button type="submit" className="btn-primary" disabled={!text.trim()}>
                Enviar
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="choice choice-add" onClick={() => setWriting(true)}>
            <span className="choice-key">+</span>
            <span className="choice-text">
              <strong>Otra cosa…</strong>
              <small>Propón tu propia opción</small>
            </span>
          </button>
        ))}
      {error && <p className="inputbar-error">{error}</p>}
    </div>
  )
}

function Message({ message, live, reply }: { message: ChatMessage; live: boolean; reply?: string }) {
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
  return <BrainMessage message={message} live={live} reply={reply} />
}

function BrainMessage({ message, live, reply }: { message: ChatMessage; live: boolean; reply?: string }) {
  const { body, options } = useMemo(() => parseOptions(message.text), [message.text])
  const chosen = reply?.trim()
  return (
    <article className={`msg msg-brain${message.error ? ' msg-error' : ''}`}>
      {body && <Markdown text={body} />}
      {options.length > 0 && (
        <Choices options={options} live={live} chosen={options.some((o) => o.label === chosen) ? chosen : undefined} />
      )}
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
  // The options block only becomes buttons once the answer is complete.
  const streamBody = useMemo(() => parseOptions(streamText).body, [streamText])

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
        {messages.map((m, i) => (
          <Message
            key={`${m.ts}-${m.role}`}
            message={m}
            live={!busy && i === messages.length - 1}
            reply={messages[i + 1]?.role === 'user' ? messages[i + 1].text : undefined}
          />
        ))}
        {busy && (
          <article className="msg msg-brain msg-streaming">
            {streamBody ? <Markdown text={streamBody} /> : <p className="msg-waiting">El equipo está trabajando…</p>}
          </article>
        )}
        <div ref={end} />
      </div>
    </section>
  )
}
