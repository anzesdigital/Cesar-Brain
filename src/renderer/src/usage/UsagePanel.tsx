import { useEffect, useMemo, useState } from 'react'
import { BRAIN_ID, type AgentInfo, type TokenCount, type UsageDay, type UsageLimit, type UsageSnapshot } from '@shared/types'
import { useStore } from '../store'

const RANGES = [7, 14, 30] as const
/** Agents that get their own colour; the rest are drawn together as "Otros". */
const MAX_SERIES = 7
const OTHER_ID = '__otros'

interface Series {
  id: string
  name: string
  /** CSS variable holding the series colour. */
  color: string
}

interface Column {
  date: string
  day?: UsageDay
  values: number[]
  total: number
}

const EMPTY: TokenCount = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Tokens the model actually processed fresh; cache reads are shown apart. */
function fresh(count: TokenCount): number {
  return count.input + count.output + count.cacheWrite
}

function add(a: TokenCount, b: TokenCount): TokenCount {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('es', { maximumFractionDigits: 1 })} M`
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('es', { maximumFractionDigits: n >= 100_000 ? 0 : 1 })} k`
  return String(Math.round(n))
}

function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function lastDates(count: number): string[] {
  const today = new Date()
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1 - i))
    return dayKey(d)
  })
}

function longDate(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' })
}

/** Rounds a maximum up to 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((s) => s * power >= value) ?? 10
  return step * power
}

function untilReset(resetsAt: number, now: number): string {
  const minutes = Math.round((resetsAt - now) / 60000)
  if (minutes <= 0) return 'se renueva ya'
  if (minutes < 60) return `se renueva en ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `se renueva en ${hours} h ${minutes % 60} min`
  return `se renueva en ${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** Fixed colour order: the brain first, then agents by id, so a colour stays with its agent. */
function buildSeries(agents: AgentInfo[], days: UsageDay[]): Series[] {
  const names = new Map<string, string>([[BRAIN_ID, 'Cerebro'], ...agents.map((a) => [a.id, a.name] as [string, string])])
  const seen = new Set<string>(days.flatMap((d) => Object.keys(d.agents)))
  const ids = [BRAIN_ID, ...[...new Set([...agents.map((a) => a.id), ...seen])].filter((id) => id !== BRAIN_ID).sort()]
  const series = ids.slice(0, MAX_SERIES).map((id, i) => ({
    id,
    name: names.get(id) ?? id,
    color: `var(--series-${i + 1})`
  }))
  if (ids.length > MAX_SERIES) series.push({ id: OTHER_ID, name: 'Otros', color: 'var(--series-other)' })
  return series
}

function countFor(day: UsageDay | undefined, series: Series, own: Set<string>): TokenCount {
  if (!day) return EMPTY
  if (series.id !== OTHER_ID) return day.agents[series.id] ?? EMPTY
  return Object.entries(day.agents)
    .filter(([id]) => !own.has(id))
    .reduce((sum, [, count]) => add(sum, count), EMPTY)
}

function Meter({ limit, now }: { limit: UsageLimit; now: number }) {
  // A window whose reset time has passed is empty again, whatever was last read.
  const expired = limit.resetsAt !== undefined && limit.resetsAt <= now
  const percent = expired ? 0 : Math.round(limit.percent)
  const level = percent >= 95 ? 'critical' : percent >= 80 ? 'warn' : 'ok'
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{limit.label}</span>
        <strong>
          {level === 'critical' && <span className="meter-flag meter-flag-critical">▲ al límite</span>}
          {level === 'warn' && <span className="meter-flag meter-flag-warn">▲ casi lleno</span>}
          {percent} %
        </strong>
      </div>
      <div
        className="meter-track"
        role="meter"
        aria-label={limit.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={`meter-fill meter-${level}`} style={{ width: `${percent}%` }} />
      </div>
      {limit.resetsAt !== undefined && !expired && <p className="meter-note">{untilReset(limit.resetsAt, now)}</p>}
    </div>
  )
}

