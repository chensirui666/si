import { useId, useState } from 'react'
import type { ContextUsage } from '@agent-learning/server/protocol'

export function ContextMeter({ usage }: { usage?: ContextUsage | null }) {
  if (usage?.tokens === undefined || !Number.isFinite(usage.tokens) || usage.tokens < 0
    || !usage.contextWindow || !Number.isFinite(usage.contextWindow) || usage.contextWindow < 0) return null
  return <KnownContextMeter usage={usage} tokens={usage.tokens} capacity={usage.contextWindow} />
}

function KnownContextMeter({ usage, tokens, capacity }: { usage: ContextUsage; tokens: number; capacity: number }) {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()
  const percentage = Math.min(100, Math.round(tokens / capacity * 100))
  const fraction = Math.min(1, tokens / capacity)
  const items = [
    ['系统提示词', usage.breakdown.systemTokens],
    ['工具定义', usage.breakdown.toolsTokens],
    ['对话消息', usage.breakdown.messageTokens],
  ] as const
  const total = items.reduce((sum, item) => sum + item[1], 0)
  return <div className="context-meter" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }}>
    <button className="context-meter-trigger" type="button" aria-label={`对话容量 ${percentage}%`} aria-describedby={open ? tooltipId : undefined}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2" />
        {tokens > 0 && <circle className="context-ring-used" cx="12" cy="12" r="9" fill="none" strokeWidth="2" pathLength="100" strokeDasharray={`${fraction * 100} 100`} transform="rotate(-90 12 12)" />}
      </svg><span>{percentage}%</span>
    </button>
    {open && <div className="context-meter-panel" id={tooltipId} role="tooltip">
      <strong>上下文已用 {percentage}%</strong>
      <p>~{tokens.toLocaleString('en-US')} / {capacity.toLocaleString('en-US')} token</p>
      <div className="context-bar"><div className="context-bar-used" style={{ width: `${fraction * 100}%` }}>
        {items.map(([name, value], index) => <span key={name} className={`context-color-${index}`} style={{ width: total ? `${value / total * 100}%` : '0%' }} />)}
      </div></div>
      <dl>{items.map(([name, value], index) => <div key={name}><dt><i className={`context-color-${index}`} />{name}</dt><dd>~{value.toLocaleString('en-US')}</dd></div>)}</dl>
      <p className="context-meter-note">总占用与各项均为近似值，各项之和可能不同。</p>
    </div>}
  </div>
}
