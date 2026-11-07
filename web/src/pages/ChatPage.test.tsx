import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatState, Subscribe } from '../chat/state'
import { ChatPage } from './ChatPage'
import * as client from '../chat/client'

const getEmptyWorkspaces = async () => ({ workspaces: [], boundWorkspaceId: null })
const getConfiguredWorkspaces = async () => ({ workspaces: [{ id: 'workspace-1', path: '/tmp/workspace', name: 'workspace', available: true }], boundWorkspaceId: 'workspace-1' })
const empty = { seq: 0, messages: [], running: null, activeContent: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function controlled() {
  let listener: (state: ChatState) => void = () => {}
  const cleanup = vi.fn()
  const subscribe: Subscribe = next => { listener = next; return cleanup }
  return { subscribe, cleanup, emit: (state: ChatState) => act(() => { listener(state) }) }
}

describe('ChatPage', () => {
  it('StrictMode 清理订阅，快照仅展示已有用户文字，所有连接状态均不能提交', () => {
    const source = controlled()
    const view = render(<StrictMode><ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={source.subscribe} /></StrictMode>)
    expect(source.cleanup).toHaveBeenCalledTimes(1)
    source.emit({ connection: 'ready', slow: false, error: null, snapshot: {
      ...empty,
      messages: [
        { id: 'one', message: { role: 'user', content: '  你好\n世界  ', timestamp: 1 } },
        { id: 'system', message: { role: 'system', content: '内部指令', timestamp: 1 } },
        { id: 'two', message: { role: 'user', content: [{ type: 'text', text: '第二条' }, { type: 'text', text: '原文' }], timestamp: 2 } },
      ],
    } })
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(['  你好\n世界  ', '第二条原文'])
    expect(screen.getByRole('status')).toHaveTextContent('对话已同步')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    view.unmount()
    expect(source.cleanup).toHaveBeenCalledTimes(2)
  })

  it('连接切换、慢提示与异常保留草稿和焦点；空快照没有演示消息', async () => {
    const source = controlled()
    render(<ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={source.subscribe} />)
    const textbox = screen.getByRole('textbox', { name: '消息' })
    await act(async () => {
      textbox.focus()
      fireEvent.paste(textbox, { clipboardData: { getData: () => '  未发送草稿  ', types: ['text/plain'], items: [], files: [] } })
    })
    for (const connection of ['connecting', 'awaitingSnapshot', 'disconnected', 'ready'] as const) {
      source.emit({ connection, snapshot: connection === 'ready' ? empty : null, slow: connection === 'awaitingSnapshot', error: connection === 'disconnected' ? '连接异常，请重新打开启动链接后重试' : null })
      expect(textbox).toHaveFocus()
      expect(textbox.textContent).toBe('  未发送草稿  ')
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
      fireEvent.keyDown(textbox, { key: 'Enter' })
      expect(textbox.textContent).toBe('  未发送草稿  ')
    }
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})

const missing = { models: [], deepseek: { state: 'missing' as const } }
const configured = { models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions' }], deepseek: { state: 'configured' as const } }

const runningState = (id = 'user-1'): ChatState => ({ connection: 'ready', slow: false, error: null, snapshot: {
  ...empty, seq: 1, running: { userMessageId: id, assistantMessageId: 'answer', phase: 'model' },
} })

it('空草稿也能中止，重复点击只交付一次，回执先到仍等待后台空闲', async () => {
  const source = controlled()
  const receipt = deferred<{ userMessageId: string; handled: boolean }>()
  const abortMessage = vi.fn(() => receipt.promise)
  const submitMessage = vi.fn()
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} abortMessage={abortMessage} />)
  await act(async () => { source.emit(runningState()) })
  const editor = screen.getByRole('textbox', { name: '消息' })
  const stop = screen.getByRole('button', { name: '中止' })
  expect(stop).toBeEnabled()
  act(() => { fireEvent.click(stop); fireEvent.click(stop) })
  expect(abortMessage).toHaveBeenCalledExactlyOnceWith({ userMessageId: 'user-1' })
  expect(screen.getByRole('button', { name: '正在中止' })).toBeDisabled()
  await pasteDraft('中止期间的新草稿')
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(submitMessage).not.toHaveBeenCalled()
  await act(async () => { receipt.resolve({ userMessageId: 'user-1', handled: true }) })
  expect(screen.getByRole('button', { name: '正在中止' })).toBeDisabled()
  source.emit({ ...runningState(), snapshot: { ...empty, seq: 3 } })
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  expect(editor.textContent).toBe('中止期间的新草稿')
})

it.each([true, false])('旧中止%s回执不能改变新运行、按钮与草稿', async success => {
  const source = controlled()
  const receipt = deferred<{ userMessageId: string; handled: boolean }>()
  const abortMessage = vi.fn(() => receipt.promise)
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} abortMessage={abortMessage} />)
  await act(async () => { source.emit(runningState()) })
  fireEvent.click(screen.getByRole('button', { name: '中止' }))
  source.emit({ ...runningState(), snapshot: { ...empty, seq: 3 } })
  source.emit(runningState('new-user'))
  const editor = await pasteDraft('下一轮草稿')
  await act(async () => { if (success) receipt.resolve({ userMessageId: 'user-1', handled: false }); else receipt.reject(new Error('旧错误')) })
  expect(screen.getByRole('button', { name: '中止' })).toBeEnabled()
  expect(screen.queryByText(/旧错误/)).not.toBeInTheDocument()
  expect(editor.textContent).toBe('下一轮草稿')
})

