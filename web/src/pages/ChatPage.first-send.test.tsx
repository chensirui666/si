import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConversationSnapshot, SessionSummary } from '@agent-learning/server/protocol'
import { ChatPage } from './ChatPage'
import type { ChatState, Subscribe } from '../chat/state'
import { draftKey, recentWorkspaceKey, writeFirstSend, readFirstSend } from '../chat/drafts'

const desktop = { id: 'desktop', name: 'Desktop', path: '/tmp/Desktop', available: true }
const stardust = { id: 'stardust', name: 'Stardust', path: '/tmp/Stardust', available: true }
const existing = { id: 'existing', workspaceId: desktop.id, name: '会话 1', createdAt: '2026-11-10T00:00:00Z' }
const getModels = async () => ({ models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536 }], providers: [{ id: 'deepseek', name: 'DeepSeek', status: { state: 'configured' as const } }], defaultSelection: { provider: 'deepseek', modelId: 'deepseek-flash' } })
const getDefaultPermission = async () => 'normal' as const
const getWorkspaces = async () => ({ workspaces: [desktop, stardust] })
const empty = { seq: 0, permissionMode: 'normal' as const, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] }
const subscribe: Subscribe = onState => Object.assign(() => {}, { setSession: (sessionId: string | null) => {
  onState({ sessionId, connection: 'ready', slow: false, error: null, snapshot: sessionId ? empty : null })
} })

afterEach(() => { localStorage.clear(); sessionStorage.clear() })

const firstText = '  读取目录里的文件\n保留这行  '
async function chooseAndType() {
  const workspace = await screen.findByRole('group', { name: stardust.name })
  fireEvent.click(within(workspace).getByRole('button', { name: '新建会话' }))
  const editor = screen.getByRole('textbox', { name: '消息' })
  await act(async () => {
    editor.focus()
    fireEvent.paste(editor, { clipboardData: { getData: () => firstText, types: ['text/plain'], items: [], files: [] } })
  })
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  return editor
}

function acceptance(input: { clientMessageId: string; workspaceId: string }) {
  return {
    session: { ...existing, id: input.clientMessageId, workspaceId: input.workspaceId },
    accepted: { kind: 'message' as const, sessionId: input.clientMessageId, clientMessageId: input.clientMessageId, userMessageId: 'first-message', acceptedSeq: 1 },
  }
}

it('首发等待时保留草稿，迟到的成功保留用户后来打开的历史会话', async () => {
  let resolve!: (result: ReturnType<typeof acceptance>) => void
  const receipt = new Promise<ReturnType<typeof acceptance>>(done => { resolve = done })
  const startSession = vi.fn((_input: { clientMessageId: string; workspaceId: string; text: string }) => receipt)
  let sessions = [existing]
  const view = render(<ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={async () => sessions} startSession={startSession} />)
  await chooseAndType()
  expect(startSession).not.toHaveBeenCalled()
  const send = screen.getByRole('button', { name: '发送' })
  await act(async () => { fireEvent.click(send); fireEvent.click(send) })
  expect(startSession).toHaveBeenCalledTimes(1)
  const input = startSession.mock.calls[0]![0]
  expect(input).toMatchObject({ workspaceId: stardust.id, modelId: 'deepseek-flash', text: firstText })
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  fireEvent.click(screen.getByRole('button', { name: '会话 1' }))
  const response = acceptance(input)
  sessions = [...sessions, response.session]
  await act(async () => { resolve(response) })
  expect(view.container.querySelector('.chat-page')).toHaveAttribute('data-session-id', existing.id)
  expect(localStorage.getItem(draftKey('new-session'))).toBeNull()
})

it('首发回执丢失或重试授权过期时仍使用同一编号和原请求', async () => {
  let sessions: SessionSummary[] = []
  const startSession = vi.fn(async (input: { clientMessageId: string; workspaceId: string; text: string }) => {
    if (startSession.mock.calls.length === 1) throw new Error('连接已断开')
    if (startSession.mock.calls.length === 2) throw Object.assign(new Error('授权已失效'), { status: 401 })
    const response = acceptance(input)
    sessions = [response.session]
    return response
  })
  const view = render(<ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={async () => sessions} startSession={startSession} />)
  await chooseAndType()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  const retry = await screen.findByRole('button', { name: '重试首次发送' })
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  await act(async () => { fireEvent.click(retry) })
  expect(screen.getByText('授权已失效')).toBeVisible()
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试首次发送' })) })
  expect(startSession).toHaveBeenCalledTimes(3)
  expect(startSession.mock.calls[0]?.[0]).toMatchObject({ permissionMode: 'normal' })
  expect(startSession.mock.calls[1]).toEqual(startSession.mock.calls[0])
  expect(startSession.mock.calls[2]).toEqual(startSession.mock.calls[0])
  expect(view.container.querySelector('.chat-page')).toHaveAttribute('data-session-id', sessions[0]!.id)
  expect(localStorage.getItem(draftKey('new-session'))).toBeNull()
})


it('刷新时仍能用同一个编号确认未收到回执的首发', async () => {
  const startSession = vi.fn(async (_input: { clientMessageId: string; workspaceId: string; text: string }) => {
    throw new Error('连接已断开')
  })
  const getSessions = async (): Promise<SessionSummary[]> => []
  const app = <ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={getSessions} startSession={startSession} />
  const original = render(app)
  await chooseAndType()
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByRole('button', { name: '重试首次发送' })
  original.unmount()
  render(app)
  const retry = await screen.findByRole('button', { name: '重试首次发送' })
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  await act(async () => { fireEvent.click(retry) })
  expect(startSession).toHaveBeenCalledTimes(2)
  expect(startSession.mock.calls[0]?.[0]).toMatchObject({ permissionMode: 'normal' })
  expect(startSession.mock.calls[1]).toEqual(startSession.mock.calls[0])
})

