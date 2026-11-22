import { Type } from 'typebox'
import type { JsonObject } from '@agent-learning/model'
import type { CodingTool } from './tools.js'

export const CRONJOB_TOOL_NAME = 'cronjob_manage'

export type ScheduleToolContext = { sessionId: string; workspaceId: string; runId: string }
export type ManageSchedule = (context: ScheduleToolContext, args: JsonObject) => unknown

const parameters = Type.Object({
  action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('delete')]),
  id: Type.Optional(Type.String({ description: '定时计划编号。省略时使用当前会话的计划。' })),
  prompt: Type.Optional(Type.String({ description: '到点时交给 Agent 执行的指令。创建时必须提供。' })),
  schedule: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal('daily'), Type.Literal('weekdays'), Type.Literal('weekly')]),
    time: Type.String({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$', description: '当地 24 小时时钟，格式 HH:MM。时区由服务端确定。' }),
    weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
      minItems: 1, maxItems: 7, uniqueItems: true, description: '仅每周计划提供，周一为 1、周日为 7。',
    })),
  }, { additionalProperties: false, description: '重复日程。创建时必须提供。' })),
  sessionMode: Type.Optional(Type.Union([Type.Literal('reuse'), Type.Literal('new')], {
    description: '仅修改执行会话方式时提供。reuse 使用原会话，new 每轮新建会话。',
  })),
}, { additionalProperties: false })

const description = '管理当前会话的重复定时任务。仅在用户明确请求时创建或变更。支持每天、工作日、每周指定星期几。信息不足先询问，明确只执行一次时说明目前仅支持重复任务。根据保存回执报告实际结果。'

export function createCronjobTool(manage: (args: JsonObject) => unknown): CodingTool {
  return {
    name: CRONJOB_TOOL_NAME, description, parameters, preserveFailure: true,
    async execute(args, { signal }) {
      signal.throwIfAborted()
      return JSON.stringify(await manage(args))
    },
  }
}