it('中止失败显示未确认并重取快照，仍运行时可手工重试，不自动重发', async () => {
  const source = controlled()
  const requestSnapshot = vi.fn(() => source.emit({ ...runningState(), connection: 'awaitingSnapshot' }))
  Object.assign(source.cleanup, { requestSnapshot })
  const abortMessage = vi.fn().mockRejectedValueOnce(new Error('网络失败')).mockResolvedValue({ userMessageId: 'user-1', handled: false })
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} abortMessage={abortMessage} />)
  await act(async () => { source.emit(runningState()) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '中止' })) })
  expect(screen.getByRole('alert')).toHaveTextContent('中止未确认')
  expect(requestSnapshot).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: '中止' })).toBeDisabled()
  await act(async () => { source.emit(runningState()) })
  expect(screen.getByRole('button', { name: '中止' })).toBeEnabled()
  expect(abortMessage).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '中止' }))
  expect(abortMessage).toHaveBeenCalledTimes(2)
})

it('模型、目录失效或订阅断线仍可中止已知运行，刷新按快照恢复入口', async () => {
  const source = controlled()
  const abortMessage = vi.fn(() => new Promise<never>(() => {}))
  render(<ChatPage getWorkspaces={async () => ({ ...await getConfiguredWorkspaces(), workspaces: [] })} subscribe={source.subscribe} getModels={async () => missing} abortMessage={abortMessage} />)
  await act(async () => { source.emit({ ...runningState(), connection: 'disconnected' }) })
  expect(screen.getByRole('button', { name: '中止' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '中止' }))
  expect(abortMessage).toHaveBeenCalledExactlyOnceWith({ userMessageId: 'user-1' })
})

