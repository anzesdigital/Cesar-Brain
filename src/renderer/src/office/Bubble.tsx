import type { AgentState } from '@shared/types'

export function Bubble({ text, state }: { text: string; state: AgentState }) {
  if (!text) return null
  return (
    // The anchor is a point above the head; it scales against the office zoom
    // so the bubble stays readable when zoomed out.
    <span className="bubble-anchor">
      {/* key restarts the pop-in animation every time the thought changes */}
      <span className={`bubble bubble-${state}`} key={text} role="status">
        <span>{text}</span>
        <i className="bubble-dot bubble-dot-1" />
        <i className="bubble-dot bubble-dot-2" />
      </span>
    </span>
  )
}
