import { expect, it } from 'vitest'
import { createUserQuestionTool, validateQuestionAnswers } from '../src/user-question-tool.js'

const question = { id: 'format', question: '用哪种格式？', options: [{ label: 'JSON' }, { label: 'Markdown' }] }
const questions = [
  question,
  { id: 'content', question: '要包括什么？', multi_select: true, options: [{ label: '示例' }] },
  { id: 'notes', question: '还有什么补充？' },
]
const context = { toolCallId: 'call-1', contentIndex: 0, signal: new AbortController().signal, recordDetails() {} }

it('将规范化的整组问题与原调用编号交给会话，返回会话的结果', async () => {
  const tool = createUserQuestionTool(async (request, execution) => {
    expect(request).toEqual({
      questions: [{ id: 'format', question: '用哪种格式？', header: '格式',
        options: [{ label: 'JSON', description: '机器可读' }], multi_select: false }],
      timeout: 2_147_483,
    })
    expect(execution).toEqual({ toolCallId: 'call-1', signal: context.signal })
    return '{"answers":[{"id":"format","selected":["JSON"]}]}'
  })

  expect(tool.executionMode).toBe('sequential')
  await expect(tool.execute({
    questions: [{ id: ' format ', question: ' 用哪种格式？ ', header: ' 格式 ',
      options: [{ label: ' JSON ', description: ' 机器可读 ' }], multi_select: false }],
    timeout: 2_147_483,
  }, context)).resolves.toBe('{"answers":[{"id":"format","selected":["JSON"]}]}')
})

it.each([
  { questions: [] },
  { questions: [{ ...question, question: ' ' }] },
  { questions: [{ ...question, approved: true }] },
  { questions: [question, { ...question, id: ' format ' }] },
  { questions: [{ ...question, options: [{ label: 'JSON' }, { label: ' JSON ' }] }] },
  { questions: [{ ...question, options: [{ label: ' ' }] }] },
  ...[0, -2, 1.5, 2_147_484, '30'].map(timeout => ({ questions: [question], timeout })),
])('拒绝无效提问 %j', async args => {
  const tool = createUserQuestionTool(async () => { throw new Error('invalid question reached the session') })
  await expect(tool.execute(args, context)).rejects.toThrow(/提问|题号|选项/)
})

it.each([{}, { timeout: -1 }, { timeout: 1 }])('保留省略、无限或有限等待参数 %j', async timing => {
  const tool = createUserQuestionTool(async request => JSON.stringify(request))
  await expect(tool.execute({ questions: [question], ...timing }, context)).resolves.toBe(JSON.stringify({
    questions: [question], ...timing,
  }))
})

it('接受选项、多选加自由文字和跳过，按原问题顺序返回', () => {
  expect(validateQuestionAnswers(questions, [
    { id: 'notes', selected: [] },
    { id: 'content', selected: ['示例'], custom: ' 加迁移说明 ' },
    { id: 'format', selected: ['JSON'] },
  ])).toEqual([
    { id: 'format', selected: ['JSON'] },
    { id: 'content', selected: ['示例'], custom: '加迁移说明' },
    { id: 'notes', selected: [] },
  ])
  expect(validateQuestionAnswers([question], [{ id: 'format', selected: [], custom: 'CSV' }]))
    .toEqual([{ id: 'format', selected: [], custom: 'CSV' }])
})

it.each([
  ['缺少题目', []],
  ['重复题号', [{ id: 'format', selected: [] }, { id: 'format', selected: [] }]],
  ['未知题号', [{ id: 'unknown', selected: [] }, { id: 'content', selected: [] }]],
  ['未知选项', [{ id: 'format', selected: ['CSV'] }, { id: 'content', selected: [] }]],
  ['单选题选中多项', [{ id: 'format', selected: ['JSON', 'Markdown'] }, { id: 'content', selected: [] }]],
  ['单选题同时选中和自由填写', [{ id: 'format', selected: ['JSON'], custom: 'CSV' }, { id: 'content', selected: [] }]],
  ['多选题重复选中', [{ id: 'format', selected: [] }, { id: 'content', selected: ['示例', '示例'] }]],
  ['空白自由答案', [{ id: 'format', selected: [], custom: ' ' }, { id: 'content', selected: [] }]],
  ['无选项列表', [{ id: 'format', custom: 'CSV' }, { id: 'content', selected: [] }]],
])('拒绝答案组合「%s」', (_name, answers) => {
  expect(() => validateQuestionAnswers(questions.slice(0, 2), answers)).toThrow()
})
