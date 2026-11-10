import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompactionRecord, ConversationSnapshot } from '@agent-learning/server/protocol'
import { createModelStream, findModel, type AssistantMessage, type ModelContext, type Tool } from '@agent-learning/model'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from '@playwright/test'
import { buildModelHistory } from '../../../packages/coding-agent/src/compaction'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, openSession, ready, saveKey, seedSession } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

type Success = Extract<CompactionRecord, { status: 'success' }>
type WireRequest = {
  model: string
  max_tokens: number
  messages: { role: string; content: string | null; reasoning_content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]
  tools?: { type: string; function: Tool }[]
}

function textOf(message: AssistantMessage) {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

async function submit(page: Page, observed: ReturnType<typeof observe>, prompt: string) {
  const before = observed.updates.length
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill(prompt)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  const receipt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
  await send.click()
  const response = await receipt
  expect(response.status()).toBe(202)
  const accepted: { kind: 'message' | 'compaction'; compactionId?: string } = await response.json()
  await expect(editor).toHaveText('')
  await expect.poll(() => observed.updates.slice(before).some(({ update }) =>
    'running' in update.change && update.change.running === null), { timeout: 240_000 }).toBe(true)
  if (accepted.kind === 'compaction') return { accepted }
  const terminals = observed.updates.slice(before).flatMap(({ update }) =>
    update.change.type === 'model' && update.change.event.type === 'done' ? [update.change.event.message] : [])
  const message = terminals.at(-1)
  if (!message) throw new Error('真实任务没有正常完成，请检查脱敏后的页面错误')
  expect(message.stopReason).toBe('stop')
  return { accepted, message }
}

async function refresh(page: Page, observed: ReturnType<typeof observe>) {
  const before = observed.snapshots.length
  await page.reload()
  await ready(page, observed, before, false)
  const snapshot = observed.snapshots.at(-1)!.snapshot
  expect(snapshot.running).toBeNull()
  return snapshot
}

function requireSuccess(snapshot: ConversationSnapshot, id: string): Success {
  const record = snapshot.compactions.find(record => record.id === id)
  expect(record?.status).toBe('success')
  if (record?.status !== 'success') throw new Error('压缩未成功，不能作为真实验收通过')
  expect(record.estimatedAfter).toBeLessThan(record.estimatedBefore)
  expect(record.summaryUsage?.input).toBeGreaterThan(0)
  return record
}

test('Feature7 live case68: 同网页会话手动和自动压缩两次，实测输入下降并继续真实文件任务', async ({ page, context }, testInfo) => {
  test.setTimeout(1_200_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE；不读取未指定的真实凭据')
  let key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature7-live-'))
  const cwd = join(temporary, 'workspace')
  const model = findModel('deepseek-flash')!
  const budget = { triggerTokens: 20_000, keepRecentTokens: 400 }
  const requests: WireRequest[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, compaction: budget,
    globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return globalThis.fetch(url, init)
    } },
  })
  const evidence: { recordId: string; trigger: string; actualBefore: number; actualAfter: number; summaryInput: number; summaryOutput?: number }[] = []
  try {
    await mkdir(cwd)
    const workspacePath = await realpath(cwd)
    const firstReadFiles = ['index.txt', 'note.txt'].map(path => join(workspacePath, path))
    const deliveryId = `delivery-${randomUUID().slice(0, 8)}`
    const region = '苏州'
    const batchId = `batch-${randomUUID().slice(0, 8)}`
    await Promise.all([
      writeFile(join(cwd, 'index.txt'), '下一条线索在 note.txt。请读取该文件。'),
      writeFile(join(cwd, 'note.txt'), '项目名称：青禾\n当前交付尚未完成。'),
      writeFile(join(cwd, 'progress.txt'), `批次编号：${batchId}\n以下为无业务意义的运行日志，不需要记住：\n${randomBytes(4000).toString('hex')}\n末尾状态：已准备。`),
    ])
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, key)

    const first = await submit(page, observed, `我们要继续同一项交付任务。两项必须一直记住的早期事实：交付编号是 ${deliveryId}，发布地区是${region}。约束：仅操作当前临时工作区；禁止在其他目录写文件。最终待完成产物是 output.json，键为 deliveryId、region、project、owner、batch；在我明确要求生成产物前不要写文件。初始输出格式约定为 Markdown，稍后可能更正。现在先用 read 读取 index.txt，根据线索继续 read 找出项目名称。读完仅回答“线索已确认”，不要复述两项早期事实。以下是没有业务意义且不需要记住的旧日志：\n${randomBytes(9000).toString('hex')}`)
    expect(textOf(first.message!)).toContain('线索已确认')
    await submit(page, observed, `保持前面的事实、约束和待完成任务。以下只是没有业务意义的近期日志，后续摘要可以省略；不要调用工具，只回答“已收到”。\n${randomBytes(1200).toString('hex')}`)
    const beforeManual = await refresh(page, observed)
    expect(beforeManual.compactions).toEqual([])
    const taskTemplate = requests.find(request => request.tools?.length === 8)!
    expect(taskTemplate.tools).toHaveLength(8)
    const systemPrompt = taskTemplate.messages[0]!.content!
    const tools = taskTemplate.tools!.map(tool => tool.function)

    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const submissionsBeforeMenu = observed.submissions.length
    await editor.fill('/')
    await page.getByRole('option', { name: /compact/ }).click()
    await expect(editor).toHaveText('/compact')
    await expect(editor).toBeFocused()
    expect(observed.submissions.length).toBe(submissionsBeforeMenu)
    const manual = await submit(page, observed, '/compact')
    expect(manual.accepted.kind).toBe('compaction')
    const firstSnapshot = await refresh(page, observed)
    const firstRecord = requireSuccess(firstSnapshot, manual.accepted.compactionId!)
    expect(firstRecord.trigger).toBe('manual')
    expect(firstSnapshot.messages).toEqual(beforeManual.messages)
    expect(firstRecord.summary).toContain(deliveryId)
    expect(firstRecord.summary).toContain(region)
    expect(firstRecord.fileOperations).toMatchObject({ readFiles: expect.arrayContaining(firstReadFiles), modifiedFiles: [] })
    const firstRecordView = page.locator(`[data-compaction-id="${firstRecord.id}"]`)
    await firstRecordView.getByText('查看摘要', { exact: true }).click()
    for (const path of firstReadFiles) await expect(firstRecordView.getByText(path, { exact: true })).toBeVisible()

    // Comparisons use the committed cut point and production history projection, never injected into Agent state.
    const compare = async (snapshot: ConversationSnapshot, record: Success, previous?: Success) => {
      const last = snapshot.messages.findIndex(entry => entry.id === record.contextLastMessageId)
      expect(last).toBeGreaterThanOrEqual(0)
      const entries = snapshot.messages.slice(0, last + 1)
      const probe = { role: 'user' as const, content: '本次仅验证上下文输入。不要调用工具，只回答“对照完成”。', timestamp: 0 }
      const inputs: ModelContext[] = [previous, record].map(latest => ({
        systemPrompt, tools, messages: [...buildModelHistory(entries, latest), probe],
      }))
      const actual: number[] = []
      for (const input of inputs) {
        const run = createModelStream({ readApiKey: async () => key }, { fetch: async (url, init) => {
          const serialized = JSON.parse(String(init?.body)) as WireRequest
          expect(serialized.messages[0]).toEqual(taskTemplate.messages[0])
          expect(serialized.tools).toEqual(taskTemplate.tools)
          expect(serialized.max_tokens).toBe(model.maxTokens)
          return globalThis.fetch(url, init)
        } })(model, input)
        for await (const _event of run) { /* Comparison replies do not enter history or execute tools. */ }
        const response = await run.result()
        expect(response.stopReason).toBe('stop')
        expect(response.usage?.input).toBeGreaterThan(0)
        if (response.usage?.input === undefined) throw new Error('缺少真实输入用量，不能证明压缩下降')
        actual.push(response.usage.input)
      }
      expect(actual[1]).toBeLessThan(actual[0]!)
      const unchanged = await refresh(page, observed)
      expect(unchanged.messages).toEqual(snapshot.messages)
      expect(unchanged.compactions).toEqual(snapshot.compactions)
      evidence.push({ recordId: record.id, trigger: record.trigger, actualBefore: actual[0]!, actualAfter: actual[1]!,
        summaryInput: record.summaryUsage!.input!, summaryOutput: record.summaryUsage?.output })
    }
    await compare(firstSnapshot, firstRecord)

    const resumedRequest = requests.length
    const afterFirst = await submit(page, observed, '不要调用工具。最早约定的发布地区是哪座城市？只回答城市名。')
    expect(textOf(afterFirst.message!)).toContain(region)
    expect(requests[resumedRequest].messages.some(message => message.role === 'user'
      && message.content?.includes(JSON.stringify(firstRecord.fileOperations)))).toBe(true)
    const newFacts = await submit(page, observed, `新事实：负责人 owner 是柳青。更正：项目名称由青禾改为白榆，最终格式由 Markdown 改为 JSON。现在请用 read 读取 progress.txt，记住真实结果中的批次编号，原任务仍待我确认后再生成 output.json；本轮不要写文件，读完只回答“新进度已记录”，不复述交付编号。下面是没有业务意义的临时日志：\n${randomBytes(3000).toString('hex')}`)
    expect(textOf(newFacts.message!)).toContain('新进度已记录')
    await submit(page, observed, `保持所有关键事实、更正和原任务。下面只是没有业务意义的压力日志，不需要纳入摘要，不要调用工具，只回答“已收到压力日志”。\n${randomBytes(24000).toString('hex')}`)
    const secondSnapshot = await refresh(page, observed)
    const automatic = secondSnapshot.compactions.find(record => record.trigger === 'auto' && record.status === 'success')
    expect(automatic).toBeDefined()
    const secondRecord = requireSuccess(secondSnapshot, automatic!.id)
    expect(secondRecord.summary).toContain(deliveryId)
    expect(secondRecord.summary).toContain('柳青')
    expect(secondRecord.summary).toContain('白榆')
    expect(secondRecord.summary).toContain(batchId)
    expect(secondRecord.fileOperations).toMatchObject({
      readFiles: expect.arrayContaining([...firstReadFiles, join(workspacePath, 'progress.txt')]), modifiedFiles: [],
    })
    const recent = buildModelHistory(secondSnapshot.messages, secondRecord).slice(1)
    expect(JSON.stringify(recent)).not.toContain(deliveryId)
    const prior = secondSnapshot.compactions.filter((record): record is Success => record.status === 'success' && record.id !== secondRecord.id && record.startedAt <= secondRecord.startedAt).at(-1)
    expect(prior?.id).toBe(firstRecord.id)
    await compare(secondSnapshot, secondRecord, prior)

    const recalled = await submit(page, observed, '不要使用工具。请根据已经记住的信息回答最早的交付编号、目前负责人、已更正的项目名和最终输出格式、工具读到的批次编号。简短回答，不要重新读文件。')
    const answer = textOf(recalled.message!)
    for (const fact of [deliveryId, '柳青', '白榆', 'JSON', batchId]) expect(answer).toContain(fact)
    const finished = await submit(page, observed, '现在继续最早未完成的交付任务。请使用 write 在当前工作区创建 output.json，内容必须是合法 JSON 对象，键严格为 deliveryId、region、project、owner、batch，值取已经记住的早期事实、最新更正和真实工具结果。不要重新读文件，不要在其他目录写入。收到真实写入成功结果后，只回答“交付已完成”。')
    expect(textOf(finished.message!)).toContain('交付已完成')
    expect(JSON.parse(await readFile(join(cwd, 'output.json'), 'utf8'))).toEqual({ deliveryId, region, project: '白榆', owner: '柳青', batch: batchId })
    const finalSnapshot = await refresh(page, observed)
    expect(finalSnapshot.compactions.filter(record => record.status === 'success').length).toBeGreaterThanOrEqual(2)
    for (const record of [firstRecord, secondRecord]) {
      expect(finalSnapshot.compactions).toContainEqual(expect.objectContaining({ id: record.id, status: 'success', summary: record.summary }))
      const saved = finalSnapshot.compactions.find(item => item.id === record.id) as Success
      const followup = finalSnapshot.messages.find(entry => entry.id === saved.followupMessageId)?.message
      expect(followup?.role === 'assistant' ? followup.usage?.input : undefined).toBeGreaterThan(0)
    }
    expect(finalSnapshot.messages.filter(entry => entry.message.role === 'user').some(entry =>
      typeof entry.message.content === 'string' && entry.message.content.includes(deliveryId))).toBe(true)
    const toolResults = finalSnapshot.messages.flatMap(entry => entry.message.role === 'toolResult' ? [entry.message] : [])
    const reads = toolResults.filter(result => result.toolName === 'read')
    expect(reads.length).toBeGreaterThanOrEqual(3)
    for (const fact of ['下一条线索在 note.txt', '项目名称：青禾', batchId]) {
      expect(reads.some(result => result.content.some(block => block.text.includes(fact)))).toBe(true)
    }
    expect(toolResults.filter(result => result.toolName === 'write')).toHaveLength(1)
    expect(finalSnapshot.messages).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ role: 'toolResult', toolName: 'write' }),
      fileOperation: { kind: 'modified', path: join(workspacePath, 'output.json') },
    }))
    expect(toolResults.every(result => !result.isError)).toBe(true)
    for (const request of requests.filter(request => request.tools?.length)) {
      expect(request.messages[0]).toEqual(taskTemplate.messages[0])
      expect(request.tools).toEqual(taskTemplate.tools)
      expect(request.model).toBe(model.id)
      expect(request.max_tokens).toBe(model.maxTokens)
    }
    await expect(page.getByRole('region', { name: '压缩记录' })).toContainText('已完成')
    await expect(page.getByRole('button', { name: /对话容量/ })).toBeVisible()
    const report = {
      model: { id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }, testBudget: budget,
      comparisons: evidence, successfulCompactions: finalSnapshot.compactions.filter(record => record.status === 'success').length,
      actualReadResults: reads.length, actualWriteResults: 1, actualTools: toolResults.map(result => result.toolName), finalFileVerified: true, systemAndToolsUnchanged: true,
      comparisonRepliesExcludedFromHistory: true,
    }
    const evidencePath = testInfo.outputPath('feature7-live-evidence.json')
    await writeFile(evidencePath, JSON.stringify(report, null, 2))
    await testInfo.attach('feature7-live-evidence', { path: evidencePath, contentType: 'application/json' })
  } catch (error) {
    if (evidence.length) {
      const partialPath = testInfo.outputPath('feature7-live-partial-evidence.json')
      await writeFile(partialPath, JSON.stringify({ model, testBudget: budget, comparisons: evidence, complete: false }, null, 2))
      await testInfo.attach('feature7-live-partial-evidence', { path: partialPath, contentType: 'application/json' })
    }
    throw error
  } finally {
    key = ''
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Feature8 live 38–39: 两段会话按各自的真实文件和历史接续，压缩只影响目标会话', async ({ page, context }, testInfo) => {
  test.setTimeout(900_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const temporary = await mkdtemp(join(tmpdir(), 'agent-feature8-live-'))
  const cwd = join(temporary, 'workspace')
  const codeA = `QH-${randomUUID().slice(0, 8)}`, codeB = `BY-${randomUUID().slice(0, 8)}`
  const contentA = '项目名称：青禾', contentB = '项目名称：白榆'
  const requests: WireRequest[] = []
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, compaction: { triggerTokens: 20_000, keepRecentTokens: 400 },
    globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
    modelOptions: { fetch: async (url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return globalThis.fetch(url, init)
    } },
  })
  try {
    await mkdir(cwd)
    await Promise.all([writeFile(join(cwd, 'a.txt'), contentA), writeFile(join(cwd, 'b.txt'), contentB)])
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    const workspaceId = await addWorkspace(page)
    const a = await seedSession(page, observed, workspaceId)
    await saveKey(page, await readLiveKey(keyFile!))
    const verifyRead = async (filename: string, content: string, code: string, order: string) => {
      const start = requests.length
      await submit(page, observed, `请记住本会话专用代号 ${code}。只调用 read 读取 ${filename}，记住实际工具结果，读完只回复“已记录”。之后我问“按原约定给出结果”时，不使用工具，按约定${order}。`)
      const [first, continuation] = requests.slice(start)
      expect(requests.length - start).toBe(2)
      expect(first?.tools).toHaveLength(8)
      const callId = continuation?.messages.at(-2)?.tool_calls?.[0]?.id
      expect(callId).toBeTruthy()
      expect(continuation?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: callId, content })
      return callId
    }
    const recall = '按原约定给出结果。不要调用工具。'
    const verifyRecall = async (code: string, content: string, otherCode: string, otherContent: string, first: string, last: string) => {
      const start = requests.length
      const result = await submit(page, observed, recall)
      expect(requests.length - start).toBe(1)
      const input = requests[start]!
      expect(JSON.stringify(input.messages)).toContain(code)
      expect(JSON.stringify(input.messages)).toContain(content)
      expect(JSON.stringify(input.messages)).not.toContain(otherCode)
      expect(JSON.stringify(input.messages)).not.toContain(otherContent)
      const answer = textOf(result.message!)
      expect(answer).toContain(first)
      expect(answer).toContain(last)
      expect(answer.indexOf(first)).toBeLessThan(answer.indexOf(last))
      return { input, answer }
    }
    const toolA = await verifyRead('a.txt', contentA, codeA, '先输出代号再输出文件原文')
    const b = await seedSession(page, observed, workspaceId)
    const toolB = await verifyRead('b.txt', contentB, codeB, '先输出文件原文再输出代号')
    await openSession(page, observed, '会话 1')
    const aRecalled = await verifyRecall(codeA, contentA, codeB, contentB, codeA, contentA)
    expect(aRecalled.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: toolA, content: contentA }))
    await openSession(page, observed, '会话 2')
    const bRecalled = await verifyRecall(codeB, contentB, codeA, contentA, contentB, codeB)
    expect(bRecalled.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: toolB, content: contentB }))
    const bBefore = await refresh(page, observed)

    await openSession(page, observed, '会话 1')
    await submit(page, observed, `只回复“收到”。以下随机样本属于近期数据，无需记住或复述。\n${randomBytes(1600).toString('hex')}`)
    const aBefore = await refresh(page, observed)
    const summaryRequest = requests.length
    const manual = await submit(page, observed, '/compact')
    const aAfter = await refresh(page, observed)
    const record = requireSuccess(aAfter, manual.accepted.compactionId!)
    expect(aAfter.messages).toEqual(aBefore.messages)
    expect(record.summary).toContain(codeA)
    expect(record.summary).toContain('青禾')
    expect(record.summary).not.toContain(codeB)
    expect(record.fileOperations?.readFiles).toEqual([join(await realpath(cwd), 'a.txt')])
    expect(requests[summaryRequest]?.tools ?? []).toHaveLength(0)
    expect(JSON.stringify(requests[summaryRequest]?.messages)).toContain(contentA)
    const aResumed = await verifyRecall(codeA, '青禾', codeB, contentB, codeA, contentA)
    expect(aResumed.input.messages[1]?.content).toContain(record.summary)
    expect(aResumed.input.messages.some(message => message.role === 'user' && message.content?.includes('以下随机样本属于近期数据'))).toBe(true)
    expect(aResumed.input.messages.some(message => message.role === 'tool' && message.tool_call_id === toolA)).toBe(false)
    const bAfter = await openSession(page, observed, '会话 2')
    expect(bAfter.sessionId).toBe(b)
    expect(bAfter.snapshot).toEqual(bBefore)
    const bResumed = await verifyRecall(codeB, contentB, codeA, contentA, contentB, codeB)
    expect(JSON.stringify(bResumed.input.messages)).not.toContain(record.summary)
    expect(bResumed.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: toolB, content: contentB }))

    await testInfo.attach('feature8-live-evidence', {
      contentType: 'application/json',
      body: JSON.stringify({
        a, b, toolA, toolB, recordId: record.id, summaryInputTokens: record.summaryUsage?.input,
        sessionA: { code: codeA, toolResult: contentA, before: aRecalled.answer, after: aResumed.answer, requestRoles: aResumed.input.messages.map(message => message.role), usedSummary: true },
        sessionB: { code: codeB, toolResult: contentB, before: bRecalled.answer, after: bResumed.answer, requestRoles: bResumed.input.messages.map(message => message.role), unchangedByACompaction: true },
      }),
    })
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
