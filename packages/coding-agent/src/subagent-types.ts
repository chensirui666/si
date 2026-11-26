export type SubagentSession = {
  parentSessionId: string
  cwd: string
  role?: {
    name: string
    source: 'user' | 'project'
    workspaceId?: string
    systemPrompt: string
    tools?: string[]
  }
  allowedTools: string[]
  mcpToolKeys?: string[]
}

export type DelegationItem = {
  status: 'not-started' | 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'
  sessionId?: string
  runId?: string
  name?: string
  output?: string
  error?: string
}

export type Delegation = {
  id: string
  callerSessionId: string
  rootSessionId: string
  call: { assistantMessageId: string; contentIndex: number; toolCallId: string; runId: string }
  background: boolean
  mode: 'single' | 'parallel' | 'chain' | 'continue'
  items: DelegationItem[]
  finished?: true
  report?: 'pending' | 'delivered' | 'suppressed'
}

export type DelegatedItemWrite = { id: string; index: number; item: DelegationItem }
