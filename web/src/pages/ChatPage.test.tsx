import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatState, Subscribe } from '../chat/state'
import { ChatPage } from './ChatPage'

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
