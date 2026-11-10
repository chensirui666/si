import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CompactionRecords } from './CompactionRecords'
import type { CompactionRecord } from '@agent-learning/server/protocol'

const success: CompactionRecord = { id: 'c1', trigger: 'manual', status: 'success', startedAt: 1, finishedAt: 2, summary: '项目青禾', firstKeptMessageId: 'u1', contextLastMessageId: 'a1', estimatedBefore: 1000, estimatedAfter: 400, summaryUsage: { input: 800, output: 20 }, followupMessageId: 'a2' }
it('压缩结果区分估算、后续实际输入与摘要消耗，历史仍可展开', () => {
  render(<CompactionRecords records={[success]} messages={[{ id: 'a2', message: { role: 'assistant', content: [], model: 'm', api: 'a', provider: 'p', timestamp: 3, stopReason: 'stop', usage: { input: 450 } } }]} />)
  expect(screen.getByText(/预计减少/)).toHaveTextContent('600')
  expect(screen.getByText(/后续实际输入/)).toHaveTextContent('450')
  expect(screen.getByText(/摘要调用消耗/)).toHaveTextContent('800')
  fireEvent.click(screen.getByText('查看摘要'))
  expect(screen.getByText('项目青禾')).toBeInTheDocument()
})
it('展开摘要后分组显示实际文件路径，空分组省略，文件名按字面显示', () => {
  const path = '/work/[note](https://example.com).md'
  const { rerender } = render(<CompactionRecords records={[{ ...success, fileOperations: { readFiles: [path], modifiedFiles: ['/work/agent.ts'] } }]} messages={[]} />)
  fireEvent.click(screen.getByText('查看摘要'))
  const read = screen.getByRole('list', { name: '仅读文件' })
  expect(within(read).getByRole('listitem')).toHaveTextContent(path)
  expect(within(read).queryByRole('link')).not.toBeInTheDocument()
  expect(within(screen.getByRole('list', { name: '已改文件' })).getByRole('listitem')).toHaveTextContent('/work/agent.ts')
  rerender(<CompactionRecords records={[{ ...success, fileOperations: { readFiles: [], modifiedFiles: ['/work/agent.ts'] } }]} messages={[]} />)
  expect(screen.queryByText('仅读文件')).not.toBeInTheDocument()
})
it('没有后续 input 时保持未知，失败及中止记录不显示节省量', () => {
  const { rerender } = render(<CompactionRecords records={[{ ...success, followupMessageId: undefined }]} messages={[]} />)
  expect(screen.getByText(/尚未取得后续实际输入/)).toBeInTheDocument()
  for (const status of ['failed', 'aborted', 'skipped'] as const) {
    rerender(<CompactionRecords records={[{ id: 'f', trigger: 'auto', status, startedAt: 1, finishedAt: 2, reason: '保留原内容' }]} messages={[]} />)
    expect(screen.getByText('保留原内容')).toBeInTheDocument()
    expect(screen.queryByText(/预计减少/)).not.toBeInTheDocument()
  }
})
