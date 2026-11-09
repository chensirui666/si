import type { ConversationMessage } from '@agent-learning/agent'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AssistantMessage as Message } from '@agent-learning/model'
import { AssistantMessage } from './AssistantMessage'
import { MarkdownText } from './markdown/MarkdownText'
import { IncrementalMarkdownParser, parseMarkdown } from './markdown/incremental'

const message: Message = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'pending', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '**答案**' }, { type: 'toolCall', id: 'tool', name: 'search', arguments: {}, argumentsError: '无效 JSON: {' }] }

describe('回复内容', () => {
  it('思考展开状态跨流更新保留，参数错误在工具块里显示', () => {
    const running = { kind: 'task' as const, runId: 'user', assistantMessageId: 'answer', phase: 'model' as const, activeTools: [] }
    const view = render(<AssistantMessage messages={[{ id: 'answer', message }]} running={running} activeContent={[{ messageId: 'answer', contentIndex: 0, type: 'thinking' }]} />)
    const details = screen.getByText(/思考中 · 想一想/).closest('details')!
    expect(details).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText(/思考中 · 想一想/))
    view.rerender(<AssistantMessage messages={[{ id: 'answer', message: { ...message, stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '完整思考' }, ...message.content.slice(1)] } }]} running={running} />)
    expect(screen.getByText(/思考 · 完整思考/).closest('details')).toHaveAttribute('open')
    expect(screen.getByText('答案').tagName).toBe('STRONG')
    fireEvent.click(screen.getByText('search'))
    expect(screen.getByText('无效 JSON: {')).toBeVisible()
  })
  it.each([['length', '达到长度限制，回答可能不完整'], ['aborted', '回答已中止'], ['error', '网络中断']] as const)('明确展示 %s 终止原因并保留部分正文', (stopReason, text) => {
    render(<AssistantMessage messages={[{ id: 'answer', message: { ...message, stopReason, errorMessage: stopReason === 'error' ? '网络中断' : undefined } }]} />)
    expect(screen.getByText(text, { selector: '.message-ending' })).toBeVisible()
    expect(screen.getByText('答案')).toBeVisible()
  })
  it('空内容块不伪造回答或思考折叠区域', () => {
    const view = render(<AssistantMessage messages={[{ id: 'answer', message: { ...message, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }] } }]} />)
    expect(view.container.textContent).toBe('')
    expect(view.container.querySelector('details')).toBeNull()
  })
})

it('安全 GFM 支持列表、表格、任务、代码、删除线和引用，禁止模型 HTML 与危险链接', () => {
  const text = '# 标题\n\n~~删除~~ [安全](https://example.com) [危险](javascript:alert%281%29)\n\n- [x] 完成\n- [ ] 待办\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```html\n<script>alert(1)</script>\n```\n\n<div onclick="alert(1)">注入</div>\n\n[引用][ref]\n\n[ref]: https://example.com/ref'
  const view = render(<MarkdownText text={text} />)
  expect(screen.getByRole('heading', { name: '标题' })).toBeVisible()
  expect(view.container.querySelector('del')).toHaveTextContent('删除')
  expect(screen.getAllByRole('checkbox')).toHaveLength(2)
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '安全' })).toHaveAttribute('rel', 'noopener noreferrer')
  expect(screen.getByRole('link', { name: '引用' })).toHaveAttribute('href', 'https://example.com/ref')
  expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
  expect(view.container.querySelector('script,[onclick]')).toBeNull()
  expect(view.container.querySelector('pre')).toHaveTextContent('<script>alert(1)</script>')
})

