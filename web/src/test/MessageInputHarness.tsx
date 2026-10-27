import { useState } from 'react'

import { MessageInput } from '../components/MessageInput'

export function MessageInputHarness({ accept = true, throwOnSend = false }: { accept?: boolean; throwOnSend?: boolean }) {
  const [submitted, setSubmitted] = useState<string[]>([])

  return (
    <div>
      <MessageInput onSend={(text) => {
        setSubmitted((previous) => [...previous, text])
        if (throwOnSend) throw new Error('reject')
        return accept
      }} />
      <output aria-label="已提交原文">{JSON.stringify(submitted)}</output>
    </div>
  )
}
