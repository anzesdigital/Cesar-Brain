import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import type { IncomingFile } from '@shared/types'
import { useStore } from '../store'

interface Attachment {
  key: string
  name: string
  file: File
}

async function toIncoming(a: Attachment): Promise<IncomingFile> {
  const path = window.brain.pathForFile(a.file)
  if (path) return { name: a.name, path }
  return { name: a.name, data: await a.file.arrayBuffer() }
}

const HEIGHT_KEY = 'inputbar-height'
const MIN_HEIGHT = 44
/** Tallest the box may grow by itself, as a share of the window. */
const AUTO_SHARE = 0.4
/** Tallest the user may drag it, as a share of the window. */
const MAX_SHARE = 0.75

function savedHeight(): number | undefined {
  try {
    const value = Number(localStorage.getItem(HEIGHT_KEY))
    return value >= MIN_HEIGHT ? value : undefined
  } catch {
    return undefined
  }
}

function saveHeight(value: number | undefined): void {
  try {
    if (value) localStorage.setItem(HEIGHT_KEY, String(Math.round(value)))
    else localStorage.removeItem(HEIGHT_KEY)
  } catch {
    // storage blocked: the size just is not remembered
  }
}

/** How the next message will continue a conversation opened from the history. */
function ResumeHint() {
  const resume = useStore((s) => s.status?.conversation.resume)
  const busy = useStore((s) => s.busy)
  if (!resume || busy) return null
  const mode = resume.forced ?? resume.auto
  const other = mode === 'full' ? 'summary' : 'full'
  const size = resume.tokens >= 1000 ? `~${Math.round(resume.tokens / 1000)}k tokens` : `~${resume.tokens} tokens`
  return (
    <p className="resume-hint">
      {mode === 'full' ? (
        <>
          Se retomará con el <strong>contexto completo</strong> ({size}, se paga una vez).
        </>
      ) : (
        <>
          Se retomará con un <strong>resumen</strong> de los últimos mensajes (más barato).
        </>
      )}
      {(other === 'summary' || resume.canFull) && (
        <button
          type="button"
          className="link-button"
          onClick={() => void window.brain.setResumeMode(other === resume.auto ? undefined : other)}
        >
          {other === 'full' ? 'Usar contexto completo' : 'Usar resumen'}
        </button>
      )}
    </p>
  )
}

export function InputBar() {
  const busy = useStore((s) => s.busy)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  /** Height the user dragged to; undefined = grow with the text. */
  const [height, setHeight] = useState<number | undefined>(savedHeight)
  const drag = useRef<{ y: number; h: number } | undefined>(undefined)

  // Grows with the text until AUTO_SHARE of the window, then scrolls. A height
  // chosen by dragging works as the minimum.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => {
      el.style.height = 'auto'
      const border = el.offsetHeight - el.clientHeight
      const content = el.scrollHeight + border
      const cap = Math.max(MIN_HEIGHT, window.innerHeight * AUTO_SHARE, height ?? 0)
      el.style.height = `${Math.min(Math.max(content, height ?? 0, MIN_HEIGHT), cap)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [text, height])

  const clampHeight = (value: number): number =>
    Math.min(Math.max(value, MIN_HEIGHT), Math.max(MIN_HEIGHT, window.innerHeight * MAX_SHARE))

  const onGripDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: box.current?.offsetHeight ?? MIN_HEIGHT }
  }
  const onGripMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    setHeight(clampHeight(drag.current.h + drag.current.y - e.clientY))
  }
  const onGripUp = (): void => {
    if (!drag.current) return
    drag.current = undefined
    setHeight((h) => {
      saveHeight(h)
      return h
    })
  }
  const resizeBy = (delta: number): void => {
    const next = clampHeight((box.current?.offsetHeight ?? MIN_HEIGHT) + delta)
    setHeight(next)
    saveHeight(next)
  }
  const resetHeight = (): void => {
    setHeight(undefined)
    saveHeight(undefined)
  }

  const addFiles = (files: Iterable<File>): void => {
    const added = [...files].map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      name: file.name || `pegado-${Date.now()}.png`,
      file
    }))
    if (added.length) setAttachments((current) => [...current, ...added])
  }

  const submit = async (): Promise<void> => {
    if (busy || (!text.trim() && attachments.length === 0)) return
    setError('')
    try {
      const files = await Promise.all(attachments.map(toIncoming))
      await window.brain.send(text, files)
      setText('')
      setAttachments([])
    } catch (err) {
      setError(`No se pudo enviar: ${(err as Error).message}`)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const onPaste = (e: ClipboardEvent): void => {
    if (e.clipboardData.files.length) {
      e.preventDefault()
      addFiles(e.clipboardData.files)
    }
  }

  return (
    <form
      className={`inputbar${dragging ? ' inputbar-drag' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div
        className="inputbar-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Cambiar el alto del cuadro de texto"
        title="Arrastra para cambiar el alto · doble clic para volver al tamaño automático"
        tabIndex={0}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        onDoubleClick={resetHeight}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') resizeBy(24)
          else if (e.key === 'ArrowDown') resizeBy(-24)
          else if (e.key === 'Escape' || e.key === 'Home') resetHeight()
          else return
          e.preventDefault()
        }}
      />
      {attachments.length > 0 && (
        <ul className="attachments">
          {attachments.map((a) => (
            <li key={a.key}>
              {a.name}
              <button
                type="button"
                aria-label={`Quitar ${a.name}`}
                onClick={() => setAttachments((current) => current.filter((x) => x.key !== a.key))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="inputbar-error">{error}</p>}
      <ResumeHint />
      <div className="inputbar-row">
        <button type="button" className="btn-ghost" onClick={() => picker.current?.click()} title="Adjuntar archivos">
          + Archivo
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={2}
          placeholder={dragging ? 'Suelta los archivos aquí' : 'Pídele algo al Cerebro… (Enter envía, Shift+Enter salto de línea)'}
          aria-label="Mensaje para el Cerebro"
        />
        {busy ? (
          <button type="button" className="btn-stop" onClick={() => void window.brain.stop()}>
            Detener
          </button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!text.trim() && attachments.length === 0}>
            Enviar
          </button>
        )}
      </div>
    </form>
  )
}
