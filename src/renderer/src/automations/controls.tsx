import { useEffect, useState } from 'react'
import type { AutomationInfo } from '@shared/types'

export function cleanError(err: unknown): string {
  return (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** "en 12 min", "hace 3 h"… */
export function relative(ts: number, now: number): string {
  const diff = ts - now
  const abs = Math.abs(diff)
  const text =
    abs < 60_000
      ? 'menos de 1 min'
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`
  return diff >= 0 ? `en ${text}` : `hace ${text}`
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('es', { maximumFractionDigits: 1 })} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** One line about where it stands. */
export function statusLine(a: AutomationInfo, now: number): string {
  if (a.running) return 'En marcha…'
  if (a.needsApproval) return a.lastRun ? 'Cambió: revisa y aprueba de nuevo' : 'Pendiente de revisar y aprobar'
  if (!a.enabled) return 'Desactivada'
  if (a.nextRunAt) return `Próxima ejecución ${relative(a.nextRunAt, now)}`
  return 'Activa'
}

/** Run now / stop, and the on-off switch. Approving lives in the panel, next to what is approved. */
export function AutomationActions({ automation, onReview }: { automation: AutomationInfo; onReview?: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const a = automation

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await work()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="auto-actions">
      {a.needsApproval ? (
        onReview && (
          <button type="button" className="btn-primary" onClick={onReview}>
            Revisar y aprobar
          </button>
        )
      ) : (
        <>
          {a.running ? (
            <button type="button" className="btn-ghost" disabled={pending} onClick={() => void act(() => window.brain.stopAutomation(a.id))}>
              Detener
            </button>
          ) : (
            <button type="button" className="btn-ghost" disabled={pending} onClick={() => void act(() => window.brain.runAutomation(a.id))}>
              Ejecutar ahora
            </button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={a.enabled}
            className={`switch${a.enabled ? ' switch-on' : ''}`}
            disabled={pending}
            onClick={() => void act(() => window.brain.setAutomationEnabled(a.id, !a.enabled))}
          >
            <span className="switch-knob" aria-hidden="true" />
            <span className="switch-label">{a.enabled ? 'Activa' : 'Desactivada'}</span>
          </button>
        </>
      )}
      {error && <p className="inputbar-error">{error}</p>}
    </div>
  )
}
