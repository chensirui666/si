import { useState } from 'react'

import { MessageInput } from '../components/MessageInput'

export function MessageInputHarness({ accept = true, throwOnSend = false, sendDisabled = false }: { accept?: boolean; throwOnSend?: boolean; sendDisabled?: boolean }) {
  const [submitted, setSubmitted] = useState<string[]>([])

  return (
    <div>
      <MessageInput sendDisabled={sendDisabled} onSend={(text) => {
        setSubmitted((previous) => [...previous, text])
        if (throwOnSend) throw new Error('reject')
        return accept
      }} />
      <output aria-label="已提交原文">{JSON.stringify(submitted)}</output>
    </div>
  )
}