it('稳定前块冻结，只重解析尾部，最终完整解析校准跨块引用', () => {
  const parser = new IncrementalMarkdownParser()
  const initial = '[引用][ref]\n\n第二段\n\n第三段\n\n第四段'
  const before = parser.update(initial)
  const after = parser.update(initial + '继续\n\n[ref]: https://example.com')
  expect(after[0]).toBe(before[0])
  const view = render(<MarkdownText text={initial} streaming />)
  const first = view.container.querySelector('p')
  view.rerender(<MarkdownText text={initial + '继续\n\n[ref]: https://example.com'} streaming />)
  expect(view.container.querySelector('p')).toBe(first)
  view.rerender(<MarkdownText text={initial + '继续\n\n[ref]: https://example.com'} />)
  expect(screen.getByRole('link', { name: '引用' })).toHaveAttribute('href', 'https://example.com')
  expect(parseMarkdown('~~ok~~').children[0].type).toBe('paragraph')
})


it('W1 同任务中成功、失败、中止各自显示，结果优先于任务中止', () => {
  const calls = ['note.txt', 'missing.txt', 'wait'].map((path, i) => ({ type: 'toolCall' as const, id: `call-${i}`, name: 'read', arguments: { path } }))
  const messages = [{ id: 'a', message: { ...message, stopReason: 'toolUse' as const, content: calls } }]
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'model' as const, activeTools: [] }
  const view = render(<AssistantMessage messages={messages} running={running} />)
  expect(screen.getAllByText('准备中')).toHaveLength(3)
  view.rerender(<AssistantMessage messages={messages} running={{ ...running, phase: 'tools', activeTools: [0, 1, 2].map(contentIndex => ({ assistantMessageId: 'a', contentIndex })) }} />)
  expect(screen.getAllByText('运行中')).toHaveLength(3)
  const entries = ['项目名称：青禾', '文件不存在', '已有输出，任务已取消'].map((text, i) => [i, { id: `r${i}`, toolCall: { assistantMessageId: 'a', contentIndex: i }, ...(i === 2 ? { toolErrorCode: 'interrupted' } : {}), message: { role: 'toolResult' as const, toolCallId: `call-${i}`, toolName: 'read', timestamp: 2, isError: i > 0, content: [{ type: 'text' as const, text }] } }] as [number, ConversationMessage])
  view.rerender(<AssistantMessage messages={[...messages, { id: 'aborted', message: { ...message, content: [], stopReason: 'aborted' } }]} toolResults={new Map([['a', new Map(entries)]])} />)
  fireEvent.click(screen.getByText('执行过程'))
  expect(screen.getByText('成功')).toBeVisible()
  expect(screen.getByText('失败')).toBeVisible()
  expect(screen.getByText('已停止')).toBeVisible()
})

it('W1.1 启动前中止显示已停止及未启动原因，不伪造工具结果', () => {
  render(<AssistantMessage messages={[{ id: 'a', message: { ...message, content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'note.txt' } }], stopReason: 'aborted' } }]} />)
  fireEvent.click(screen.getByText('执行过程'))
  expect(screen.getByText('已停止')).toBeVisible()
  fireEvent.click(screen.getByText('读取 · note.txt'))
  expect(screen.getByText(/启动前.*取消/)).toBeVisible()
  expect(screen.queryByText('结果')).toBeNull()
})

it.each([
  { code: 'file_locked', isError: true, status: '失败', text: '文件暂时不可用' },
  { code: undefined, isError: false, status: '成功', text: '输出已截断，最后一行：第2100行，完整输出：/tmp/full.txt' },
  { code: undefined, isError: true, status: '失败', text: '本批未执行：本轮回复截断' },
])('W1.2/1.3 按真实结果展示 $status 与详情', ({ code, isError, status, text }) => {
  const entry = { id: 'r', toolErrorCode: code, message: { role: 'toolResult' as const, toolCallId: 'c', toolName: 'read', timestamp: 1, isError, content: [{ type: 'text' as const, text }] } }
  render(<AssistantMessage messages={[{ id: 'a', message: { ...message, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }] } }]} toolResults={new Map([['a', new Map([[0, entry]])]])} />)
  fireEvent.click(screen.getByText('执行过程'))
  expect(screen.getByText(status)).toBeVisible()
  fireEvent.click(screen.getByText('读取'))
  expect(screen.getByText(text)).toBeVisible()
})
