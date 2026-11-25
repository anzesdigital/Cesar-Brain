import { useEffect, useState } from 'react'
import type { AutomationInfo, AutomationRun, AutomationTrigger } from '@shared/types'
import { useStore } from '../store'
import { AutomationActions, cleanError, duration, statusLine, useNow } from './controls'

const TRIGGERS: Record<AutomationTrigger, string> = {
  intervalo: 'Programada',
  manual: 'Manual',
  arranque: 'Al arrancar',
  archivos: 'Cambio de archivos',
  agente: 'Antes de un encargo'
}

function when(ts: number): string {
  return new Date(ts).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** What the user approves: every command, agent and extra permission. */
function Review({ automation }: { automation: AutomationInfo }) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const approve = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await window.brain.approveAutomation(automation.id)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="auto-review">
      <p>
        <strong>Antes de activarla, revisa lo que hará sin preguntarte.</strong> Los comandos se ejecutan en tu equipo tal cual
        están escritos{automation.allow.length ? ' y los agentes podrán usar ' : '.'}
        {automation.allow.length > 0 && (
          <>
            <code>{automation.allow.join(', ')}</code> sin pedir permiso.
          </>
        )}{' '}
        Si el archivo cambia, tendrás que aprobarla otra vez.
      </p>
      {error && <p className="inputbar-error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn-primary" disabled={pending} onClick={() => void approve()}>
          Aprobar y activar
        </button>
      </div>
    </div>
  )
}

/** automation.md files that could not be read (they are not in the list). */
export function useAutomationErrors(): string[] {
  const problems = useStore((s) => s.status?.problems)
  return (problems ?? []).filter((p) => p.startsWith('automations/'))
}

