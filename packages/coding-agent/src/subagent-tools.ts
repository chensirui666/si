import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import type { DelegationItem } from './subagent-types.js'
import type { CodingTool } from './tools.js'

export const SUBAGENT_TOOL = 'subagent'
export const TEAM_TOOL = 'team'

const name = Type.String({ minLength: 1, maxLength: 128 })
const text = Type.String({ minLength: 1 })
const task = Type.Object({
  task: text,
  agent: Type.Optional(name),
  name: Type.Optional(name),
  cwd: Type.Optional(text),
}, { additionalProperties: false })

const target = { sessionId: Type.Optional(name), name: Type.Optional(name), message: Type.Optional(text), background: Type.Optional(Type.Boolean()) }
const tools = {
  subagent: Type.Object({
    action: Type.Union([Type.Literal('run'), Type.Literal('continue'), Type.Literal('steer'), Type.Literal('stop'), Type.Literal('status')]),
    ...target,
    agent: task.properties.agent,
    cwd: task.properties.cwd,
    task: Type.Optional(text),
    tasks: Type.Optional(Type.Array(task, { minItems: 1, maxItems: 8 })),
    chain: Type.Optional(Type.Array(task, { minItems: 1, maxItems: 8 })),
    agentScope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('project'), Type.Literal('both')])),
  }, { additionalProperties: false }),
  team: Type.Object({
    action: Type.Union([Type.Literal('continue'), Type.Literal('steer'), Type.Literal('answer'), Type.Literal('list')]),
    ...target,
  }, { additionalProperties: false }),
}
const descriptions = {
  subagent: '把任务交给独立子 Agent。run 提交单个 task、并行 tasks 或串行 chain 三者之一。每项可指定 agent 角色、唯一 name、本机 cwd。串行步骤中的 {previous} 替换为上一步答复。run 和 continue 必须明确 background：false 等结果，true 先接单，结束后会回报。continue 用 sessionId 或 name 从原历史开启空闲子会话。steer 给运行中的子 Agent 插话，当前步骤收尾后送达。stop 停止指定子 Agent。status 查询指定子 Agent，省略目标时列出自己派出的子 Agent。',
  team: '联系直属主 Agent 或同级子 Agent。以 sessionId 或唯一 name 指定收件人，name 为 parent 时联系直属主 Agent。continue 从目标已有历史启动新轮，必须提供 message 和 background；false 等答复，true 先接单、完成后回报。steer 用 message 给正在运行的目标插话，当前步骤收尾后送达。answer 读取同级子 Agent 最近完成的答复。list 列出其他同级子 Agent 及状态。只在帮助推进任务时发消息。',
}

export type SubagentTask = Static<typeof task>
export type SubagentArgs = Static<typeof tools.subagent> | Static<typeof tools.team>
export type RunSubagentTool = (args: SubagentArgs, context: Parameters<CodingTool['execute']>[1]) => Promise<unknown>

export function createSubagentTool(name: typeof SUBAGENT_TOOL | typeof TEAM_TOOL, run: RunSubagentTool): CodingTool {
  const parameters = tools[name]
  return {
    name, parameters, description: descriptions[name], promptSnippet: name === 'subagent' ? '委派、续用和管理独立子 Agent。' : '与主 Agent 和同级子 Agent 协作。',
    validateArguments: args => Check(parameters, args),
    async execute(args, context) {
      if (!Check(parameters, args)) throw new Error('子 Agent 参数无效。')
      const result = await run(args, context)
      if (context.nestedToolCallId && result && typeof result === 'object' && 'items' in result && Array.isArray(result.items)) {
        const tasks = (result.items as DelegationItem[]).map(({ sessionId, status, output, error }) => ({
          sessionId, status, ...(output !== undefined && { reply: output }), ...(error !== undefined && { error }),
        }))
        context.recordDetails({ kind: 'codemode-delegation', tasks })
      }
      return JSON.stringify(result)
    },
  }
}
