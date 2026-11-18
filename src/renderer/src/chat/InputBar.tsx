import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
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

export function InputBar() {
  const busy = useStore((s) => s.busy)
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const picker = useRef<HTMLInputElement>(null)

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