it('另一标签页先转正同一扩展草稿时保留本页未确认的原文', async () => {
  const sharedDraft = '1338ccf0-0c6f-4d23-8700-4a64dfb91c12'
  sessionStorage.setItem('agent-learning:extension-draft:stardust', sharedDraft)
  let rejectRequest!: (error: Error) => void
  const request = new Promise<ReturnType<typeof acceptance>>((_resolve, reject) => { rejectRequest = reject })
  const startSession = vi.fn(() => request)
  let refreshSessions: (() => void) | undefined
  let sessions: SessionSummary[] = []
  const subscription: Subscribe = (listener, _models, _workspaces, _webSettings, changed) => {
    refreshSessions = changed
    return subscribe(listener)
  }
  const view = render(<ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscription} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={async () => sessions} startSession={startSession} />)
  await chooseAndType()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })) })
  expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ draftSessionId: sharedDraft, text: firstText }))
  sessions = [{ ...existing, id: sharedDraft, workspaceId: stardust.id }]
  await act(async () => { refreshSessions?.() })
  expect(view.container.querySelector('.chat-page')).not.toHaveAttribute('data-session-id', sharedDraft)
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  await act(async () => { rejectRequest(Object.assign(new Error('会话编号已被使用'), { status: 409 })) })
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
})

it('附件首发回执丢失后，用恢复的同一条消息确认并清理草稿', async () => {
  const session = { ...existing, id: '1338ccf0-0c6f-4d23-8700-4a64dfb91c12', workspaceId: stardust.id }
  const input = { draftSessionId: session.id, clientMessageId: '86f5c966-c1b0-4316-876e-9cd216e3b3fb',
    workspaceId: stardust.id, modelId: 'deepseek-flash', permissionMode: 'normal' as const, text: firstText,
    attachmentIds: ['dc34fc73-4a0e-467d-923d-55e076ed4687'] }
  localStorage.setItem(draftKey('new-session'), firstText)
  localStorage.setItem(recentWorkspaceKey, stardust.id)
  writeFirstSend(input)

  const startSession = vi.fn()
  let publish!: (state: ChatState) => void
  const subscription: Subscribe = onState => {
    publish = onState
    return subscribe(onState)
  }
  const sessions = [session]
  render(<ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscription} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={async () => sessions} startSession={startSession} />)
  await screen.findByRole('button', { name: '重试首次发送' })
  fireEvent.click(screen.getByRole('button', { name: session.name }))
  const update = (clientMessageId: string) => {
    const snapshot: ConversationSnapshot = { ...empty, seq: 1, messages: [
      { id: 'stored-first', clientMessageId, message: { role: 'user', content: firstText, timestamp: 1 } },
    ] }
    publish({ sessionId: session.id, connection: 'ready', slow: false, error: null, snapshot })
  }

  await act(async () => { update('another-tab-request') })
  expect(readFirstSend()).toEqual(input)
  expect(localStorage.getItem(draftKey('new-session'))).toBe(firstText)
  await act(async () => {
    publish({ sessionId: session.id, connection: 'disconnected', slow: false, error: null, snapshot: null })
    update(input.clientMessageId)
  })
  expect(readFirstSend()).toBeUndefined()
  expect(localStorage.getItem(draftKey('new-session'))).toBeNull()
  expect(startSession).not.toHaveBeenCalled()
})

it.each(['snapshot', 'retry'] as const)('刷新后通过 %s 确认已有会话的附件或引用发送', async method => {
  const input = { sessionId: existing.id, clientMessageId: '86f5c966-c1b0-4316-876e-9cd216e3b3fb',
    modelId: 'deepseek-flash', text: firstText, referenceSessionIds: ['source-session'] }
  localStorage.setItem(draftKey(existing.id), firstText)
  localStorage.setItem('agent-learning:recent-session', existing.id)
  sessionStorage.setItem('agent-learning:source-sends', JSON.stringify([{ input, text: firstText }]))
  const submitMessage = vi.fn(async () => ({
    sessionId: existing.id, clientMessageId: input.clientMessageId, userMessageId: 'stored-message',
    acceptedSeq: 1, kind: 'message' as const,
  }))
  let publish!: (state: ChatState) => void
  const subscription: Subscribe = onState => {
    publish = onState
    return subscribe(onState)
  }
  const sessions = [existing]
  render(<ChatPage getDefaultPermission={getDefaultPermission} subscribe={subscription} getModels={getModels} getWorkspaces={getWorkspaces}
    getSessions={async () => sessions} submitMessage={submitMessage} />)
  const retry = await screen.findByRole('button', { name: '重试发送' })
  expect(localStorage.getItem(draftKey(existing.id))).toBe(firstText)
  if (method === 'retry') {
    await act(async () => { fireEvent.click(retry) })
    expect(submitMessage).toHaveBeenCalledExactlyOnceWith(input)
  } else {
    await act(async () => {
      const snapshot: ConversationSnapshot = { ...empty, seq: 1, messages: [
        { id: 'stored-message', clientMessageId: input.clientMessageId, message: { role: 'user', content: firstText, timestamp: 1 } },
      ] }
      publish({ sessionId: existing.id, connection: 'ready', slow: false, error: null, snapshot })
    })
    expect(submitMessage).not.toHaveBeenCalled()
  }
  expect(sessionStorage.getItem('agent-learning:source-sends')).toBeNull()
  expect(localStorage.getItem(draftKey(existing.id))).toBeNull()
})
