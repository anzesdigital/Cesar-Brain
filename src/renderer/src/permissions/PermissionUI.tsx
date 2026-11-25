import { useEffect, useRef, useState } from 'react'
import {
  BRAIN_ID,
  PERMISSION_MODES,
  type AgentInfo,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionRule
} from '@shared/types'
import { cleanError } from '../automations/controls'
import { useStore } from '../store'

const MODE_DETAIL: Record<PermissionMode, string> = {
  preguntar: 'Pregunta antes de cada comando y de cada archivo fuera de la carpeta de trabajo y de los repos.',
  ediciones: 'Lee y escribe archivos en cualquier carpeta sin preguntar. Los comandos y MCP siguen preguntando.',
  automatico:
    'Lee donde haga falta, escribe solo en el workspace y en los repos con escritura, y ejecuta sin preguntar comandos que solo leen o comprueban (git status, npm test…). Ante la duda, pregunta.',
  todo: 'Nunca pregunta: los agentes pueden ejecutar cualquier comando y tocar cualquier archivo de tu equipo. Solo siguen valiendo los repos de solo lectura y tus reglas de «Nunca».'
}

function agentName(id: string, agents: AgentInfo[]): string {
  if (id === BRAIN_ID) return 'El Cerebro'
  return agents.find((a) => a.id === id)?.name ?? id
}

function toolLabel(tool: string): string {
  if (tool === 'Bash' || tool === 'PowerShell') return 'Comando'
  if (tool === 'Write' || tool === 'Edit') return 'Escribir archivos'
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return 'Leer archivos'
  if (tool.startsWith('mcp__')) return `MCP ${tool.split('__').slice(1).join(' › ')}`
  return tool
}

function patternLabel(rule: PermissionRule): string {
  if (!rule.pattern) return rule.tool === 'Bash' ? 'cualquier comando' : 'todo'
  return rule.tool === 'Bash' ? `${rule.pattern} …` : rule.pattern
}

export function RuleText({ rule, agents }: { rule: PermissionRule; agents: AgentInfo[] }) {
  return (
    <>
      <strong>{toolLabel(rule.tool)}</strong> · <code>{patternLabel(rule)}</code> ·{' '}
      <em>{rule.agent ? `solo ${agentName(rule.agent, agents)}` : 'todos'}</em>
    </>
  )
}

