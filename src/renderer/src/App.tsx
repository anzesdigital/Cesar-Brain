import { useEffect, useRef, useState } from 'react'
import { BRAIN_ID } from '@shared/types'
import { InputBar } from './chat/InputBar'
import { OutputPanel } from './chat/OutputPanel'
import { Office } from './office/Office'
import { useStore } from './store'
import { UsagePanel } from './usage/UsagePanel'

function PermissionModal() {
  const request = useStore((s) => s.permissions[0])
  const agents = useStore((s) => s.agents)
  const shift = useStore((s) => s.shiftPermission)
  const deny = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    deny.current?.focus()
  }, [request?.id])

  if (!request) return null
  const who =
    request.agentId === BRAIN_ID
      ? 'El Cerebro'
      : (agents.find((a) => a.id === request.agentId)?.name ?? 'Un agente')

  const answer = (allow: boolean): void => {
    void window.brain.respondPermission(request.id, allow)
    shift()
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="perm-title">
        <h2 id="perm-title">{who} pide permiso</h2>
        <p className="modal-summary">{request.summary}</p>
        <p className="modal-note">Esto ocurre fuera de la carpeta de trabajo o ejecuta algo en tu equipo.</p>
        <div className="modal-actions">
          <button ref={deny} type="button" className="btn-ghost" onClick={() => answer(false)}>
            No permitir
          </button>
          <button type="button" className="btn-primary" onClick={() => answer(true)}>
            Permitir esta vez
          </button>
        </div>
      </div>
    </div>
  )
}

function GoogleSettings() {
  const status = useStore((s) => s.status)
  const setStatus = useStore((s) => s.setStatus)
  const [keyJson, setKeyJson] = useState('')
  const [keyName, setKeyName] = useState('')
  const [url, setUrl] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [found, setFound] = useState<string[]>([])
  const connected = status?.google.connected ?? false

  const connect = async (): Promise<void> => {
    setWorking(true)
    setError('')
    setFound([])
    try {
      setFound(await window.brain.connectGoogle(keyJson, url))
      setStatus(await window.brain.getStatus())
    } catch (err) {
      // Electron prefixes IPC errors; keep only the human part.
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setWorking(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    await window.brain.disconnectGoogle()
    setFound([])
    setStatus(await window.brain.getStatus())
  }

  return (
    <section className="settings-section">
      <h3>Google Sheets (presupuesto)</h3>
      {connected ? (
        <p className="modal-ok">
          Conectado como <strong>{status?.google.email}</strong>
        </p>
      ) : (
        <details>
          <summary>Cómo conectarlo (una sola vez, unos 10 minutos)</summary>
          <ol>
            <li>Entra en console.cloud.google.com y crea un proyecto.</li>
            <li>En "APIs y servicios" activa la "Google Sheets API".</li>
            <li>En "Credenciales" crea una "Cuenta de servicio".</li>
            <li>Dentro de la cuenta: Claves → Agregar clave → JSON. Se descarga un archivo.</li>
            <li>Abre tu hoja de presupuesto → Compartir → pega el correo de la cuenta de servicio como Editor.</li>
            <li>Carga aquí el archivo JSON y pega la dirección de la hoja.</li>
          </ol>
        </details>
      )}
      <label htmlFor="google-key">Clave de la cuenta de servicio (.json)</label>
      <input
        id="google-key"
        type="file"
        accept=".json,application/json"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          setKeyName(file.name)
          void file.text().then(setKeyJson)
        }}
      />
      {connected && !keyName && <p className="modal-note">Ya hay una clave guardada; solo cárgala si quieres cambiarla.</p>}
      <label htmlFor="google-url">Dirección de la hoja</label>
      <input
        id="google-url"
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://docs.google.com/spreadsheets/d/…"
        autoComplete="off"
      />
      <p className="modal-note">Para probar sin riesgo, conecta primero una copia de tu hoja.</p>
      {error && <p className="inputbar-error">{error}</p>}
      {found.length > 0 && <p className="modal-ok">Conexión correcta. Hojas: {found.join(', ')}</p>}
      <div className="modal-actions">
        {connected && (
          <button type="button" className="btn-ghost" onClick={() => void disconnect()}>
            Desconectar
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={working || !url.trim() || (!keyJson && !connected)}
          onClick={() => void connect()}
        >
          {working ? 'Probando…' : 'Conectar y probar'}
        </button>
      </div>
    </section>
  )
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const status = useStore((s) => s.status)
  const setStatus = useStore((s) => s.setStatus)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')

  const save = async (value: string): Promise<void> => {
    try {
      await window.brain.setApiKey(value)
      setStatus(await window.brain.getStatus())
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Ajustes</h2>
        <label htmlFor="api-key">Clave de API de Anthropic</label>
        <input
          id="api-key"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={status?.hasApiKey ? 'Hay una clave guardada' : 'sk-ant-…'}
          autoComplete="off"
        />
        <p className="modal-note">
          Se guarda cifrada en este equipo. Si no pones clave, se intenta usar la sesión de Claude Code que ya
          exista en este equipo.
        </p>
        {error && <p className="inputbar-error">{error}</p>}
        <div className="modal-actions">
          {status?.hasApiKey && (
            <button type="button" className="btn-ghost" onClick={() => void save('')}>
              Borrar clave
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
          <button type="button" className="btn-primary" disabled={!key.trim()} onClick={() => void save(key)}>
            Guardar
          </button>
        </div>
        <GoogleSettings />
      </div>
    </div>
  )
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  useEffect(() => {
    const s = useStore.getState()
    const api = window.brain
    void api.getAgents().then(s.setAgents)
    void api.getHistory().then(s.setMessages)
    void api.getUsage().then(s.setUsage)
    void api.getStatus().then((status) => {
      s.setStatus(status)
      s.setBusy(status.busy)
    })
    const unsubscribe = [
      api.onAgents(s.setAgents),
      api.onThought(s.addThought),
      api.onDelta(s.setStreamText),
      api.onMessage(s.addMessage),
      api.onBusy(s.setBusy),
      api.onUsage(s.setUsage),
      api.onPermission(s.pushPermission)
    ]
    return () => unsubscribe.forEach((off) => off())
  }, [])

  return (
    <div className="app">
      <main className="stage">
        <Office />
        <InputBar />
      </main>
      <OutputPanel onSettings={() => setSettingsOpen(true)} onUsage={() => setUsageOpen(true)} />
      <PermissionModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}
    </div>
  )
}