it('查询模型并响应配置通知与重连，旧查询不能覆盖新配置，发送仍禁用', async () => {
  let listener: (state: ChatState) => void = () => {}
  let changed = () => {}
  const subscribe: Subscribe = (onState, onModelsChanged) => { listener = onState; changed = onModelsChanged!; return () => {} }
  let resolveOld: (value: typeof configured) => void = () => {}
  const getModels = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(missing).mockResolvedValue(configured)
  render(<ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={subscribe} getModels={getModels} />)
  await act(async () => { changed() })
  expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('无可用模型')
  await act(async () => { resolveOld(configured) })
  expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('无可用模型')
  await act(async () => { listener({ connection: 'disconnected', snapshot: empty, slow: false, error: null }) })
  await act(async () => { listener({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('DeepSeek Flash')
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
})

it('区分查询网络失败和本地配置错误，错误时仍可打开设置', async () => {
  const getModels = vi.fn().mockRejectedValueOnce(new Error('网络请求失败，请检查连接后重试'))
    .mockResolvedValue({ models: [], deepseek: { state: 'error', message: '模型文件格式错误' } })
  const source = controlled()
  render(<ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={source.subscribe} getModels={getModels} />)
  expect(await screen.findByText('网络请求失败，请检查连接后重试')).toBeVisible()
  source.emit({ connection: 'disconnected', snapshot: empty, slow: false, error: null })
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  expect(await screen.findByText('模型文件格式错误')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  expect(await screen.findByRole('dialog', { name: '设置' })).toBeVisible()
})


it('晚到的配置保存结果后重新查询当前文件，避免恢复旧模型状态', async () => {
  let resolveSave: (value: typeof configured) => void = () => {}
  const save = vi.spyOn(client, 'saveApiKey').mockImplementation(() => new Promise(resolve => { resolveSave = resolve }))
  const getModels = vi.fn().mockResolvedValue(missing)
  const source = controlled()
  try {
    render(<ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={source.subscribe} getModels={getModels} />)
    await screen.findByRole('option', { name: '无可用模型' })
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '添加提供方' }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'delayed-save-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await act(async () => { resolveSave(configured) })
    expect(getModels).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('无可用模型')
  } finally { save.mockRestore() }
})

it('初始模型查询尚未完成时保存失败，仍接收查询结果且关闭后不会永久加载', async () => {
  let resolveInitial: (value: typeof configured) => void = () => {}
  const getModels = vi.fn().mockImplementation(() => new Promise(resolve => { resolveInitial = resolve }))
  const save = vi.spyOn(client, 'saveApiKey').mockRejectedValue(new Error('无法写入模型凭据文件'))
  const source = controlled()
  try {
    render(<ChatPage getWorkspaces={getEmptyWorkspaces} subscribe={source.subscribe} getModels={getModels} />)
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('正在查询模型…')
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '添加提供方' }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'failed-save-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法写入模型凭据文件')
    await act(async () => { resolveInitial(configured) })
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveDisplayValue('DeepSeek Flash')
    expect(getModels).toHaveBeenCalledOnce()
  } finally { save.mockRestore() }
})

async function pasteDraft(text: string) {
  const editor = screen.getByRole('textbox', { name: '消息' })
  await act(async () => { editor.focus(); fireEvent.paste(editor, { clipboardData: { getData: () => text, types: ['text/plain'], items: [], files: [] } }) })
  return editor
}

it('有效发送立即清空，HTTP 回执等待 WS；渲染前双手势只提交一次，生成中保留新草稿', async () => {
  const source = controlled()
  let resolve: (value: {clientMessageId: string; userMessageId: string; acceptedSeq: number}) => void = () => {}
  const submitMessage = vi.fn().mockImplementation(() => new Promise(next => { resolve = next }))
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('  原文\n')
  act(() => { fireEvent.keyDown(editor, { key: 'Enter' }); fireEvent.click(screen.getByRole('button', { name: '发送' })) })
  expect(submitMessage).toHaveBeenCalledTimes(1)
  const input = submitMessage.mock.calls[0][0]
  expect(input.text).toBe('  原文\n')
  expect(editor.textContent).toBe('')
  expect(editor).toHaveFocus()
  await pasteDraft('新草稿')
  await act(async () => { resolve({ clientMessageId: input.clientMessageId, userMessageId: 'user', acceptedSeq: 1 }) })
  expect(screen.getByRole('button', { name: '中止' })).toBeDisabled()
  source.emit({ connection: 'ready', snapshot: { ...empty, seq: 1, messages: [{ id: 'user', clientMessageId: input.clientMessageId, message: { role: 'user', content: input.text, timestamp: 1 } }], running: { userMessageId: 'user', assistantMessageId: 'answer', phase: 'model' } }, slow: false, error: null })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByRole('button', { name: '中止' })).toBeEnabled()
  expect(editor.textContent).toBe('新草稿')
  source.emit({ connection: 'ready', snapshot: { ...empty, seq: 2, messages: [{ id: 'user', clientMessageId: input.clientMessageId, message: { role: 'user', content: input.text, timestamp: 1 } }] }, slow: false, error: null })
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
})

it('WS 先确认后迟到 HTTP 错误不降级，也不覆盖新草稿', async () => {
  const source = controlled()
  let reject: (error: Error) => void = () => {}
  const submitMessage = vi.fn().mockImplementation(() => new Promise((_, next) => { reject = next }))
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('已发送')
  fireEvent.keyDown(editor, { key: 'Enter' })
  const input = submitMessage.mock.calls[0][0]
  await pasteDraft('不能覆盖')
  source.emit({ connection: 'ready', snapshot: { ...empty, seq: 1, messages: [{ id: 'user', clientMessageId: input.clientMessageId, message: { role: 'user', content: input.text, timestamp: 1 } }] }, slow: false, error: null })
  await act(async () => { reject(Object.assign(new Error('正在生成'), { status: 409 })) })
  expect(screen.queryByText('发送失败')).not.toBeInTheDocument()
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(editor.textContent).toBe('不能覆盖')
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
})

it('十秒无接收证据显示未确认并重取快照，空快照不会开放重复提交', async () => {
  vi.useFakeTimers()
  const source = controlled()
  const requestSnapshot = vi.fn()
  Object.assign(source.cleanup, { requestSnapshot })
  const submitMessage = vi.fn(() => new Promise<never>(() => {}))
  try {
    render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
    await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
    const editor = await pasteDraft('未知接收状态')
    fireEvent.keyDown(editor, { key: 'Enter' })
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(screen.getByText('未确认接收')).toBeVisible()
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null })
    await pasteDraft('下一条')
    expect(screen.getByRole('button', { name: '中止' })).toBeDisabled()
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(submitMessage).toHaveBeenCalledTimes(1)
  } finally { vi.useRealTimers() }
})