export function PermissionModal() {
  const request = useStore((s) => s.permissions[0])
  const agents = useStore((s) => s.agents)
  const mode = useStore((s) => s.status?.permissions.mode ?? 'preguntar')
  const shift = useStore((s) => s.shiftPermission)
  const deny = useRef<HTMLButtonElement>(null)
  const [always, setAlways] = useState(false)
  const [pattern, setPattern] = useState('')
  const [onlyAgent, setOnlyAgent] = useState(true)

  useEffect(() => {
    deny.current?.focus()
    setAlways(false)
    setPattern(request?.suggestion?.pattern ?? '')
    setOnlyAgent(true)
  }, [request?.id, request?.suggestion?.pattern])

  if (!request) return null
  const who = request.agentId === BRAIN_ID ? 'El Cerebro' : (agents.find((a) => a.id === request.agentId)?.name ?? 'Un agente')
  const suggestion = request.suggestion

  const answer = (value: PermissionAnswer): void => {
    void window.brain.respondPermission(request.id, value)
    shift()
  }
  const saveAlways = (): void => {
    if (!suggestion) return
    const trimmed = pattern.trim()
    const rule: PermissionRule = {
      tool: suggestion.tool,
      ...(trimmed ? { pattern: trimmed } : {}),
      ...(onlyAgent ? { agent: request.agentId } : {})
    }
    answer({ allow: true, remember: { rule } })
  }
  const isCommand = suggestion?.tool === 'Bash'
  const hasPattern = suggestion?.pattern !== undefined

  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-labelledby="perm-title">
        <h2 id="perm-title">{who} pide permiso</h2>
        <p className="modal-summary">{request.summary}</p>
        <p className="modal-note">
          Esto ocurre fuera de la carpeta de trabajo o ejecuta algo en tu equipo. Modo: {PERMISSION_MODES[mode]} (se
          cambia en Ajustes).
        </p>
        {always && suggestion && (
          <div className="perm-always">
            {hasPattern && (
              <>
                <label htmlFor="perm-pattern">{isCommand ? 'Comandos que empiecen por' : 'Archivos dentro de'}</label>
                <input
                  id="perm-pattern"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                {!pattern.trim() && (
                  <p className="inputbar-error">
                    Vacío = {isCommand ? 'cualquier comando' : 'cualquier archivo'}, sin volver a preguntar.
                  </p>
                )}
                {isCommand && (
                  <p className="modal-note">Nunca cubre comandos encadenados (&amp;&amp;, |, ;, &gt;…): esos siempre preguntan.</p>
                )}
              </>
            )}
            <div className="usage-ranges" role="group" aria-label="Para quién">
              {[true, false].map((only) => (
                <button
                  type="button"
                  key={String(only)}
                  className={`btn-ghost${onlyAgent === only ? ' usage-range-on' : ''}`}
                  aria-pressed={onlyAgent === only}
                  onClick={() => setOnlyAgent(only)}
                >
                  {only ? `Solo ${who}` : 'Todos los agentes'}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="modal-actions perm-actions">
          <button ref={deny} type="button" className="btn-ghost" onClick={() => answer({ allow: false })}>
            No permitir
          </button>
          {always ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setAlways(false)}>
                Atrás
              </button>
              <button type="button" className="btn-primary" onClick={saveAlways}>
                Guardar y permitir
              </button>
            </>
          ) : (
            <>
              {suggestion && (
                <button type="button" className="btn-ghost" onClick={() => setAlways(true)}>
                  Permitir siempre…
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={() => answer({ allow: true, remember: 'conversation' })}>
                En esta conversación
              </button>
              <button type="button" className="btn-primary" onClick={() => answer({ allow: true })}>
                Permitir esta vez
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const TOOL_CHOICES: { tool: string; label: string; hint: string }[] = [
  { tool: 'Bash', label: 'Comando', hint: 'Prefijo, p. ej. npm test (vacío = cualquiera)' },
  { tool: 'Write', label: 'Escribir archivos', hint: 'Carpeta, p. ej. C:\\proyectos\\web (vacío = cualquiera)' },
  { tool: 'Read', label: 'Leer archivos', hint: 'Carpeta (vacío = cualquiera)' },
  { tool: 'mcp', label: 'Herramienta MCP', hint: 'mcp__servidor o mcp__servidor__herramienta' }
]

export function PermissionSettings() {
  const settings = useStore((s) => s.status?.permissions)
  const agents = useStore((s) => s.agents)
  const [error, setError] = useState('')
  const [kind, setKind] = useState<'allow' | 'deny'>('allow')
  const [tool, setTool] = useState('Bash')
  const [pattern, setPattern] = useState('')
  const [agent, setAgent] = useState('')

  if (!settings) return null

  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    setError('')
    try {
      await work()
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    }
  }
  const add = async (): Promise<void> => {
    const text = pattern.trim()
    let rule: PermissionRule
    if (tool === 'mcp') {
      if (!/^mcp__\w[\w-]*(__[\w-]+)?$/.test(text)) {
        setError('Escribe mcp__servidor o mcp__servidor__herramienta.')
        return
      }
      rule = { tool: text, ...(agent ? { agent } : {}) }
    } else {
      rule = { tool, ...(text ? { pattern: text } : {}), ...(agent ? { agent } : {}) }
    }
    if (await run(() => window.brain.addPermissionRule(kind, rule))) setPattern('')
  }
  const hint = TOOL_CHOICES.find((c) => c.tool === tool)?.hint ?? ''

  return (
    <section className="settings-section">
      <h3>Permisos</h3>
      <div className="usage-ranges" role="group" aria-label="Modo de permisos">
        {(Object.keys(PERMISSION_MODES) as PermissionMode[]).map((id) => (
          <button
            type="button"
            key={id}
            className={`btn-ghost${settings.mode === id ? ' usage-range-on' : ''}`}
            aria-pressed={settings.mode === id}
            onClick={() => void run(() => window.brain.setPermissionMode(id))}
          >
            {PERMISSION_MODES[id]}
          </button>
        ))}
      </div>
      <p className={settings.mode === 'todo' ? 'inputbar-error' : 'modal-note'}>{MODE_DETAIL[settings.mode]}</p>
      <p className="modal-note">Las automatizaciones no usan el modo: siguen con su lista «permitir», pero sí respetan tus reglas de «Nunca».</p>

      {(['allow', 'deny'] as const).map((k) => (
        <div key={k} className="perm-rules">
          <h4>{k === 'allow' ? 'Siempre permitido' : 'Nunca permitido'}</h4>
          {settings[k].length ? (
            <ul className="repo-list">
              {settings[k].map((rule, i) => (
                <li key={`${rule.tool}|${rule.pattern ?? ''}|${rule.agent ?? ''}`}>
                  <div className="repo-info perm-rule">
                    <span>
                      <RuleText rule={rule} agents={agents} />
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost repo-remove"
                    aria-label="Quitar regla"
                    title="Quitar regla"
                    onClick={() => void run(() => window.brain.removePermissionRule(k, i))}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="modal-note">Ninguna.</p>
          )}
        </div>
      ))}

      <div className="perm-add">
        <h4>Añadir regla</h4>
        <div className="perm-add-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'allow' | 'deny')} aria-label="Permitir o denegar">
            <option value="allow">Permitir siempre</option>
            <option value="deny">No permitir nunca</option>
          </select>
          <select value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Herramienta">
            {TOOL_CHOICES.map((c) => (
              <option key={c.tool} value={c.tool}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Para quién">
            <option value="">Todos</option>
            <option value={BRAIN_ID}>El Cerebro</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={hint}
          aria-label="Patrón"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={() => void add()}>
            Añadir
          </button>
        </div>
      </div>
      {error && <p className="inputbar-error">{error}</p>}
    </section>
  )
}
