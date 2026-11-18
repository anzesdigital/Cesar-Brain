import { useEffect, useRef } from 'react'
import { BRAIN_ID, type AgentInfo, type AgentState, type SpriteSpec } from '@shared/types'
import { useStore } from '../store'
import { Bubble } from './Bubble'
import { BRAIN_SPRITE, drawSprite, SPRITE_SIZE } from './sprites'

const BRAIN_INFO: AgentInfo = {
  id: BRAIN_ID,
  name: 'Cerebro',
  role: 'Coordinador',
  description: 'Recibe tus peticiones y reparte el trabajo.',
  sprite: BRAIN_SPRITE
}

const BRAIN_POS = { x: 50, y: 34 }
const PER_ROW = 5

/** Desk positions in % of the office, in rows below the brain. */
function deskPosition(index: number, total: number): { x: number; y: number } {
  const row = Math.floor(index / PER_ROW)
  const rows = Math.ceil(total / PER_ROW)
  const inRow = row === rows - 1 ? total - row * PER_ROW : PER_ROW
  const col = index % PER_ROW
  const x = ((col + 1) / (inRow + 1)) * 100
  const y = rows === 1 ? 74 : 62 + row * 22
  return { x, y }
}

function Sprite({ spec, isBrain }: { spec: SpriteSpec; isBrain: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) drawSprite(ref.current, spec, isBrain)
  }, [spec, isBrain])
  return <canvas ref={ref} width={SPRITE_SIZE} height={SPRITE_SIZE} className="sprite" />
}

function Person({ agent, x, y }: { agent: AgentInfo; x: number; y: number }) {
  const thought = useStore((s) => s.thoughts[agent.id])
  const selected = useStore((s) => s.selectedAgent === agent.id)
  const select = useStore((s) => s.select)
  const state: AgentState = thought?.state ?? 'idle'
  const isBrain = agent.id === BRAIN_ID

  return (
    <button
      type="button"
      className={`person person-${state}${isBrain ? ' person-brain' : ''}${selected ? ' person-selected' : ''}`}
      style={{ left: `${x}%`, top: `${y}%` }}
      onClick={() => select(selected ? undefined : agent.id)}
      title={agent.description}
    >
      <Bubble text={thought?.text ?? ''} state={state} />
      <span className="person-body">
        <Sprite spec={agent.sprite} isBrain={isBrain} />
      </span>
      <span className="nameplate">
        <strong>{agent.name}</strong>
        {agent.role && <em>{agent.role}</em>}
      </span>
    </button>
  )
}

function Journal() {
  const selectedId = useStore((s) => s.selectedAgent)
  const agents = useStore((s) => s.agents)
  const history = useStore((s) => (selectedId ? s.history[selectedId] : undefined))
  const select = useStore((s) => s.select)
  if (!selectedId) return null
  const agent = selectedId === BRAIN_ID ? BRAIN_INFO : agents.find((a) => a.id === selectedId)
  if (!agent) return null

  return (
    <aside className="journal">
      <header>
        <strong>Bitácora de {agent.name}</strong>
        <button type="button" onClick={() => select(undefined)} aria-label="Cerrar bitácora">
          ×
        </button>
      </header>
      <p className="journal-desc">{agent.description}</p>
      {history?.length ? (
        <ol>
          {[...history].reverse().map((t) => (
            <li key={t.ts + t.text}>
              <time>{new Date(t.ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
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

export function Office() {
  const agents = useStore((s) => s.agents)
  const thoughts = useStore((s) => s.thoughts)
  const status = useStore((s) => s.status)
  const positions = agents.map((_, i) => deskPosition(i, agents.length))

  return (
    <section className="office" aria-label="Oficina de agentes">
      <div className="office-wall" />
      <svg className="office-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {agents.map((agent, i) => {
          const state = thoughts[agent.id]?.state ?? 'idle'
          if (state === 'idle') return null
          return (
            <line
              key={agent.id}
              x1={BRAIN_POS.x}
              y1={BRAIN_POS.y}
              x2={positions[i].x}
              y2={positions[i].y - 8}
              className={`link link-${state}`}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      </svg>

      <Person agent={BRAIN_INFO} x={BRAIN_POS.x} y={BRAIN_POS.y} />
      {agents.map((agent, i) => (
        <Person key={agent.id} agent={agent} x={positions[i].x} y={positions[i].y} />
      ))}

      {agents.length === 0 && (
        <div className="office-empty">
          <p>El Cerebro está solo. Crea un agente en la carpeta de agentes y aparecerá aquí.</p>
          {status && (
            <button type="button" onClick={() => void window.brain.openPath(status.agentsDir)}>
              Abrir carpeta de agentes
            </button>
          )}
        </div>
      )}
      <Journal />
    </section>
  )
}
