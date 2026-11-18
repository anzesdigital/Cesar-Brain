import type { AgentState } from '@shared/types'

export function Bubble({ text, state }: { text: string; state: AgentState }) {
  if (!text) return null
  return (
    // key restarts the pop-in animation every time the thought changes
    <div className={`bubble bubble-${state}`} key={text} role="status">
      <span>{text}</span>
      <i className="bubble-dot bubble-dot-1" />
      <i className="bubble-dot bubble-dot-2" />
    </div>
  )
}
