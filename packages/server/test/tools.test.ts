import { expect, it } from 'vitest'
import { Check } from 'typebox/value'

it('提供 read、bash、edit、write 四种具备用途说明的工具声明', async () => {
  const { defaultTools } = await import('../src/tools.js')

  expect(defaultTools.map(tool => tool.name)).toEqual(['read', 'bash', 'edit', 'write'])
  for (const tool of defaultTools) {
    expect(tool.description.trim()).not.toBe('')
    expect(tool.parameters).toHaveProperty('type', 'object')
  }
})

it.each([
  {
    name: 'read',
    fields: ['path', 'offset', 'limit'],
    valid: [
      { path: 'note.txt' },
      { path: 'note.txt', offset: 1, limit: 5 },
      { path: 'note.txt', offset: -0.5, limit: 0 },
      { path: 'note.txt', offset: 0, limit: 1.5 },
      { path: 'note.txt', offset: 1e12, limit: 1e12 },
    ],
    invalid: [
      {},
      { path: 1 },
      { path: 'note.txt', offset: '1' },
      { path: 'note.txt', limit: '5' },
    ],
  },
  {
    name: 'bash',
    fields: ['command', 'timeout'],
    valid: [
      { command: 'pwd' },
      { command: 'pwd', timeout: 5 },
      { command: 'pwd', timeout: -0.5 },
      { command: 'pwd', timeout: 0 },
      { command: 'pwd', timeout: 1e12 },
    ],
    invalid: [
      {},
      { command: 1 },
      { command: 'pwd', timeout: '5' },
    ],
  },
  {
    name: 'edit',
    fields: ['path', 'edits'],
    valid: [
      { path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] },
      { path: 'note.txt', edits: [{ oldText: 'a', newText: '' }, { oldText: 'b', newText: 'c' }] },
      { path: 'note.txt', edits: [] },
    ],
    invalid: [
      { edits: [] },
      { path: 'note.txt' },
      { path: 1, edits: [] },
      { path: 'note.txt', edits: {} },
      { path: 'note.txt', edits: [{ newText: 'after' }] },
      { path: 'note.txt', edits: [{ oldText: 'before' }] },
      { path: 'note.txt', edits: [{ oldText: 1, newText: 'after' }] },
      { path: 'note.txt', edits: [{ oldText: 'before', newText: 1 }] },
    ],
  },
  {
    name: 'write',
    fields: ['path', 'content'],
    valid: [
      { path: 'note.txt', content: 'hello' },
      { path: 'note.txt', content: '' },
    ],
    invalid: [
      { content: 'hello' },
      { path: 'note.txt' },
      { path: 1, content: 'hello' },
      { path: 'note.txt', content: 1 },
    ],
  },
])('$name 参数规则保留约定字段、必填项、类型与允许的边界', async ({ name, fields, valid, invalid }) => {
  const { defaultTools } = await import('../src/tools.js')
  const tool = defaultTools.find(tool => tool.name === name)!

  if (!('properties' in tool.parameters) || typeof tool.parameters.properties !== 'object' || tool.parameters.properties === null) {
    throw new Error('Expected object parameter rules')
  }
  expect(Object.keys(tool.parameters.properties)).toEqual(fields)
  for (const parameters of valid) expect(Check(tool.parameters, parameters)).toBe(true)
  for (const parameters of invalid) expect(Check(tool.parameters, parameters)).toBe(false)
})