function Broken({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return (
    <div className="auto-review auto-broken">
      <p>
        <strong>
          {errors.length === 1 ? 'Una automatización no se puede leer' : `${errors.length} automatizaciones no se pueden leer`}
        </strong>{' '}
        y no aparecen hasta corregirlas:
      </p>
      <ul>
        {errors.map((e) => (
          <li key={e}>
            <code>{e}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Runs({ id, refresh }: { id: string; refresh: number }) {
  const [runs, setRuns] = useState<AutomationRun[]>()
  const [open, setOpen] = useState<number>()
  useEffect(() => {
    let alive = true
    void window.brain.getAutomationRuns(id).then((r) => {
      if (alive) setRuns(r)
    })
    return () => {
      alive = false
    }
  }, [id, refresh])

  if (!runs) return <p className="modal-note">Cargando…</p>
  if (!runs.length) return <p className="modal-note">Aún no se ha ejecutado.</p>
  return (
    <ol className="auto-runs">
      {runs.map((run) => (
        <li key={run.startedAt} className={run.ok ? 'auto-run-ok' : 'auto-run-fail'}>
          <button type="button" className="auto-run-head" aria-expanded={open === run.startedAt} onClick={() => setOpen(open === run.startedAt ? undefined : run.startedAt)}>
            <span className="auto-run-mark" aria-hidden="true">
              {run.ok ? '✓' : '✗'}
            </span>
            <time>{when(run.startedAt)}</time>
            <span>{TRIGGERS[run.trigger]}{run.detail && run.trigger === 'agente' ? ` (${run.detail})` : ''}</span>
            <span className="auto-run-ms">{duration(run.endedAt - run.startedAt)}</span>
          </button>
          {open === run.startedAt && (
            <div className="auto-run-body">
              {run.note && <p className="modal-note">{run.note}</p>}
              {run.steps.map((step, i) => (
                <div key={i} className="auto-run-step">
                  <p>
                    {step.ok ? '✓' : '✗'} {step.name} <small>· {duration(step.ms)}</small>
                  </p>
                  {step.output && <pre>{step.output}</pre>}
                </div>
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

function Detail({ automation, refresh }: { automation: AutomationInfo; refresh: number }) {
  const now = useNow()
  const a = automation
  return (
    <div className="auto-detail">
      <header>
        <h3>{a.name}</h3>
        <span className="modal-note">{statusLine(a, now)}</span>
      </header>
      {a.description && <p className="journal-desc">{a.description}</p>}
      <AutomationActions automation={a} />
      {a.needsApproval && <Review automation={a} />}

      <h4>Cuándo</h4>
      <ul className="auto-tags">
        {a.triggers.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <h4>Pasos {a.onFailure === 'seguir' ? '(si uno falla, sigue)' : '(si uno falla, para)'}</h4>
      <ol className="auto-steps">
        {a.steps.map((step, i) => (
          <li key={i}>
            <strong>{step.name}</strong>
            <small>{step.kind === 'comando' ? `Comando en ${step.where}` : `Encargo a ${step.where}`}</small>
            {step.kind === 'comando' ? <pre>{step.detail}</pre> : <p>{step.detail}</p>}
          </li>
        ))}
      </ol>
      {a.allow.length > 0 && (
        <p className="modal-note">
          Permisos extra para los agentes: <code>{a.allow.join(', ')}</code>
        </p>
      )}
      <div className="modal-actions auto-open">
        <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(a.dir)}>
          Abrir su carpeta
        </button>
      </div>

      <h4>Historial</h4>
      <Runs id={a.id} refresh={refresh} />
    </div>
  )
}

export function AutomationsPanel() {
  const list = useStore((s) => s.automations)
  const focus = useStore((s) => s.automationFocus)
  const close = useStore((s) => s.closeAutomations)
  const openAt = useStore((s) => s.openAutomations)
  const status = useStore((s) => s.status)
  const errors = useAutomationErrors()
  const now = useNow()
  const [refresh, setRefresh] = useState(0)
  const selected = list.find((a) => a.id === focus) ?? list[0]

  // A run finished: reload the history shown.
  useEffect(() => window.brain.onAutomationRun(() => setRefresh((n) => n + 1)), [])

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal modal-wide auto-panel" role="dialog" aria-labelledby="auto-title" onClick={(e) => e.stopPropagation()}>
        <header className="usage-head">
          <h2 id="auto-title">Automatizaciones</h2>
          <button type="button" className="btn-ghost" onClick={close}>
            Cerrar
          </button>
        </header>
        <Broken errors={errors} />
        {list.length === 0 ? (
          <div className="auto-empty">
            <p>
              Aún no hay ninguna. Una automatización corre sola: cada cierto tiempo, al arrancar, cuando cambian archivos o antes
              de que el Cerebro le pase un encargo a un agente. Puede ejecutar comandos (por ejemplo <code>git pull</code>) y
              llamar a agentes.
            </p>
            <p>
              Pídeselo al Cerebro: «crea una automatización que haga pull de main en api cada hora». Rob la escribe y tú la
              apruebas aquí.
            </p>
            {status && (
              <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(status.automationsDir)}>
                Abrir carpeta de automatizaciones
              </button>
            )}
          </div>
        ) : (
          <div className="auto-layout">
            <ul className="auto-list" role="listbox" aria-label="Automatizaciones">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={a.id === selected?.id}
                    className={`auto-item${a.id === selected?.id ? ' auto-item-on' : ''}`}
                    onClick={() => openAt(a.id)}
                  >
                    <span className="auto-swatch" style={{ background: a.color }} aria-hidden="true" />
                    <span className="auto-item-text">
                      <strong>
                        {a.name}
                        {a.needsApproval && ' ⚠'}
                      </strong>
                      <small>{statusLine(a, now)}</small>
                    </span>
                    {a.running ? (
                      <span className="auto-dot auto-dot-run" aria-label="en marcha" />
                    ) : a.lastRun ? (
                      <span className={`auto-dot ${a.lastRun.ok ? 'auto-dot-ok' : 'auto-dot-fail'}`} aria-label={a.lastRun.ok ? 'última bien' : 'última falló'} />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {selected && <Detail automation={selected} refresh={refresh} />}
          </div>
        )}
      </div>
    </div>
  )
}
