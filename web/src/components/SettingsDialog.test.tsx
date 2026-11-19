import { useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDiscovery } from '@agent-learning/model'
import { deleteApiKey, saveApiKey } from '../chat/client'
import { SettingsButton, SettingsDialog } from './SettingsDialog'

vi.mock('../chat/client', () => ({ saveApiKey: vi.fn(), deleteApiKey: vi.fn() }))
const missing: ModelDiscovery = { models: [], providers: [{ id: 'deepseek', name: 'DeepSeek', status: { state: 'missing' } }] }
const configured: ModelDiscovery = { models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 65_536 }], providers: [{ id: 'deepseek', name: 'DeepSeek', status: { state: 'configured' } }], defaultSelection: { provider: 'deepseek', modelId: 'deepseek-flash' } }
function Harness({ initial = missing }: { initial?: ModelDiscovery }) {
  const [discovery, setDiscovery] = useState(initial)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <SettingsButton ref={trigger} onClick={() => setOpen(true)} />
    <SettingsDialog discovery={discovery} onChange={setDiscovery} open={open} onOpenChange={setOpen} onCloseAutoFocus={event => {
      event.preventDefault()
      trigger.current?.focus()
    }} />
  </>
}
async function openEditor(configured = false) {
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  const dialog = await screen.findByRole('dialog', { name: '设置' })
  fireEvent.click(within(dialog).getByRole('button', { name: '模型' }))
  if (configured) fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  else {
    fireEvent.click(screen.getByRole('button', { name: '添加提供方' }))
    fireEvent.keyDown(screen.getByRole('combobox', { name: '提供方' }), { key: 'Enter' })
    fireEvent.click(screen.getByRole('option', { name: 'DeepSeek' }))
  }
  return screen.getByLabelText('API Key')
}
beforeEach(() => vi.resetAllMocks())
describe('SettingsDialog', () => {
  it('在所选提供方卡片内编辑，取消后仍可查看其他提供方', async () => {
    render(<Harness initial={{ ...configured, providers: [...configured.providers, {
      id: 'moonshotai-cn', name: 'Moonshot AI CN', status: { state: 'configured' },
    }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    const card = screen.getByRole('article', { name: 'DeepSeek' })
    const edit = within(card).getByRole('button', { name: '编辑' })
    fireEvent.click(edit)
    expect(screen.getByRole('article', { name: 'Moonshot AI CN' })).toBeVisible()
    fireEvent.change(within(card).getByLabelText('API Key'), { target: { value: 'discarded-key' } })
    fireEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(edit).toHaveFocus()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    fireEvent.click(edit)
    expect(within(card).getByLabelText('API Key')).toHaveValue('')
  })
  it('离开卡片后收到的保存结果仍更新列表，保留当前编辑内容', async () => {
    const discovery: ModelDiscovery = { ...configured, providers: [...configured.providers, {
      id: 'moonshotai-cn', name: 'Moonshot AI CN', status: { state: 'configured' },
    }] }
    let complete!: (value: ModelDiscovery) => void
    vi.mocked(saveApiKey).mockImplementation(() => new Promise(resolve => { complete = resolve }))
    render(<Harness initial={discovery} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    const card = (name: string) => within(screen.getByRole('article', { name }))
    fireEvent.click(card('DeepSeek').getByRole('button', { name: '编辑' }))
    fireEvent.change(card('DeepSeek').getByLabelText('API Key'), { target: { value: 'submitted-key' } })
    fireEvent.click(card('DeepSeek').getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '网页工具' }))
    fireEvent.click(screen.getByRole('button', { name: '模型' }))
    fireEvent.click(card('Moonshot AI CN').getByRole('button', { name: '编辑' }))
    fireEvent.change(card('Moonshot AI CN').getByLabelText('API Key'), { target: { value: 'current-key' } })
    await act(async () => complete({ ...discovery, providers: discovery.providers.map(provider =>
      provider.id === 'deepseek' ? { ...provider, name: 'DeepSeek Updated' } : provider) }))
    expect(card('DeepSeek Updated').getByRole('button', { name: '编辑' })).toBeVisible()
    expect(card('Moonshot AI CN').getByLabelText('API Key')).toHaveValue('current-key')
    expect(screen.queryByText(/已保存在本机/)).not.toBeInTheDocument()
  })
  it('保存仅提交新 Key，清空输入并说明只保存在本机', async () => {
    vi.mocked(saveApiKey).mockResolvedValue(configured)
    render(<Harness />)
    const input = await openEditor()
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'fake-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveApiKey).toHaveBeenCalledExactlyOnceWith('deepseek', 'fake-private-key'))
    expect(await screen.findByText(/已保存在本机/)).toBeVisible()
    expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('fake-private-key')).not.toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })
  it('已配置不回填 Key，支持替换与删除', async () => {
    vi.mocked(saveApiKey).mockResolvedValue(configured)
    vi.mocked(deleteApiKey).mockRejectedValueOnce(new Error('无法删除凭据')).mockResolvedValueOnce(missing)
    render(<Harness initial={configured} />)
    const input = await openEditor(true)
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'replacement-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    const card = within(screen.getByRole('article', { name: 'DeepSeek' }))
    expect(card.queryByText('已配置')).not.toBeInTheDocument()
    expect(card.getByRole('img', { name: '已配置' })).toBeInTheDocument()
    expect(screen.getByLabelText('API Key').closest('form')).not.toContainElement(card.getByRole('button', { name: /^删除$/ }))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'unsubmitted-key' } })
    fireEvent.click(card.getByRole('button', { name: /^删除$/ }))
    const confirm = within(await screen.findByRole('dialog', { name: '删除 DeepSeek？' }))
    expect(deleteApiKey).not.toHaveBeenCalled()
    expect(confirm.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(confirm.getByRole('button', { name: '取消' }))
    expect(deleteApiKey).not.toHaveBeenCalled()
    expect(screen.getByLabelText('API Key')).toHaveValue('unsubmitted-key')
    fireEvent.click(card.getByRole('button', { name: /^删除$/ }))
    const reopened = within(await screen.findByRole('dialog', { name: '删除 DeepSeek？' }))
    fireEvent.click(reopened.getByRole('button', { name: /^删除$/ }))
    expect(await reopened.findByRole('alert')).toHaveTextContent('无法删除凭据')
    expect(screen.queryByText('已删除本机配置')).not.toBeInTheDocument()
    fireEvent.click(reopened.getByRole('button', { name: /^删除$/ }))
    expect(await screen.findByText('已删除本机配置')).toBeVisible()
    expect(deleteApiKey).toHaveBeenNthCalledWith(1, 'deepseek')
    expect(deleteApiKey).toHaveBeenNthCalledWith(2, 'deepseek')
    expect(screen.queryByRole('article', { name: 'DeepSeek' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '添加提供方' })).toBeVisible()
  })
  it('失败不报保存成功，关闭清空输入并恢复入口焦点', async () => {
    vi.mocked(saveApiKey).mockRejectedValue(new Error('无法写入模型凭据文件'))
    render(<Harness />)
    const input = await openEditor()
    fireEvent.change(input, { target: { value: 'unsaved-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法写入模型凭据文件')
    expect(input).toHaveValue('unsaved-private-key')
    expect(screen.queryByText(/已保存在本机/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '设置' })).toHaveFocus()
    expect(await openEditor()).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('配置错误仍可进入设置且不能宣称未配置或已验证', async () => {
    render(<Harness initial={{ models: [], providers: [{ id: 'deepseek', name: 'DeepSeek', status: { state: 'error', message: '模型凭据 JSON 格式错误' } }] }} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '模型' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型凭据 JSON 格式错误')
    expect(screen.getByRole('button', { name: '添加提供方' })).toBeVisible()
  })
})
