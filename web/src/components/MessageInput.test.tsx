import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MessageInput } from './MessageInput'

async function paste(text: string, sendingEnabled = true) {
  const textbox = screen.getByRole('textbox', { name: '消息' })
  await act(async () => {
    textbox.focus()
    fireEvent.paste(textbox, {
      clipboardData: {
        getData: (type: string) => (type === 'text/plain' ? text : ''),
        types: ['text/plain'],
        items: [],
        files: [],
      },
    })
  })
  if (text.trim() && sendingEnabled) expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  return textbox
}

async function undo(textbox: HTMLElement) {
  await act(async () => {
    textbox.focus()
    fireEvent.keyDown(textbox, { key: 'z', code: 'KeyZ', ctrlKey: true })
  })
}

describe('MessageInput', () => {
  it('禁发送时仍可编辑，Enter 和按钮均不提交；恢复发送保留原文和撤销', async () => {
    const onSend = vi.fn(() => false)
    const { rerender } = render(<MessageInput onSend={onSend} sendDisabled />)
    const textbox = await paste('  保留草稿\n', false)
    await paste('下一行', false)
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(textbox).toHaveFocus()
    rerender(<MessageInput onSend={onSend} sendDisabled={false} />)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledExactlyOnceWith('  保留草稿\n下一行')
    await undo(textbox)
    expect(textbox.textContent).toBe('  保留草稿')
  })
  it('空草稿禁用发送，Enter 不提交', async () => {
    const onSend = vi.fn(() => true)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)

    const textbox = screen.getByRole('textbox', { name: '消息' })
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.keyDown(textbox, { key: 'Enter' })
    await paste(' \n ')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    fireEvent.keyDown(textbox, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('按接收结果保护草稿：成功后清空并恢复焦点', async () => {
    const onSend = vi.fn(() => true)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('  草稿\n第二行  ')
    const button = screen.getByRole('button', { name: '发送' })

    button.focus()
    fireEvent.click(button)

    expect(onSend).toHaveBeenCalledExactlyOnceWith('  草稿\n第二行  ')
    expect(textbox.textContent).toBe('')
    expect(button).toBeDisabled()
    expect(textbox).toHaveFocus()
  })

  it('成功后的撤销不恢复旧稿，新草稿仍能撤销', async () => {
    const onSend = vi.fn(() => true)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('已发送内容')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await undo(textbox)
    expect(textbox.textContent).toBe('')
    await paste('新的草稿')
    await undo(textbox)

    expect(textbox.textContent).toBe('')
    expect(onSend).toHaveBeenCalledExactlyOnceWith('已发送内容')
  })

  it('按接收结果保护草稿：拒绝后保留原文和撤销历史', async () => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('  草稿\n')
    await paste('第二行  ')

    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(onSend).toHaveBeenCalledExactlyOnceWith('  草稿\n第二行  ')
    expect(textbox.textContent).toContain('第二行  ')
    await undo(textbox)
    expect(textbox.textContent).toBe('  草稿')
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it.each(['点击发送', 'Enter'])('%s 报错交给环境处理并保留原文和撤销历史', async (gesture) => {
    const failure = new Error('接收失败')
    const errors: unknown[] = []
    const scheduleMicrotask = globalThis.queueMicrotask
    // Vitest's Node microtasks do not report errors to jsdom's window.onerror.
    const errorBoundary = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      scheduleMicrotask(() => {
        try { callback() } catch (error) { errors.push(error) }
      })
    })
    const onSend = vi.fn(() => { throw failure })
    try {
      render(<MessageInput onSend={onSend} sendDisabled={false} />)
      const textbox = await paste('  草稿\n')
      await paste('第二行  ')

      if (gesture === 'Enter') fireEvent.keyDown(textbox, { key: 'Enter' })
      else fireEvent.click(screen.getByRole('button', { name: '发送' }))

      expect(onSend).toHaveBeenCalledExactlyOnceWith('  草稿\n第二行  ')
      await act(async () => {})
      expect(errors).toEqual([failure])
      expect(textbox.textContent).toContain('第二行  ')
      await undo(textbox)
      expect(textbox.textContent).toBe('  草稿')
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(errors).toEqual([failure])
    } finally {
      errorBoundary.mockRestore()
    }
  })

  it('普通 Enter 提交完整原文，重复 Enter 不会再次提交', async () => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('  草稿\n第二行  ')

    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.keyDown(textbox, { key: 'Enter', repeat: true })
    fireEvent.keyDown(textbox, { key: 'Enter', repeat: true })

    expect(onSend).toHaveBeenCalledExactlyOnceWith('  草稿\n第二行  ')
  })

  it('Shift+Enter 只插入换行', async () => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('第一行')

    await act(async () => {
      fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    })
    await paste('第二行')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(onSend).toHaveBeenCalledExactlyOnceWith('第一行\n第二行')
  })

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true, ctrlKey: true },
    { shiftKey: true, metaKey: true },
    { shiftKey: true, altKey: true },
  ])('组合按键 %j 不发送或改变草稿', async (modifiers) => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('草稿')

    fireEvent.keyDown(textbox, { key: 'Enter', ...modifiers })

    expect(onSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSend).toHaveBeenCalledExactlyOnceWith('草稿')
  })

  it.each([
    { isComposing: true },
    { keyCode: 229 },
  ])('输入法事件 %j 不误发', async (composition) => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('草稿')

    fireEvent.keyDown(textbox, { key: 'Enter', ...composition })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('输入法选字中与刚结束选字时的 Enter 不误发', async () => {
    const onSend = vi.fn(() => false)
    render(<MessageInput onSend={onSend} sendDisabled={false} />)
    const textbox = await paste('草稿')

    fireEvent.compositionStart(textbox)
    fireEvent.keyDown(textbox, { key: 'Enter' })
    fireEvent.compositionEnd(textbox, { data: '好' })
    fireEvent.keyDown(textbox, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('组件重新渲染保留草稿，并使用最新接收函数', async () => {
    const previous = vi.fn(() => false)
    const current = vi.fn(() => false)
    const { rerender } = render(<MessageInput onSend={previous} sendDisabled={false} />)
    await paste('保留草稿')

    rerender(<MessageInput onSend={current} sendDisabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(previous).not.toHaveBeenCalled()
    expect(current).toHaveBeenCalledExactlyOnceWith('保留草稿')
  })
})
