import { useEffect, useRef, useState } from 'react'
import { BRAIN_ID, PROVIDERS, SKINS, type AppStatus, type ProviderAuth, type ProviderId, type SkinId } from '@shared/types'
import { InputBar } from './chat/InputBar'
import { OutputPanel } from './chat/OutputPanel'
import { Office } from './office/Office'
import { applySkin } from './skin'
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

function cleanError(err: unknown): string {
  // Electron prefixes IPC errors; keep only the human part.
  return (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function ProviderSettings() {
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy)
  const [auth, setAuth] = useState<ProviderAuth>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const provider = status?.provider

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setAuth(await window.brain.checkProvider())
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    setAuth(undefined)
    if (provider) void check()
  }, [provider])

  const choose = async (id: ProviderId): Promise<void> => {
    setError('')
    try {
      await window.brain.setProvider(id)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <section className="settings-block">
      <h3>Proveedor</h3>
      <div className="usage-ranges" role="group" aria-label="Proveedor">
        {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => (
          <button
            type="button"
            key={id}
            className={`btn-ghost${id === provider ? ' usage-range-on' : ''}`}
            aria-pressed={id === provider}
            disabled={busy}
            onClick={() => void choose(id)}
          >
            {PROVIDERS[id]}
          </button>
        ))}
      </div>
      <p className="modal-note">Cambiar de proveedor empieza una conversación nueva. Se guarda en config.json.</p>
      {error && <p className="inputbar-error">{error}</p>}
      {auth ? (
        <p className={auth.ready ? 'modal-ok' : 'inputbar-error'}>{auth.detail}</p>
      ) : (
        <p className="modal-note">{checking ? 'Comprobando sesión…' : ''}</p>
      )}
      <button type="button" className="btn-ghost" disabled={checking} onClick={() => void check()}>
        Volver a comprobar
      </button>
    </section>
  )
}

