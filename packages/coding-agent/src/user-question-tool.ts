import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { QuestionAnswer, UserQuestion } from './collaboration.js'
import type { CodingTool } from './tools.js'

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'

const nonblank = { pattern: '\\S' }
const strictObject = { additionalProperties: false } as const
const parameters = Type.Object({
  questions: Type.Array(Type.Object({
    id: Type.String({ ...nonblank, description: '题号，在这次调用中唯一。' }),
    question: Type.String({ ...nonblank, description: '简洁、具体，用户可以直接理解的问题。' }),
    header: Type.Optional(Type.String({ ...nonblank, description: '可选短标题。' })),
    options: Type.Optional(Type.Array(Type.Object({
      label: Type.String({ ...nonblank, description: '显示给用户的选项，同题内唯一。' }),
      description: Type.Optional(Type.String({ ...nonblank, description: '简述选择的影响。' })),
    }, strictObject))),
    multi_select: Type.Optional(Type.Boolean({ description: '默认单选。设为 true 时可以多选，并可同时填写自由文字。' })),
  }, strictObject), { minItems: 1 }),
  timeout: Type.Optional(Type.Union([Type.Literal(-1), Type.Integer({ minimum: 1, maximum: 2_147_483 })], {
    description: '整组等待秒数。仅在用户明确指定本次等待方式时填写，-1 表示一直等待。',
  })),
}, strictObject)

const answerList = Type.Array(Type.Object({
  id: Type.String(nonblank),
  selected: Type.Array(Type.String(nonblank), { uniqueItems: true }),
  custom: Type.Optional(Type.String(nonblank)),
}, strictObject))

export function createUserQuestionTool(ask: (
  request: { questions: UserQuestion[]; timeout?: number },
  execution: { signal: AbortSignal; toolCallId: string },
) => Promise<string>): CodingTool {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: '缺少会影响结果的关键信息、偏好或选择时，向用户提出一组简洁的问题。'
      + '依赖答案的操作必须在读取结果之后安排，不能与提问放在同一批调用。'
      + '答案按题号返回，空 selected 且省略 custom 表示用户跳过该题。'
      + 'pending 表示等待超时，用户仍可补答。跳过或超时后继续不依赖缺失答案的工作，只有明确答复才能确认用户的选择。',
    parameters,
    executionMode: 'sequential',
    preserveFailure: true,
    async execute(args, { signal, toolCallId }) {
      signal.throwIfAborted()
      if (!Check(parameters, args)) throw new Error('提问参数不符合要求。')
      const questions = args.questions.map(question => ({
        id: question.id.trim(),
        question: question.question.trim(),
        ...(question.header !== undefined && { header: question.header.trim() }),
        ...(question.options !== undefined && { options: question.options.map(option => ({
          label: option.label.trim(),
          ...(option.description !== undefined && { description: option.description.trim() }),
        })) }),
        ...(question.multi_select !== undefined && { multi_select: question.multi_select }),
      }))
      if (new Set(questions.map(question => question.id)).size !== questions.length) {
        throw new Error('同组题号必须唯一。')
      }
      for (const { options } of questions) {
        if (options && new Set(options.map(option => option.label)).size !== options.length) {
          throw new Error('同一道题的选项名称必须唯一。')
        }
      }
      return ask({ questions, ...(args.timeout !== undefined && { timeout: args.timeout }) }, { signal, toolCallId })
    },
  }
}

export function validateQuestionAnswers(questions: UserQuestion[], raw: unknown): QuestionAnswer[] {
  if (!Check(answerList, raw) || raw.length !== questions.length) {
    throw new Error('请为每道题提交一条答案或跳过记录。')
  }
  const answers = new Map(raw.map(answer => [answer.id, answer]))
  if (answers.size !== raw.length) throw new Error('每个题号只能提交一次。')
  return questions.map(question => {
    const answer = answers.get(question.id)
    if (!answer) throw new Error('答案题号与原问题不匹配。')
    const { id, selected, custom } = answer
    if (selected.some(label => !question.options?.some(option => option.label === label))) {
      throw new Error('答案包含原问题未提供的选项。')
    }
    if (!question.multi_select && (selected.length > 1 || (selected.length === 1 && custom !== undefined))) {
      throw new Error('单选题可选一项或填写自由文字。')
    }
    return { id, selected: [...selected], ...(custom !== undefined && { custom: custom.trim() }) }
  })
}
