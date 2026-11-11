import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@agent-learning/server/protocol'
import { ChatPage } from './ChatPage'
import type { Subscribe } from '../chat/state'
import { draftKey } from '../chat/drafts'

const desktop = { id: 'desktop', name: 'Desktop', path: '/tmp/Desktop', available: true }
const stardust = { id: 'stardust', name: 'Stardust', path: '/tmp/Stardust', available: true }
const existing = { id: 'existing', workspaceId: desktop.id, name: '会话 1', createdAt: '2026-11-10T00:00:00Z' }
const getModels = async () => ({ models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536 }], deepseek: { state: 'configured' as const } })
const getWorkspaces = async () => ({ workspaces: [desktop, stardust] })
const empty = { seq: 0, messages: [], running: null, compactions: [], contextUsage: null, activeContent: [] }
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
  const view = render(<ChatPage subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
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
  const view = render(<ChatPage subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
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
  const app = <ChatPage subscribe={subscribe} getModels={getModels} getWorkspaces={getWorkspaces}
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
  expect(startSession.mock.calls[1]).toEqual(startSession.mock.calls[0])
})
