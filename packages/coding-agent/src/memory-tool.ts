import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'
import { MemoryStoreError, type MemoryOperation, type MemoryProject, type MemoryStore } from './memory-store.js'
import type { CodingTool } from './tools.js'

export const MEMORY_TOOL_NAME = 'memory'

const scopeParameter = Type.Union([Type.Literal('user'), Type.Literal('project')])
const memoryType = Type.Union([Type.Literal('feedback'), Type.Literal('project'), Type.Literal('reference')])
const nonBlank = Type.String({ pattern: '\\S' })
const singleLine = Type.String({ pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$' })
const expiresAt = Type.String({ format: 'date-time', description: '带时区的完整日期时间，例如 2026-11-27T09:00:00+08:00。' })
const noteFields = { title: singleLine, summary: singleLine, content: nonBlank }
const targetFields = { entryId: nonBlank, expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }
const changes = Type.Partial(Type.Object({ ...noteFields, type: memoryType, expiresAt: Type.Union([expiresAt, Type.Null()]) }),
  { additionalProperties: false, minProperties: 1 })
const mergeFromEntryIds = Type.Array(nonBlank, { minItems: 1, uniqueItems: true })

const writeOperation = Type.Object({
  operation: Type.Literal('write'), ...noteFields, type: Type.Optional(memoryType), expiresAt: Type.Optional(expiresAt),
}, { additionalProperties: false })
const updateOperation = Type.Object({
  operation: Type.Literal('update'), ...targetFields, changes,
  mergeFromEntryIds: Type.Optional(mergeFromEntryIds),
}, { additionalProperties: false })
const deleteOperation = Type.Object({ operation: Type.Literal('delete'), ...targetFields }, { additionalProperties: false })
const operation = Type.Union([writeOperation, updateOperation, deleteOperation])
const singleOperationFields = Type.Partial(Type.Object({
  operation: Type.Union([writeOperation.properties.operation, updateOperation.properties.operation, deleteOperation.properties.operation]),
  ...noteFields, ...targetFields, type: memoryType, expiresAt, changes, mergeFromEntryIds,
})).properties

const parameters = Type.Object({
  scope: scopeParameter, ...singleOperationFields, operations: Type.Optional(Type.Array(operation, { minItems: 2 })),
}, { additionalProperties: false })

const description = `常规请求一次改一条。operation 选择 write、update 或 delete。scope 选择 user 或 project，项目由当前会话确定。

write 提交 title（主题）、summary（一句简述）和 content（Markdown 正文）。scope 为 project 时提交 type（feedback、project 或 reference）。个人条目省去 type。
update 提交 entryId、expectedRevision 和 changes。用已读的 revision 作为 expectedRevision。未提交的字段保留原值。
delete 提交 entryId 和读取到的 expectedRevision。

expiresAt 只用于有明确失效时点的 project 类条目。更新时用 changes.expiresAt 提交日期，或用 null 清除原有期限。

个人新增超限时，可按回执用 scope 为 user 和 operations 提交一组改动。归并时在 update 的 mergeFromEntryIds 填入被并入条目的编号，每个编号对应同批的 delete，工具保留旧来源。整批校验通过且最终正文符合上限时一起保存。

保存成功后，程序记录当前会话和保存时间。容量不足的原因留在工具回执里，继续当前任务。用户明确要求记住、纠正或忘掉时，其余结果按回执说明。`

const successMessages = {
  saved: '已保存，这次修改已完成。继续当前任务。',
  deleted: '已删除，这次修改已完成。继续当前任务。',
  unchanged: '已有相同记忆，这条已处理。继续当前任务。',
}

const forbiddenMessage = '当前会话无权写入长期记忆。'

type Scope = Static<typeof scopeParameter>
type WireOperation = Static<typeof operation>

function invalidRequest(message: string): never {
  throw new MemoryStoreError('invalid_request', message)
}

function validateOperation(input: WireOperation, scope: Scope, batch: boolean): MemoryOperation {
  if (input.operation === 'delete') return input
  const note = input.operation === 'write' ? input : input.changes
  if (scope === 'user' && (note.type !== undefined || note.expiresAt !== undefined)) {
    invalidRequest('个人记忆的参数不包含 type 或 expiresAt。')
  }
  if (scope === 'project' && input.operation === 'write' && !note.type) invalidRequest('新增项目记忆时请提供 type。')
  if (note.type !== undefined && note.type !== 'project' && typeof note.expiresAt === 'string') {
    invalidRequest('只有 project 类笔记可以设置 expiresAt。')
  }
  if (input.operation === 'update' && !batch && input.mergeFromEntryIds) {
    invalidRequest('归并需要在个人记忆的 operations 中提交。')
  }
  return input
}

function receipt(status: string, message: string, isError: boolean, details?: Record<string, unknown>) {
  return { isError, content: [{ type: 'text' as const, text: JSON.stringify({ ...details, status, message }) }] }
}

function explainFailure(error: MemoryStoreError, scope: Scope | undefined, operations: readonly MemoryOperation[]) {
  if (error.code === 'version_conflict') return '条目版本已变化，本次未修改。根据返回的最新条目重新判断是否还需要改。'
  if (error.code === 'write_forbidden') return forbiddenMessage
  if (error.code !== 'capacity_exceeded' || !error.details) return error.message

  if (scope === 'user') {
    const { usedChars, limitChars, overByChars } = error.details
    if (operations.length > 1) return `归并后仍超出上限 ${overByChars} 个字符，整批未保存。跳过这次新增，继续任务。`
    if (operations[0]?.operation === 'write') {
      return `本次未保存。个人记忆已用 ${usedChars}／${limitChars} 字符，写入这条还需腾出 ${overByChars} 个字符。如果能保留有效信息，把精简或归并与待新增项一起放进本次重试的 \`operations\`。找不到可整理的条目时，跳过新增，继续任务。`
    }
    return `更新后会超出上限 ${overByChars} 个字符，原文已保留。能保留有效信息时缩短更新内容，否则继续任务。`
  }

  const { overByCount, overByDirectoryBytes, overByNoteBytes } = error.details
  const limits = [
    typeof overByCount === 'number' && `目录条数超限 ${overByCount} 条`,
    typeof overByDirectoryBytes === 'number' && `目录大小超限 ${overByDirectoryBytes} 字节`,
    typeof overByNoteBytes === 'number' && `单篇笔记超限 ${overByNoteBytes} 字节`,
  ].filter(Boolean).join('，')
  return `本次修改未保存。${limits}。同主题的补充可尝试更新原笔记。大小超限时可精简相关简述或正文，保留有效信息和来源。仍放不下时，结束这次记忆操作，继续当前任务。`
}

export function createMemoryTool({ store, project, sessionId, canWrite }: {
  store: MemoryStore
  project?: MemoryProject
  sessionId: string
  canWrite: () => boolean
}): CodingTool {
  return {
    name: MEMORY_TOOL_NAME, parameters, description, preserveFailure: true,
    promptSnippet: '按记忆规则写入、更新或删除长期记忆。',
    async execute(args, { signal }) {
      let scope: Scope | undefined
      let operations: MemoryOperation[] = []
      try {
        signal.throwIfAborted()
        if (!canWrite()) throw new MemoryStoreError('write_forbidden', forbiddenMessage)
        if (!Check(parameters, args)) invalidRequest('memory 工具参数不符合声明。')
        const { scope: requestScope, operations: batch, ...single } = args
        scope = requestScope
        if (scope === 'project' && !project) throw new MemoryStoreError('memory_not_available', '当前会话的项目记忆不可用。')
        if (batch) {
          if (scope !== 'user' || Object.keys(single).length || batch.filter(item => item.operation === 'write').length !== 1) {
            invalidRequest('operations 用于个人记忆的整理和单条新增，请省去单条操作参数。')
          }
          operations = batch.map(item => validateOperation(item, requestScope, true))
        } else {
          if (!Check(operation, single)) invalidRequest('请按 operation 提供对应的单条修改参数。')
          operations = [validateOperation(single, requestScope, false)]
        }
        const result = await store.apply(scope, project, operations, { sessionId, signal, canCommit: canWrite })
        return receipt(result.status, successMessages[result.status], false, result)
      } catch (error) {
        if (signal.aborted && error === signal.reason) {
          throw Object.assign(new Error('任务已取消，记忆修改未提交。', { cause: error }), { code: 'interrupted' })
        }
        if (error instanceof MemoryStoreError) return receipt(error.code, explainFailure(error, scope, operations), true, error.details)
        throw error
      }
    },
  }
}
