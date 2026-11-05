import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Credentials } from '@agent-learning/credentials'
import { createModelStream, findModel, type AssistantMessage, type ModelContext } from '@agent-learning/model'
import { defaultTools } from '../src/tools.js'

const cases = [
  { name: 'read', task: '使用 read 读取 note.txt，从第 1 行开始，最多 5 行。', arguments: { path: 'note.txt', offset: 1, limit: 5 } },
  { name: 'bash', task: '使用 bash 运行 pwd，超时 10 秒。', arguments: { command: 'pwd', timeout: 10 } },
  { name: 'edit', task: '使用 edit，将 note.txt 中的“旧内容”替换为“新内容”，以 edits 数组描述。', arguments: { path: 'note.txt', edits: [{ oldText: '旧内容', newText: '新内容' }] } },
  { name: 'write', task: '使用 write，将文本你好写入 draft.txt，content 只含这两个字。', arguments: { path: 'draft.txt', content: '你好' } },
]

describe('explicit real DeepSeek tool acceptance; no execution or chat history', () => {
  for (const scenario of cases) it(`requests ${scenario.name} with exact task arguments`, async (test) => {
    const credentials = new Credentials()
    const status = await credentials.readStatus()
    if (status.state === 'missing') {
      console.info(JSON.stringify({ task: scenario.task, judgement: '待执行', reason: '未配置 DeepSeek 凭据' }))
      test.skip('未配置 DeepSeek 凭据，真实工具验收待执行')
      return
    }
    if (status.state === 'error') {
      console.info(JSON.stringify({ task: scenario.task, judgement: '未通过', reason: '本机模型凭据无法读取或格式无效' }))
      throw new Error('本机模型凭据无法读取或格式无效；真实工具验收未通过。')
    }

    const context: ModelContext = {
      systemPrompt: '本次只验收工具调用声明，不执行工具。只提出一条用户指定工具的调用，不为检查文件或环境先调用其他工具。用户给出的路径和原文就是本次调用需要的全部信息，不声称已经取得执行结果。',
      messages: [{ role: 'user', content: scenario.task, timestamp: Date.now() }],
      tools: defaultTools,
    }
    let message: AssistantMessage
    try {
      const stream = createModelStream(credentials)(findModel('deepseek-flash')!, context)
      for await (const _event of stream) {}
      message = await stream.result()
    } catch {
      console.info(JSON.stringify({ task: scenario.task, judgement: '未通过', reason: '模型请求或响应接收未能完成' }))
      throw new Error('模型请求或响应接收未能完成；真实工具验收未通过。')
    }

    const calls = message.content.filter(block => block.type === 'toolCall')
    const passed = (message.stopReason === 'stop' || message.stopReason === 'toolUse')
      && calls.length === 1 && calls[0]!.id.length > 0 && calls[0]!.name === scenario.name
      && calls[0]!.argumentsError === undefined && isDeepStrictEqual(calls[0]!.arguments, scenario.arguments)
    console.info(JSON.stringify({
      task: scenario.task,
      calls: calls.map(call => ({ id: call.id, name: call.name, args: call.arguments })),
      reason: message.stopReason,
      judgement: passed ? '通过' : '未通过',
    }))
    expect(passed, '最终须正常结束，并收到一个编号非空、名称及参数与任务完全一致的调用').toBe(true)
  }, 360_000)
})
