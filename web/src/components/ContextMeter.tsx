import { useTranslation } from 'react-i18next'
import { useRef, useState } from 'react'
import type { ContextUsage } from '@agent-learning/server/protocol'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

export function ContextMeter({ usage }: { usage?: ContextUsage | null }) {
  if (usage?.tokens === undefined || !Number.isFinite(usage.tokens) || usage.tokens < 0
    || !usage.contextWindow || !Number.isFinite(usage.contextWindow) || usage.contextWindow < 0) return null
  return <KnownContextMeter usage={usage} tokens={usage.tokens} capacity={usage.contextWindow} />
}

function KnownContextMeter({ usage, tokens, capacity }: { usage: ContextUsage; tokens: number; capacity: number }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const nextTouchOpen = useRef<boolean | null>(null)
  const percentage = Math.min(100, Math.round(tokens / capacity * 100))
  const fraction = Math.min(1, tokens / capacity)
  const items = [
    [t('context.system'), usage.breakdown.systemTokens],
    [t('context.tools'), usage.breakdown.toolsTokens],
    [t('context.messages'), usage.breakdown.messageTokens],
  ] as const
  const total = items.reduce((sum, item) => sum + item[1], 0)
  return <TooltipProvider delayDuration={0}>
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" className="context-meter-trigger" type="button" aria-label={t('context.capacity', { percentage })}
          onPointerDown={event => {
            // Radix can dismiss on pointer down, so decide the tap's result first.
            nextTouchOpen.current = event.pointerType === 'touch' ? !open : null
          }}
          onPointerCancel={() => { nextTouchOpen.current = null }}
          onClick={event => {
            const next = nextTouchOpen.current
            if (next === null) return
            nextTouchOpen.current = null
            event.preventDefault()
            setOpen(next)
          }}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle className="context-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2" />
            {tokens > 0 && <circle className="context-ring-used" cx="12" cy="12" r="9" fill="none" strokeWidth="2" pathLength="100" strokeDasharray={`${fraction * 100} 100`} transform="rotate(-90 12 12)" />}
          </svg><span>{percentage}%</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="context-meter-panel" side="top" align="end" sideOffset={6} collisionPadding={8}>
        <strong>{t('context.used', { percentage })}</strong>
        <p>~{tokens.toLocaleString(i18n.language)} / {capacity.toLocaleString(i18n.language)} token</p>
        <div className="context-bar"><div className="context-bar-used" style={{ width: `${fraction * 100}%` }}>
          {items.map(([name, value], index) => <span key={name} className={`context-color-${index}`} style={{ width: total ? `${value / total * 100}%` : '0%' }} />)}
        </div></div>
        <dl>{items.map(([name, value], index) => <div key={name}><dt><i className={`context-color-${index}`} />{name}</dt><dd>~{value.toLocaleString(i18n.language)}</dd></div>)}</dl>
        <p className="context-meter-note">{t('context.estimate')}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
}
