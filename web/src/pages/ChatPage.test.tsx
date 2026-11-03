import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatState, Subscribe } from '../chat/state'
import { ChatPage } from './ChatPage'
import * as client from '../chat/client'

const empty = { seq: 0, messages: [], running: null, activeContent: [] }

function controlled() {
  let listener: (state: ChatState) => void = () => {}
  const cleanup = vi.fn()
  const subscribe: Subscribe = next => { listener = next; return cleanup }
  return { subscribe, cleanup, emit: (state: ChatState) => act(() => { listener(state) }) }
}

describe('ChatPage', () => {
  it('StrictMode 清理订阅，快照仅展示已有用户文字，所有连接状态均不能提交', () => {
    const source = controlled()
    const view = render(<StrictMode><ChatPage subscribe={source.subscribe} /></StrictMode>)
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
    render(<ChatPage subscribe={source.subscribe} />)
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

it('查询模型并响应配置通知与重连，旧查询不能覆盖新配置，发送仍禁用', async () => {
  let listener: (state: ChatState) => void = () => {}
  let changed = () => {}
  const subscribe: Subscribe = (onState, onModelsChanged) => { listener = onState; changed = onModelsChanged!; return () => {} }
  let resolveOld: (value: typeof configured) => void = () => {}
  const getModels = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(missing).mockResolvedValue(configured)
  render(<ChatPage subscribe={subscribe} getModels={getModels} />)
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
  render(<ChatPage subscribe={source.subscribe} getModels={getModels} />)
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
    render(<ChatPage subscribe={source.subscribe} getModels={getModels} />)
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
    render(<ChatPage subscribe={source.subscribe} getModels={getModels} />)
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
