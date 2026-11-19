import { useState } from 'react'

import { MessageInput } from '../components/MessageInput'

export function MessageInputHarness({ accept = true, throwOnSend = false, sendDisabled = false, action, skillWorkspaceId, plan }: { accept?: boolean; throwOnSend?: boolean; sendDisabled?: boolean; skillWorkspaceId?: string; plan?: 'available' | 'active'; action?: 'send' | 'abort' | 'aborting' }) {
  const [submitted, setSubmitted] = useState<string[]>([])
  const [aborted, setAborted] = useState(0)

  return (
    <div>
      <MessageInput
        onAddFiles={plan && (files => setSubmitted(previous => [...previous, ...files.map(file => file.name)]))}
        onPlan={plan && (text => setSubmitted(previous => [...previous, text]))}
        planActive={plan === 'active'} onExitPlan={plan && (text => setSubmitted(previous => [...previous, text ?? 'exit']))}
        skillWorkspaceId={skillWorkspaceId} sendDisabled={sendDisabled} action={action} onAbort={() => setAborted(value => value + 1)} onSend={(text) => {
        setSubmitted((previous) => [...previous, text])
        if (throwOnSend) throw new Error('reject')
        return accept
      }} />
      <output aria-label="已提交原文">{JSON.stringify(submitted)}</output>
      <output aria-label="中止次数">{aborted}</output>
    </div>
  )
}
