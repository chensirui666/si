import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDiscovery } from '@agent-learning/model'
import { deleteApiKey, saveApiKey } from '../chat/client'
import { SettingsDialog } from './SettingsDialog'

vi.mock('../chat/client', () => ({ saveApiKey: vi.fn(), deleteApiKey: vi.fn() }))
const missing: ModelDiscovery = { models: [], deepseek: { state: 'missing' } }
const configured: ModelDiscovery = { models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', provider: 'deepseek', api: 'openai-completions' }], deepseek: { state: 'configured' } }
function Harness({ initial = missing }: { initial?: ModelDiscovery }) {
  const [discovery, setDiscovery] = useState(initial)
  return <SettingsDialog discovery={discovery} onChange={setDiscovery} />
}
async function openEditor(configured = false) {
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  await screen.findByRole('dialog', { name: '设置' })
  if (configured) fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  else {
    fireEvent.click(screen.getByRole('button', { name: '添加提供方' }))
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }))
  }
  return screen.getByLabelText('API Key')
}
beforeEach(() => vi.resetAllMocks())
describe('SettingsDialog', () => {
  it('保存仅提交新 Key，清空输入并说明只保存在本机', async () => {
    vi.mocked(saveApiKey).mockResolvedValue(configured)
    render(<Harness />)
    const input = await openEditor()
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'fake-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveApiKey).toHaveBeenCalledExactlyOnceWith('fake-private-key'))
    expect(await screen.findByText(/已保存在本机/)).toBeVisible()
    expect(input).toHaveValue('')
    expect(screen.queryByDisplayValue('fake-private-key')).not.toBeInTheDocument()
    expect(window.localStorage.length).toBe(0)
  })
  it('已配置不回填 Key，支持替换与删除', async () => {
    vi.mocked(saveApiKey).mockResolvedValue(configured)
    vi.mocked(deleteApiKey).mockResolvedValue(missing)
    render(<Harness initial={configured} />)
    const input = await openEditor(true)
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: 'replacement-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(input).toHaveValue(''))
    fireEvent.click(screen.getByRole('button', { name: '删除 API Key' }))
    expect(await screen.findByText('已删除本机配置')).toBeVisible()
    expect(deleteApiKey).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '添加提供方' })).toBeVisible()
  })
  it('失败不报保存成功，关闭清空输入并恢复入口焦点', async () => {
    vi.mocked(saveApiKey).mockRejectedValue(new Error('无法写入模型凭据文件'))
    render(<Harness />)
    const input = await openEditor()
    fireEvent.change(input, { target: { value: 'unsaved-private-key' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法写入模型凭据文件')
    expect(screen.queryByText(/已保存在本机/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '设置' })).toHaveFocus()
    expect(await openEditor()).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('配置错误仍可进入设置且不能宣称未配置或已验证', async () => {
    render(<Harness initial={{ models: [], deepseek: { state: 'error', message: '模型凭据 JSON 格式错误' } }} />)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('模型凭据 JSON 格式错误')
    expect(screen.getByRole('button', { name: '添加提供方' })).toBeVisible()
  })
})
