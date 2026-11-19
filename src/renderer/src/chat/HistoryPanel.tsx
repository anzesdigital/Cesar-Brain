import { useEffect, useRef, useState } from 'react'
import type { ConversationMeta } from '@shared/types'
import { useStore } from '../store'

const DAY = 24 * 60 * 60 * 1000

function cleanError(err: unknown): string {
  return (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Hoy / Ayer / Últimos 7 días / Antes, keeping the newest-first order. */
function groupByDay(items: ConversationMeta[], now = Date.now()): { label: string; items: ConversationMeta[] }[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  const label = (ts: number): string =>
    ts >= start ? 'Hoy' : ts >= start - DAY ? 'Ayer' : ts >= start - 6 * DAY ? 'Últimos 7 días' : 'Antes'
  const groups: { label: string; items: ConversationMeta[] }[] = []
  for (const item of items) {
    const name = label(item.updatedAt)
    const last = groups[groups.length - 1]
    if (last?.label === name) last.items.push(item)
    else groups.push({ label: name, items: [item] })
  }
  return groups
}

function when(ts: number): string {
  const date = new Date(ts)
  const sameDay = new Date().toDateString() === date.toDateString()
  return sameDay
    ? date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('es', { day: 'numeric', month: 'short' })
}

function Item({
  item,
  active,
  disabled,
  onOpen,
  onChanged
}: {
  item: ConversationMeta
  active: boolean
  disabled: boolean
  onOpen: () => void
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view')
  const [title, setTitle] = useState(item.title)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'rename') input.current?.select()
  }, [mode])

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await work()
      setMode('view')
      onChanged()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  if (mode === 'rename') {
    return (
      <li className="history-item history-item-edit">
        <input
          ref={input}
          value={title}
          maxLength={120}
          aria-label="Nuevo título"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run(() => window.brain.renameConversation(item.id, title))
            else if (e.key === 'Escape') setMode('view')
          }}
        />
        <button type="button" className="btn-primary" disabled={!title.trim()} onClick={() => void run(() => window.brain.renameConversation(item.id, title))}>
          Guardar
        </button>
        <button type="button" className="btn-ghost" onClick={() => setMode('view')}>
          Cancelar
        </button>
        {error && <p className="inputbar-error">{error}</p>}
      </li>
    )
  }

  return (
    <li className={`history-item${active ? ' history-item-active' : ''}`}>
      <button type="button" className="history-open" disabled={disabled || active} onClick={onOpen} title={item.title}>
        <span className="history-title">{item.title}</span>
        <small>
          {when(item.updatedAt)} · {item.count} mensajes{active ? ' · abierta' : ''}
        </small>
      </button>
      {mode === 'delete' ? (
        <span className="history-confirm">
          ¿Borrar?
          <button type="button" className="btn-stop" onClick={() => void run(() => window.brain.deleteConversation(item.id))}>
            Sí
          </button>
          <button type="button" className="btn-ghost" onClick={() => setMode('view')}>
            No
          </button>
        </span>
      ) : (
        <span className="history-actions">
          <button type="button" aria-label={`Renombrar ${item.title}`} title="Renombrar" onClick={() => setMode('rename')}>
            ✎
          </button>
          <button
            type="button"
            aria-label={`Borrar ${item.title}`}
            title="Borrar"
            disabled={disabled && active}
            onClick={() => setMode('delete')}
          >
            ×
          </button>
        </span>
      )}
      {error && <p className="inputbar-error">{error}</p>}
    </li>
  )
}

/** Saved conversations. Opening one reads a local file: it costs no tokens. */
export function HistoryPanel({ onClose }: { onClose: () => void }) {
  const busy = useStore((s) => s.busy)
  const activeId = useStore((s) => s.status?.conversation.id)
  const openConversation = useStore((s) => s.openConversation)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ConversationMeta[]>()
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    search.current?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      window.brain
        .listConversations(query)
        .then((list) => {
          if (!cancelled) setItems(list)
        })
        .catch((err) => setError(cleanError(err)))
    }, query ? 200 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, version, activeId])

  const open = async (id: string): Promise<void> => {
    setError('')
    try {
      openConversation(await window.brain.openConversation(id))
      onClose()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <div className="history" role="region" aria-label="Historial de conversaciones">
      <div className="history-head">
        <input
          ref={search}
          type="search"
          value={query}
          placeholder="Buscar en el historial…"
          aria-label="Buscar en el historial"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />
        <button type="button" className="btn-ghost" onClick={onClose}>
          Volver
        </button>
      </div>
      <p className="modal-note history-note">
        Abrir una conversación no gasta nada. Solo al escribir se retoma, y la app elige la forma más barata.
      </p>
      {busy && <p className="modal-note">Espera a que el Cerebro termine para cambiar de conversación.</p>}
      {error && <p className="inputbar-error">{error}</p>}
      <div className="history-scroll">
        {items === undefined ? (
          <p className="modal-note">Cargando…</p>
        ) : items.length === 0 ? (
          <p className="modal-note">{query ? 'Nada coincide con la búsqueda.' : 'Aún no hay conversaciones guardadas.'}</p>
        ) : (
          groupByDay(items).map((group) => (
            <section key={group.label}>
              <h3 className="history-group">{group.label}</h3>
              <ul className="history-list">
                {group.items.map((item) => (
                  <Item
                    key={`${item.id}-${item.title}`}
                    item={item}
                    active={item.id === activeId}
                    disabled={busy}
                    onOpen={() => void open(item.id)}
                    onChanged={() => setVersion((v) => v + 1)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