it('明确拒绝可编辑下一条，同步抛错保留当前草稿', async () => {
  const source = controlled()
  const submitMessage = vi.fn().mockRejectedValueOnce(Object.assign(new Error('正在生成'), { status: 409 })).mockImplementationOnce(() => { throw new Error('同步拒绝') })
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('被拒绝')
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
  expect(screen.getByText('发送失败')).toBeVisible()
  expect(editor.textContent).toBe('被拒绝')
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(editor.textContent).toBe('被拒绝')
})

it('有模型时仍逐项检查连接、快照、运行与模型门禁，切换后保留原草稿', async () => {
  const source = controlled()
  const submitMessage = vi.fn(() => new Promise<never>(() => {}))
  let changed = () => {}
  const subscribe: Subscribe = (next, onModelsChanged) => { changed = onModelsChanged!; return source.subscribe(next) }
  const getModels = vi.fn().mockResolvedValue(configured)
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={subscribe} getModels={getModels} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('全部门禁')
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  for (const connection of ['connecting', 'awaitingSnapshot', 'disconnected'] as const) {
    source.emit({ connection, snapshot: empty, slow: false, error: null })
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(submitMessage).not.toHaveBeenCalled()
    expect(editor.textContent).toBe('全部门禁')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  }
  source.emit({ connection: 'ready', snapshot: null, slow: false, error: null })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(submitMessage).not.toHaveBeenCalled()
  source.emit({ connection: 'ready', snapshot: { ...empty, running: { userMessageId: 'other-user', assistantMessageId: 'other-answer', phase: 'model' } }, slow: false, error: null })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(submitMessage).not.toHaveBeenCalled()
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  getModels.mockResolvedValue(missing)
  await act(async () => { changed() })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(submitMessage).not.toHaveBeenCalled()
  expect(editor.textContent).toBe('全部门禁')
  getModels.mockRejectedValueOnce(new Error('查询失败'))
  await act(async () => { changed() })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(submitMessage).not.toHaveBeenCalled()
  expect(editor).toHaveFocus()
})