function ReposSettings() {
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy)
  const [error, setError] = useState('')
  if (!status) return null

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await work()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <section className="settings-section">
      <h3>Repositorios</h3>
      <p className="modal-note">
        Carpetas de código en las que pueden trabajar los agentes. En <strong>lectura</strong> solo leen; en{' '}
        <strong>escritura</strong> también modifican archivos sin preguntar. Los comandos siempre piden permiso. Un agente
        puede limitarse a algunos con <code>repos: [nombre]</code> en su agent.md.
      </p>
      {status.repos.length > 0 ? (
        <ul className="repo-list">
          {status.repos.map((repo) => (
            <li key={repo.name} className={repo.exists ? undefined : 'repo-missing'}>
              <div className="repo-info">
                <strong>{repo.name}</strong>
                <code title={repo.path}>{repo.path}</code>
                {!repo.exists && <em>No existe en este equipo</em>}
              </div>
              <div className="usage-ranges" role="group" aria-label={`Acceso a ${repo.name}`}>
                {[false, true].map((write) => (
                  <button
                    key={String(write)}
                    type="button"
                    className={`btn-ghost${repo.write === write ? ' usage-range-on' : ''}`}
                    aria-pressed={repo.write === write}
                    disabled={busy}
                    onClick={() => void run(() => window.brain.setRepoAccess(repo.name, write))}
                  >
                    {write ? 'Escritura' : 'Lectura'}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost repo-remove"
                disabled={busy}
                aria-label={`Quitar ${repo.name}`}
                title="Quitar (no borra la carpeta)"
                onClick={() => void run(() => window.brain.removeRepo(repo.name))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="modal-note">Aún no hay ninguno.</p>
      )}
      {error && <p className="inputbar-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => void run(() => window.brain.addRepo())}>
          Añadir carpeta…
        </button>
      </div>
    </section>
  )
}

function AgentsSettings() {
  const status = useStore((s) => s.status)
  if (!status) return null
  return (
    <section className="settings-section">
      <h3>Agentes y configuración</h3>
      <p className="modal-note">
        Cada agente es una carpeta con un <code>agent.md</code> dentro de <code>{status.agentsDir}</code>. Añade, edita o
        borra carpetas y el equipo se actualiza solo. Una carpeta que empieza por <code>_</code> queda desactivada.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(status.agentsDir)}>
          Abrir carpeta de agentes
        </button>
        <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(status.homeDir)}>
          Abrir carpeta de configuración
        </button>
      </div>
      {status.problems.length > 0 && (
        <>
          <p className="inputbar-error">Hay cosas que revisar:</p>
          <ul className="settings-problems">
            {status.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function SkinSettings() {
  const skin = useStore((s) => s.status?.skin)
  const [error, setError] = useState('')

  const choose = async (id: SkinId): Promise<void> => {
    setError('')
    try {
      await window.brain.setSkin(id)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <section className="settings-block">
      <h3>Aspecto</h3>
      <div className="usage-ranges" role="group" aria-label="Aspecto">
        {(Object.keys(SKINS) as SkinId[]).map((id) => (
          <button
            type="button"
            key={id}
            className={`btn-ghost${id === skin ? ' usage-range-on' : ''}`}
            aria-pressed={id === skin}
            onClick={() => void choose(id)}
          >
            {SKINS[id]}
          </button>
        ))}
      </div>
      <p className="modal-note">Solo cambia los colores. Se guarda en config.json.</p>
      {error && <p className="inputbar-error">{error}</p>}
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
      setKey('')
    } catch (err) {
      setError(cleanError(err))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Ajustes</h2>
        <ProviderSettings />
        <SkinSettings />
        {status?.provider === 'claude' && (
          <section className="settings-section">
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
              <button type="button" className="btn-primary" disabled={!key.trim()} onClick={() => void save(key)}>
                Guardar clave
              </button>
            </div>
          </section>
        )}
        <ReposSettings />
        <AgentsSettings />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}

type View = 'office' | 'chat'

/** Office/chat switch for narrow windows; marks unseen answers. */
function ViewTabs({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const count = useStore((s) => s.messages.length)
  const busy = useStore((s) => s.busy)
  const [seen, setSeen] = useState(count)
  useEffect(() => {
    if (view === 'chat') setSeen(count)
  }, [view, count])
  const unread = view !== 'chat' && count > seen

  return (
    <nav className="viewtabs" role="tablist" aria-label="Vista">
      <button type="button" role="tab" aria-selected={view === 'office'} onClick={() => onChange('office')}>
        Oficina{busy && view !== 'office' ? ' …' : ''}
      </button>
      <button type="button" role="tab" aria-selected={view === 'chat'} onClick={() => onChange('chat')}>
        Chat
        {unread && <span className="viewtabs-dot" aria-label="respuesta nueva" />}
      </button>
    </nav>
  )
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [view, setView] = useState<View>('office')

  useEffect(() => {
    const s = useStore.getState()
    const api = window.brain
    void api.getAgents().then(s.setAgents)
    void api.getHistory().then(s.setMessages)
    void api.getUsage().then(s.setUsage)
    // The skin goes on <html> before the store update, so sprites repaint with its colors.
    const onStatus = (status: AppStatus): void => {
      applySkin(status.skin)
      s.setStatus(status)
    }
    void api.getStatus().then((status) => {
      onStatus(status)
      s.setBusy(status.busy)
    })
    const unsubscribe = [
      api.onAgents(s.setAgents),
      api.onStatus(onStatus),
      api.onReset(s.clearConversation),
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
    <div className="app" data-view={view}>
      <ViewTabs view={view} onChange={setView} />
      <main className="stage">
        <Office />
      </main>
      <OutputPanel onSettings={() => setSettingsOpen(true)} onUsage={() => setUsageOpen(true)} />
      <div className="input-area">
        <InputBar />
      </div>
      <PermissionModal />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {usageOpen && <UsagePanel onClose={() => setUsageOpen(false)} />}
    </div>
  )
}