function Limits({ usage, now }: { usage: UsageSnapshot; now: number }) {
  const copilot = usage.limitsProvider === 'copilot'
  if (usage.limitsAvailable === false) {
    return (
      <p className="modal-note">
        {copilot
          ? 'Tu plan de Copilot no tiene límite de premium requests.'
          : 'Esta cuenta usa clave de API: no tiene límites de plan, se paga por uso.'}
      </p>
    )
  }
  if (usage.limits.length === 0) {
    return <p className="modal-note">Aún no hay datos. Aparecen después del primer encargo al Cerebro.</p>
  }
  return (
    <>
      {usage.limits.map((limit) => (
        <Meter key={limit.id} limit={limit} now={now} />
      ))}
      {usage.limitsAt && (
        <p className="modal-note">
          Leído a las {new Date(usage.limitsAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}. Incluye
          todo lo que gastas con tu cuenta de {copilot ? 'GitHub Copilot' : 'Claude'}, no solo esta app.
        </p>
      )}
    </>
  )
}

function Chart({ columns, series }: { columns: Column[]; series: Series[] }) {
  const [hover, setHover] = useState<number>()
  const max = niceMax(Math.max(...columns.map((c) => c.total)))
  const labelEvery = columns.length > 14 ? 5 : columns.length > 7 ? 2 : 1
  const active = hover === undefined ? undefined : columns[hover]

  return (
    <div className="chart">
      <div className="chart-axis" aria-hidden="true">
        <span>{compact(max)}</span>
        <span>{compact(max / 2)}</span>
        <span>0</span>
      </div>
      <div className="chart-plot" onMouseLeave={() => setHover(undefined)}>
        <div className="chart-grid" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {columns.map((column, i) => (
          <button
            type="button"
            key={column.date}
            className={`chart-col${hover === i ? ' chart-col-active' : ''}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(undefined)}
            aria-label={`${longDate(column.date)}: ${compact(column.total)} tokens`}
          >
            <span className="chart-stack">
              {series.map((s, k) =>
                column.values[k] > 0 ? (
                  <span
                    key={s.id}
                    className="chart-seg"
                    style={{ height: `${(column.values[k] / max) * 100}%`, background: s.color }}
                  />
                ) : null
              )}
            </span>
            <span className="chart-tick">{(columns.length - 1 - i) % labelEvery === 0 ? Number(column.date.slice(8)) : ''}</span>
          </button>
        ))}
        {active && hover !== undefined && (
          <div
            className="chart-tip"
            style={
              hover < columns.length / 2
                ? { left: `${((hover + 1) / columns.length) * 100}%` }
                : { right: `${((columns.length - hover) / columns.length) * 100}%` }
            }
          >
            <strong>{longDate(active.date)}</strong>
            {active.total === 0 ? (
              <p>Sin actividad</p>
            ) : (
              <>
                {series.map((s, k) =>
                  active.values[k] > 0 ? (
                    <p key={s.id}>
                      <i style={{ background: s.color }} />
                      <span>{s.name}</span>
                      <b>{compact(active.values[k])}</b>
                    </p>
                  ) : null
                )}
                <p className="chart-tip-total">
                  <span>Total</span>
                  <b>{compact(active.total)}</b>
                </p>
                <p className="chart-tip-note">
                  {active.day?.runs ?? 0} {active.day?.runs === 1 ? 'encargo' : 'encargos'}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function UsagePanel({ onClose }: { onClose: () => void }) {
  const usage = useStore((s) => s.usage)
  const agents = useStore((s) => s.agents)
  const [range, setRange] = useState<(typeof RANGES)[number]>(14)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(timer)
  }, [])

  const view = useMemo(() => {
    const days = usage?.days ?? []
    const byDate = new Map(days.map((d) => [d.date, d]))
    const dates = lastDates(range)
    const inRange = dates.flatMap((date) => byDate.get(date) ?? [])
    const series = buildSeries(agents, inRange)
    const own = new Set(series.map((s) => s.id))
    const columns: Column[] = dates.map((date) => {
      const day = byDate.get(date)
      const values = series.map((s) => fresh(countFor(day, s, own)))
      return { date, day, values, total: values.reduce((a, b) => a + b, 0) }
    })
    const totals = series.map((s) => inRange.reduce((sum, day) => add(sum, countFor(day, s, own)), EMPTY))
    const used = series.filter((_, k) => fresh(totals[k]) > 0 || totals[k].cacheRead > 0)
    return {
      series,
      columns,
      totals,
      legend: used.length ? used : series.slice(0, 1),
      today: columns[columns.length - 1].total,
      tokens: columns.reduce((sum, c) => sum + c.total, 0),
      runs: inRange.reduce((sum, d) => sum + d.runs, 0),
      cost: inRange.reduce((sum, d) => sum + d.costUsd, 0),
      premium: inRange.reduce((sum, d) => sum + (d.premiumRequests ?? 0), 0)
    }
  }, [usage, agents, range])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-labelledby="usage-title" onClick={(e) => e.stopPropagation()}>
        <header className="usage-head">
          <h2 id="usage-title">Uso</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cerrar
          </button>
        </header>

        <section>
          <h3 className="usage-h3">Límites de tu plan{usage?.plan ? ` (${usage.plan})` : ''}</h3>
          {usage ? <Limits usage={usage} now={now} /> : <p className="modal-note">Cargando…</p>}
        </section>

        <section className="settings-section">
          <div className="usage-row">
            <h3 className="usage-h3">Tokens por agente</h3>
            <div className="usage-ranges" role="group" aria-label="Periodo">
              {RANGES.map((r) => (
                <button
                  type="button"
                  key={r}
                  className={`btn-ghost${r === range ? ' usage-range-on' : ''}`}
                  aria-pressed={r === range}
                  onClick={() => setRange(r)}
                >
                  {r} días
                </button>
              ))}
            </div>
          </div>

          <dl className="usage-tiles">
            <div>
              <dt>Hoy</dt>
              <dd>{compact(view.today)}</dd>
            </div>
            <div>
              <dt>{range} días</dt>
              <dd>{compact(view.tokens)}</dd>
            </div>
            <div>
              <dt>Encargos</dt>
              <dd>{view.runs}</dd>
            </div>
            {view.premium > 0 || view.cost === 0 ? (
              <div>
                <dt>Premium requests</dt>
                <dd>{view.premium.toLocaleString('es', { maximumFractionDigits: 1 })}</dd>
              </div>
            ) : null}
            {view.cost > 0 || view.premium === 0 ? (
              <div>
                <dt>Coste estimado</dt>
                <dd>{view.cost.toLocaleString('es', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })}</dd>
              </div>
            ) : null}
          </dl>

          <ul className="usage-legend">
            {view.legend.map((s) => (
              <li key={s.id}>
                <i style={{ background: s.color }} />
                {s.name}
              </li>
            ))}
          </ul>
          <Chart columns={view.columns} series={view.series} />
          <p className="modal-note">
            Tokens nuevos de cada día (entrada, salida y caché escrita), sin contar lecturas de caché. El coste (Claude) es una estimación a precio de lista; con
            suscripción no se cobra aparte. Las premium requests (Copilot) son las que descuenta tu plan.
          </p>

          <details className="usage-table">
            <summary>Ver en tabla</summary>
            <table>
              <thead>
                <tr>
                  <th>Agente</th>
                  <th>Entrada</th>
                  <th>Salida</th>
                  <th>Caché escrita</th>
                  <th>Caché leída</th>
                </tr>
              </thead>
              <tbody>
                {view.series.map((s, k) => (
                  <tr key={s.id}>
                    <th>
                      <i style={{ background: s.color }} />
                      {s.name}
                    </th>
                    <td>{compact(view.totals[k].input)}</td>
                    <td>{compact(view.totals[k].output)}</td>
                    <td>{compact(view.totals[k].cacheWrite)}</td>
                    <td>{compact(view.totals[k].cacheRead)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      </div>
    </div>
  )
}

/** Header button with a tiny meter of the fullest plan limit. */
export function UsageButton({ onClick }: { onClick: () => void }) {
  const usage = useStore((s) => s.usage)
  const now = Date.now()
  const live = (usage?.limits ?? []).filter((l) => l.resetsAt === undefined || l.resetsAt > now)
  const top = live.length ? Math.round(Math.max(...live.map((l) => l.percent))) : undefined
  const level = top === undefined ? 'ok' : top >= 95 ? 'critical' : top >= 80 ? 'warn' : 'ok'
  return (
    <button
      type="button"
      className="btn-ghost usage-button"
      onClick={onClick}
      title={top === undefined ? 'Ver uso' : `Límite más lleno: ${top} %`}
    >
      Uso
      {top !== undefined && (
        <span className="usage-mini" aria-hidden="true">
          <span className={`meter-fill meter-${level}`} style={{ width: `${top}%` }} />
        </span>
      )}
    </button>
  )
}
