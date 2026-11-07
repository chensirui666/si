import { useState } from 'react'

import { MessageInput } from '../components/MessageInput'

export function MessageInputHarness({ accept = true, throwOnSend = false, sendDisabled = false, action }: { accept?: boolean; throwOnSend?: boolean; sendDisabled?: boolean; action?: 'send' | 'abort' | 'aborting' }) {
  const [submitted, setSubmitted] = useState<string[]>([])
  const [aborted, setAborted] = useState(0)

  return (
    <div>
      <MessageInput sendDisabled={sendDisabled} action={action} onAbort={() => setAborted(value => value + 1)} onSend={(text) => {
        setSubmitted((previous) => [...previous, text])
        if (throwOnSend) throw new Error('reject')
        return accept
      }} />
      <output aria-label="已提交原文">{JSON.stringify(submitted)}</output>
      <output aria-label="中止次数">{aborted}</output>
    </div>
  )
}