it('网络失败立即标记未确认并重取快照，后续 WS 正式 user 仍可合并', async () => {
  const source = controlled()
  const requestSnapshot = vi.fn()
  Object.assign(source.cleanup, { requestSnapshot })
  const submitMessage = vi.fn().mockRejectedValue(new Error('网络请求失败，未确认接收'))
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('未知提交')
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
  expect(screen.getByText('未确认接收', { exact: true })).toBeVisible()
  expect(requestSnapshot).toHaveBeenCalledTimes(1)
  expect(editor.textContent).toBe('')
  const input = submitMessage.mock.calls[0][0]
  source.emit({ connection: 'ready', slow: false, error: null, snapshot: { ...empty, seq: 1, messages: [{ id: 'user', clientMessageId: input.clientMessageId, message: { role: 'user', content: input.text, timestamp: 1 } }] } })
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.queryByText('未确认接收', { exact: true })).not.toBeInTheDocument()
})

it.each([413, 415])('HTTP %s 明确拒绝后恢复原稿并允许编辑发送', async status => {
  const source = controlled()
  const submitMessage = vi.fn().mockRejectedValue(Object.assign(new Error('提交被拒绝'), { status }))
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: empty, slow: false, error: null }) })
  const editor = await pasteDraft('消息原文')
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
  expect(screen.getByText('发送失败', { exact: true })).toBeVisible()
  expect(screen.queryByText('未确认接收', { exact: true })).not.toBeInTheDocument()
  expect(editor.textContent).toBe('消息原文')
  expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
})

it.each([false, true])('失败 A 后成功 B 保持创建顺序，已有正式历史：%s', async withHistory => {
  const source = controlled()
  let reject: (error: Error) => void = () => {}
  const submitMessage = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail })).mockImplementationOnce(() => new Promise<never>(() => {}))
  const history = withHistory ? [{ id: 'history', message: { role: 'user' as const, content: '历史 F', timestamp: 1 } }] : []
  render(<ChatPage getWorkspaces={getConfiguredWorkspaces} subscribe={source.subscribe} getModels={async () => configured} submitMessage={submitMessage} />)
  await act(async () => { source.emit({ connection: 'ready', snapshot: { ...empty, messages: history }, slow: false, error: null }) })
  const editor = await pasteDraft('失败 A')
  fireEvent.keyDown(editor, { key: 'Enter' })
  await pasteDraft('成功 B')
  await act(async () => { reject(Object.assign(new Error('输入无效'), { status: 400 })) })
  expect(screen.getByText('发送失败', { exact: true })).toBeVisible()
  fireEvent.keyDown(editor, { key: 'Enter' })
  const second = submitMessage.mock.calls[1][0]
  source.emit({ connection: 'ready', slow: false, error: null, snapshot: { ...empty, seq: 3, messages: [...history,
    { id: 'user-b', clientMessageId: second.clientMessageId, message: { role: 'user', content: second.text, timestamp: 2 } },
    { id: 'answer-b', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 3, content: [{ type: 'text', text: '回答 B' }], stopReason: 'stop' } },
  ] } })
  expect(screen.getAllByRole('listitem').map(item => item.querySelector('.message-text,.markdown-text')?.textContent)).toEqual([...(withHistory ? ['历史 F'] : []), '失败 A', '成功 B', '回答 B'])
})
