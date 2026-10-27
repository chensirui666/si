import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageInputHarness } from './MessageInputHarness'
import '../styles.css'

function InputEvents() {
  const [events, setEvents] = useState<string[]>([])
  useEffect(() => {
    const record = (event: Event) => {
      if (!(event.target instanceof HTMLElement) || !event.target.isContentEditable) return
      const detail = event instanceof KeyboardEvent
        ? `${event.key} composing=${event.isComposing} code=${event.keyCode}`
        : (event as CompositionEvent).data
      setEvents(previous => [...previous.slice(-19), `${event.type} trusted=${event.isTrusted} ${detail}`])
    }
    const types = ['compositionstart', 'compositionupdate', 'compositionend', 'keydown']
    types.forEach(type => document.addEventListener(type, record, true))
    return () => types.forEach(type => document.removeEventListener(type, record, true))
  }, [])
  return <pre aria-label="原生输入事件" style={{ whiteSpace: 'pre-wrap' }}>{events.join('\n')}</pre>
}

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 800, margin: '24px auto', padding: 16 }}>
    <h1>输入组件验收</h1>
    <p>仅挂载输入组件。下方显示收到的提交原文与原生输入事件。</p>
    <MessageInputHarness />
    <InputEvents />
  </main>,
)
