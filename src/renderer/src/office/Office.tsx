import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent
} from 'react'
import {
  AUTOMATION_PREFIX,
  BRAIN_ID,
  robotId,
  type AgentInfo,
  type AgentState,
  type AutomationInfo,
  type SpriteSpec
} from '@shared/types'
import { useAutomationErrors } from '../automations/AutomationsPanel'
import { AutomationActions, statusLine, useNow } from '../automations/controls'
import { useStore } from '../store'
import { Bubble } from './Bubble'
import { BRAIN_SPRITE, drawRobot, drawSprite, SPRITE_SIZE } from './sprites'
import { BRAIN_ZONE, fitView, groupZones, zoneKey, zoomAt, type View } from './zones'

const BRAIN_INFO: AgentInfo = {
  id: BRAIN_ID,
  name: 'Cerebro',
  role: 'Coordinador',
  description: 'Recibe tus peticiones y reparte el trabajo.',
  sprite: BRAIN_SPRITE,
  zone: BRAIN_ZONE
}

const ZOOM_STEP = 1.25
/** Room where the automation robots work. */
const WORKSHOP = 'Taller'
const WORKSHOP_COLOR = '#8f98b8'
/** Height kept clear for the zoom buttons when fitting. */
const ZOOM_BAR = 44

function Sprite({ spec, isBrain }: { spec: SpriteSpec; isBrain: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Desk, laptop and the brain's colors come from the skin.
  const skin = useStore((s) => s.status?.skin)
  useEffect(() => {
    if (ref.current) drawSprite(ref.current, spec, isBrain)
  }, [spec, isBrain, skin])
  return <canvas ref={ref} width={SPRITE_SIZE} height={SPRITE_SIZE} className="sprite" />
}

function Person({ agent, register }: { agent: AgentInfo; register: (id: string, el: HTMLElement | null) => void }) {
  const thought = useStore((s) => s.thoughts[agent.id])
  const selected = useStore((s) => s.selectedAgent === agent.id)
  const select = useStore((s) => s.select)
  const state: AgentState = thought?.state ?? 'idle'
  const isBrain = agent.id === BRAIN_ID
  const off = Boolean(agent.disabled)
  const who = agent.role ? `${agent.name} — ${agent.role}` : agent.name

  return (
    <div
      className={`person-slot${state === 'idle' ? '' : ' person-slot-active'}`}
      // The most recent thought is drawn on top of its neighbours'.
      style={state === 'idle' || !thought ? undefined : { zIndex: 3 + (Math.floor(thought.ts / 100) % 10_000_000) }}
    >
      <button
        type="button"
        className={`person person-${state}${isBrain ? ' person-brain' : ''}${selected ? ' person-selected' : ''}${off ? ' person-off' : ''}`}
        onClick={() => select(selected ? undefined : agent.id)}
        title={`${who}${off ? ' (desactivado)' : ''}\n${agent.description}`}
      >
        <Bubble text={thought?.text ?? ''} state={state} />
        <span className="person-body" ref={(el) => register(agent.id, el)}>
          <Sprite spec={agent.sprite} isBrain={isBrain} />
        </span>
        <span className="nameplate">{agent.name}</span>
      </button>
      {!isBrain && <AgentToggle agent={agent} compact />}
    </div>
  )
}

function RobotSprite({ color, lit }: { color: string; lit: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const skin = useStore((s) => s.status?.skin)
  useEffect(() => {
    if (ref.current) drawRobot(ref.current, color, lit)
  }, [color, lit, skin])
  return <canvas ref={ref} width={SPRITE_SIZE} height={SPRITE_SIZE} className="sprite" />
}

/** An automation, drawn as a robot at its desk. */
function Robot({ automation }: { automation: AutomationInfo }) {
  const id = robotId(automation.id)
  const thought = useStore((s) => s.thoughts[id])
  const selected = useStore((s) => s.selectedAgent === id)
  const select = useStore((s) => s.select)
  const now = useNow()
  const state: AgentState = thought?.state ?? 'idle'
  const off = !automation.enabled || automation.needsApproval
  return (
    <div className={`person-slot${state === 'idle' ? '' : ' person-slot-active'}`}>
      <button
        type="button"
        className={`person person-${state} person-robot${selected ? ' person-selected' : ''}${off ? ' person-off' : ''}`}
        onClick={() => select(selected ? undefined : id)}
        title={`${automation.name} (automatización)
${statusLine(automation, now)}${automation.description ? `
${automation.description}` : ''}`}
      >
        <Bubble text={thought?.text ?? ''} state={state} />
        <span className="person-body">
          <RobotSprite color={automation.color} lit={automation.running || state !== 'idle'} />
        </span>
        <span className="nameplate">
          {automation.name}
          {automation.needsApproval && ' ⚠'}
        </span>
      </button>
    </div>
  )
}

function RobotJournal({ id }: { id: string }) {
  const automation = useStore((s) => s.automations.find((a) => robotId(a.id) === id))
  const history = useStore((s) => s.history[id])
  const select = useStore((s) => s.select)
  const open = useStore((s) => s.openAutomations)
  const now = useNow()
  if (!automation) return null
  return (
    <aside className="journal">
      <header>
        <strong>
          {automation.name}
          <em> · Automatización</em>
        </strong>
        <button type="button" onClick={() => select(undefined)} aria-label="Cerrar bitácora">
          ×
        </button>
      </header>
      {automation.description && <p className="journal-desc">{automation.description}</p>}
      <p className="journal-desc">
        {statusLine(automation, now)} · {automation.triggers.join(' · ')}
      </p>
      <AutomationActions automation={automation} onReview={() => open(automation.id)} />
      <button type="button" className="btn-ghost journal-more" onClick={() => open(automation.id)}>
        Ajustes e historial
      </button>
      {history?.length ? (
        <ol>
          {[...history].reverse().map((t) => (
            <li key={t.ts + t.text}>
              <time>
                {new Date(t.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
              {t.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="journal-empty">No ha trabajado en esta sesión.</p>
      )}
    </aside>
  )
}

/** Switches an agent on or off; the brain cannot use agents that are off. */
function AgentToggle({ agent, compact = false }: { agent: AgentInfo; compact?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const on = !agent.disabled

  const flip = async (): Promise<void> => {
    setPending(true)
    setError('')
    try {
      await window.brain.setAgentEnabled(agent.id, !on)
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setPending(false)
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        className={`person-toggle${on ? '' : ' person-toggle-off'}`}
        disabled={pending}
        aria-label={on ? `Desactivar a ${agent.name}` : `Activar a ${agent.name}`}
        title={error || (on ? 'Desactivar (el Cerebro no lo usará)' : 'Activar')}
        onClick={() => void flip()}
      >
        {on ? '×' : '+'}
      </button>
    )
  }

  return (
    <div className="journal-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className={`switch${on ? ' switch-on' : ''}`}
        disabled={pending}
        onClick={() => void flip()}
      >
        <span className="switch-knob" aria-hidden="true" />
        <span className="switch-label">{on ? 'Activo' : 'Desactivado'}</span>
      </button>
      <small>{on ? 'El Cerebro puede encargarle trabajo.' : 'El Cerebro no lo usará hasta que lo actives.'}</small>
      {error && <p className="inputbar-error">{error}</p>}
    </div>
  )
}

function Journal() {
  const selectedId = useStore((s) => s.selectedAgent)
  const agents = useStore((s) => s.agents)
  const history = useStore((s) => (selectedId ? s.history[selectedId] : undefined))
  const select = useStore((s) => s.select)
  if (!selectedId) return null
  if (selectedId.startsWith(AUTOMATION_PREFIX)) return <RobotJournal id={selectedId} />
  const agent = selectedId === BRAIN_ID ? BRAIN_INFO : agents.find((a) => a.id === selectedId)
  if (!agent) return null

  return (
    <aside className="journal">
      <header>
        <strong>
          {agent.name}
          {agent.role && <em> · {agent.role}</em>}
        </strong>
        <button type="button" onClick={() => select(undefined)} aria-label="Cerrar bitácora">
          ×
        </button>
      </header>
      <p className="journal-desc">{agent.description}</p>
      {agent.id !== BRAIN_ID && <AgentToggle agent={agent} />}
      {history?.length ? (
        <ol>
          {[...history].reverse().map((t) => (
            <li key={t.ts + t.text}>
              <time>
                {new Date(t.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
              {t.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className="journal-empty">Todavía no ha hecho nada en esta sesión.</p>
      )}
    </aside>
  )
}

/** Position of `el` inside `ancestor`, in unscaled layout pixels. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): { x: number; y: number } {
  let x = el.offsetWidth / 2
  let y = el.offsetHeight / 2
  let node: HTMLElement | null = el
  while (node && node !== ancestor) {
    x += node.offsetLeft
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return { x, y }
}

function ZoomControls({
  zoom,
  onZoom,
  onReset,
  onFit
}: {
  zoom: number
  onZoom: (factor: number) => void
  onReset: () => void
  onFit: () => void
}) {
  return (
    <div className="zoom-controls" role="group" aria-label="Zoom de la oficina">
      <button type="button" onClick={() => onZoom(1 / ZOOM_STEP)} aria-label="Alejar" title="Alejar (Ctrl + rueda)">
        −
      </button>
      <button type="button" className="zoom-value" onClick={onReset} title="Volver al 100 %">
        {Math.round(zoom * 100)} %
      </button>
      <button type="button" onClick={() => onZoom(ZOOM_STEP)} aria-label="Acercar" title="Acercar (Ctrl + rueda)">
        +
      </button>
      <button type="button" onClick={onFit} title="Ver toda la oficina (doble clic en el suelo)">
        Ajustar
      </button>
    </div>
  )
}

export function Office() {
  const agents = useStore((s) => s.agents)
  const thoughts = useStore((s) => s.thoughts)
  const status = useStore((s) => s.status)
  const automations = useStore((s) => s.automations)
  const automationErrors = useAutomationErrors()
  const openAutomations = useStore((s) => s.openAutomations)
  const zones = useMemo(() => groupZones(agents), [agents])
  const workshopActive = automations.some((a) => (thoughts[robotId(a.id)]?.state ?? 'idle') !== 'idle')

  const viewport = useRef<HTMLElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const bodies = useRef(new Map<string, HTMLElement>())
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  /** Keep fitting the whole office until the user zooms or pans by hand. */
  const [auto, setAuto] = useState(true)
  const [sizes, setSizes] = useState({
    world: { w: 0, h: 0 },
    /** Area the rooms take up, with room for bubbles above. */
    content: { x: 0, y: 0, w: 0, h: 0 },
    viewport: { w: 0, h: 0 }
  })
  const [spots, setSpots] = useState<Record<string, { x: number; y: number }>>({})

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) bodies.current.set(id, el)
    else bodies.current.delete(id)
  }, [])

  // Measure the world, the viewport and every person (for the links).
  const measure = useCallback(() => {
    const w = world.current
    const v = viewport.current
    if (!w || !v) return
    const rooms = [...w.querySelectorAll<HTMLElement>('.room')]
    const left = Math.min(...rooms.map((r) => r.offsetLeft))
    const top = Math.min(...rooms.map((r) => r.offsetTop))
    const right = Math.max(...rooms.map((r) => r.offsetLeft + r.offsetWidth))
    const bottom = Math.max(...rooms.map((r) => r.offsetTop + r.offsetHeight))
    const content = rooms.length
      ? { x: left, y: top - 24, w: right - left, h: bottom - top + 24 }
      : { x: 0, y: 0, w: w.offsetWidth, h: w.offsetHeight }
    setSizes({
      world: { w: w.offsetWidth, h: w.offsetHeight },
      content,
      viewport: { w: v.clientWidth, h: v.clientHeight }
    })
    const next: Record<string, { x: number; y: number }> = {}
    for (const [id, el] of bodies.current) next[id] = offsetWithin(el, w)
    setSpots(next)
  }, [])

  useLayoutEffect(measure, [zones, automations.length, automationErrors.length, measure])

  useEffect(() => {
    const observer = new ResizeObserver(measure)
    if (world.current) observer.observe(world.current)
    if (viewport.current) observer.observe(viewport.current)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    // Keep the zoom buttons' strip at the bottom free.
    if (auto) setView(fitView(sizes.content, { w: sizes.viewport.w, h: sizes.viewport.h - ZOOM_BAR }))
  }, [auto, sizes])

  const fit = (): void => setAuto(true)
  const zoomBy = (factor: number, px?: number, py?: number): void => {
    setAuto(false)
    setView((v) => zoomAt(v, factor, px ?? sizes.viewport.w / 2, py ?? sizes.viewport.h / 2))
  }
  const reset = (): void => zoomBy(1 / view.zoom)

  // Wheel: Ctrl/pinch zooms at the cursor, plain wheel pans. Needs a non-passive listener.
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement).closest('.journal')) return
      e.preventDefault()
      setAuto(false)
      const rect = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
        setView((v) => zoomAt(v, factor, e.clientX - rect.left, e.clientY - rect.top))
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Drag the floor to pan; two fingers pinch to zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const onPointerDown = (e: PointerEvent<HTMLElement>): void => {
    if ((e.target as HTMLElement).closest('.person-slot, .zoom-controls, .journal, .office-empty')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }
  const onPointerMove = (e: PointerEvent<HTMLElement>): void => {
    const previous = pointers.current.get(e.pointerId)
    if (!previous) return
    const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId).map(([, p]) => p)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setAuto(false)
    if (others.length === 1) {
      const rect = e.currentTarget.getBoundingClientRect()
      const other = others[0]
      const before = Math.hypot(previous.x - other.x, previous.y - other.y)
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y)
      if (before > 0) {
        const mx = (e.clientX + other.x) / 2 - rect.left
        const my = (e.clientY + other.y) / 2 - rect.top
        setView((v) => zoomAt(v, after / before, mx, my))
      }
    } else {
      setView((v) => ({ ...v, x: v.x + e.clientX - previous.x, y: v.y + e.clientY - previous.y }))
    }
  }
  const onPointerUp = (e: PointerEvent<HTMLElement>): void => {
    pointers.current.delete(e.pointerId)
  }

  const brainSpot = spots[BRAIN_ID]
  const worldStyle = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    '--zoom': view.zoom
  } as CSSProperties

  return (
    <section
      ref={viewport}
      className="office"
      aria-label="Oficina de agentes"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest('.person-slot, .zoom-controls, .journal')) fit()
      }}
    >
      <div ref={world} className="office-world" style={worldStyle}>
        {zones.map((zone) => {
          const people = zone.key === zoneKey(BRAIN_ZONE) ? [BRAIN_INFO, ...zone.agents] : zone.agents
          const active = people.some((p) => (thoughts[p.id]?.state ?? 'idle') !== 'idle')
          const cols = Math.min(4, Math.max(2, people.length))
          const main = zone.key === zoneKey(BRAIN_ZONE)
          return (
            <Fragment key={zone.key}>
              <div
                className={`room${zone.key === zoneKey(BRAIN_ZONE) ? ' room-main' : ''}${active ? ' room-active' : ''}`}
                style={{ '--room': zone.color, '--cols': cols } as CSSProperties}
              >
                <header className="room-label">
                  {zone.name}
                  <span>{zone.key === zoneKey(BRAIN_ZONE) ? people.length : zone.agents.length}</span>
                </header>
                <div className="room-floor">
                  {people.map((agent) => (
                    <Person key={agent.id} agent={agent} register={register} />
                  ))}
                </div>
              </div>
              {main && <div className="room-break" />}
            </Fragment>
          )
        })}

        {(automations.length > 0 || automationErrors.length > 0) && (
          <div
            className={`room room-workshop${workshopActive ? ' room-active' : ''}`}
            style={{ '--room': WORKSHOP_COLOR, '--cols': Math.min(4, Math.max(2, automations.length)) } as CSSProperties}
          >
            <header className="room-label">
              {WORKSHOP}
              <span>{automations.length}</span>
            </header>
            <div className="room-floor">
              {automations.map((a) => (
                <Robot key={a.id} automation={a} />
              ))}
            </div>
            {automationErrors.length > 0 && (
              <button type="button" className="btn-ghost room-broken" onClick={() => openAutomations()}>
                ⚠ {automationErrors.length} sin leer
              </button>
            )}
          </div>
        )}

        {brainSpot && (
          <svg
            className="office-links"
            width={sizes.world.w}
            height={sizes.world.h}
            viewBox={`0 0 ${sizes.world.w} ${sizes.world.h}`}
            aria-hidden="true"
          >
            {agents.map((agent) => {
              const state = thoughts[agent.id]?.state ?? 'idle'
              const spot = spots[agent.id]
              if (state === 'idle' || !spot) return null
              return (
                <line
                  key={agent.id}
                  x1={brainSpot.x}
                  y1={brainSpot.y}
                  x2={spot.x}
                  y2={spot.y}
                  className={`link link-${state}`}
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}
          </svg>
        )}
      </div>

      <ZoomControls zoom={view.zoom} onZoom={(f) => zoomBy(f)} onReset={reset} onFit={fit} />

      {agents.length === 0 && (
        <div className="office-empty">
          <p>El Cerebro está solo. Pídele a Ada que cree un agente, o añade uno a la carpeta de agentes.</p>
          {status && (
            <button type="button" className="btn-ghost" onClick={() => void window.brain.openPath(status.agentsDir)}>
              Abrir carpeta de agentes
            </button>
          )}
        </div>
      )}
      <Journal />
    </section>
  )
}
