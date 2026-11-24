import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebServer } from '@agent-learning/server'
import type { ConversationMessage, RunRecord, StartSessionAccepted, SubmitMessageResult } from '@agent-learning/server/protocol'
import { expect, test } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, saveKey } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('Feature 10 用例 28 真实模型按插话和答案完成改动并依序执行队列', async ({ page, context }, testInfo) => {
  test.setTimeout(360_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  const key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-human-collaboration-live-'))
  const workspace = join(temporary, 'workspace')
  const sessionPath = join(temporary, 'sessions.sqlite')
  const server = new WebServer({
    port: 0, sessionPath, directoryPicker: async () => workspace,
    skillHome: join(temporary, 'skill-home'), globalContextDirectory: join(temporary, 'global-context'),
    browserSecretPath: join(temporary, 'browser-auth.json'), modelAuthPath: join(temporary, 'auth.json'),
    workspacePath: join(temporary, 'workspaces.json'), webSettingsPath: join(temporary, 'settings.json'),
  })
  const keep = '保留旧接口'
  const firstPrompt = [
    '请执行一个真实文件任务，只操作当前临时项目中的文件。每一步完成后才开始下一步。',
    "先用 bash 执行 `echo before-once >> before.txt`，只执行一次。",
    '再用前台 bash 执行 `touch waiting.flag; while [ ! -f continue.flag ]; do sleep 0.2; done`，工具参数设置 timeout 为 90，background 为 false。',
    '标记出现并结束等待后，使用 ask_user_question 提出一道单选题「保留旧接口还是移除旧接口？」。选项标签为「保留旧接口」和「移除旧接口」。',
    '收到答复后执行写文件，把选中的标签原文写到 result.txt。若我补充了新的保存路径，则使用新路径。写完后简短回复。',
  ].join('\n')
  const steering = '用 decision.txt 保存最终决定。'
  const secondPrompt = '请用 bash 执行 cp decision.txt first.txt，然后简短回复。'
  const thirdPrompt = '请用 bash 执行 cp first.txt second.txt，然后简短回复。'

  try {
    await mkdir(workspace)
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, key)
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    const messages = page.getByRole('region', { name: '消息列表', exact: true })

    await editor.fill(firstPrompt)
    const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sessions/start')
    await send.click()
    const started = await firstResponse
    expect(started.status()).toBe(202)
    const { session, accepted } = await started.json() as StartSessionAccepted
    expect(session.workspaceId).toBe(workspaceId)
    await expect.poll(() => access(join(workspace, 'waiting.flag')).then(() => true, () => false), { timeout: 120_000 }).toBe(true)
    expect(await readFile(join(workspace, 'before.txt'), 'utf8')).toBe('before-once\n')

    const submit = async (text: string, mode: 'steering' | 'queued') => {
      await editor.fill(text)
      const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
      if (mode === 'steering') await editor.press('Control+Enter')
      else await send.click()
      const response = await received
      expect(response.status()).toBe(202)
      const receipt = await response.json() as SubmitMessageResult
      expect(receipt).toMatchObject({ kind: mode, sessionId: session.id })
      return receipt.clientMessageId
    }

    const steerId = await submit(steering, 'steering')
    const pendingSteer = messages.getByRole('listitem').filter({ has: page.getByText(steering, { exact: true }) })
    await expect(pendingSteer).toContainText('等待交给模型')
    const secondId = await submit(secondPrompt, 'queued')
    const thirdId = await submit(thirdPrompt, 'queued')
    const queue = page.getByRole('region', { name: '待发送消息', exact: true })
    await expect(queue.locator('[data-queue-id]')).toHaveText([secondPrompt, thirdPrompt])
    await writeFile(join(workspace, 'continue.flag'), '')

    const form = page.getByRole('region', { name: '回答问题', exact: true })
    const option = form.getByRole('radio', { name: /^保留旧接口/ })
    await expect(option).toBeVisible({ timeout: 120_000 })
    const batch = observed.updates.flatMap(({ sessionId, update: { change } }) => sessionId === session.id && change.type === 'interaction'
      ? change.interaction.questions.filter(question => question.status === 'waiting') : []).at(-1)
    if (!batch) throw new Error('没有收到服务端的问题组')
    expect(batch.questions).toHaveLength(1)
    const [question] = batch.questions
    const answers = [{ id: question.id, selected: [keep] }]
    expect(question.options?.map(({ label }) => label)).toEqual([keep, '移除旧接口'])
    await form.getByText(keep, { exact: true }).click()
    await expect(option).toBeChecked()
    const reply = page.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/sessions/${session.id}/questions/${batch.id}/reply`)
    await form.getByRole('button', { name: '提交', exact: true }).click()
    const answered = await reply
    expect(answered.status()).toBe(200)
    expect(await answered.json()).toMatchObject({ kind: 'answered' })
    await expect(form).toHaveCount(0)
    await expect.poll(() => observed.updates.some(({ sessionId, update }) =>
      sessionId === session.id && update.run?.clientMessageId === thirdId && update.run.status === 'completed'),
    { timeout: 150_000 }).toBe(true)

    const decision = await readFile(join(workspace, 'decision.txt'), 'utf8')
    expect(decision.trim()).toBe(keep)
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe(decision)
    expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe(decision)
    await expect(access(join(workspace, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(workspace, 'before.txt'), 'utf8')).toBe('before-once\n')
    await expect(queue).toHaveCount(0)
    await expect(pendingSteer).toHaveCount(1)
    await expect(pendingSteer).not.toContainText('等待交给模型')
    await page.reload()
    const questionRecord = page.locator(`[data-question-batch="${batch.id}"]`)
    await questionRecord.getByRole('button', { name: /1 Question.*已回答/ }).click()
    const review = page.getByRole('region', { name: '查看问题' })
    await expect(review.getByRole('radio', { name: keep })).toBeChecked()
    await review.getByRole('button', { name: '收起' }).click()
    await expect(messages.getByText(steering, { exact: true })).toHaveCount(1)

    await server.close()
    const db = new DatabaseSync(sessionPath, { readOnly: true })
    try {
      const runs = db.prepare('SELECT data FROM runs WHERE session_id = ? ORDER BY seq').all(session.id)
        .map(row => JSON.parse(String(row.data)) as RunRecord)
      expect(runs.map(({ clientMessageId, status }) => [clientMessageId, status])).toEqual([
        [accepted.clientMessageId, 'completed'], [secondId, 'completed'], [thirdId, 'completed'],
      ])
      const [first, second, third] = runs
      expect(first.finishedAt).toBeLessThanOrEqual(second.startedAt)
      expect(second.finishedAt).toBeLessThanOrEqual(third.startedAt)
      const history = db.prepare('SELECT run_id, data FROM messages WHERE session_id = ? ORDER BY seq').all(session.id)
        .map(row => ({ runId: row.run_id, entry: JSON.parse(String(row.data)) as ConversationMessage }))
      expect(history.filter(({ entry }) => entry.clientMessageId === steerId)).toEqual([{
        runId: first.id, entry: expect.objectContaining({ steering: true, message: expect.objectContaining({ role: 'user', content: steering }) }),
      }])
      expect(batch.runId).toBe(first.id)
      const source = history.find(({ entry }) => entry.id === batch.assistantMessageId)?.entry.message
      expect(source?.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'ask_user_question', id: batch.toolCallId }))
      const results = history.filter(({ entry: { message } }) => message.role === 'toolResult' && message.toolCallId === batch.toolCallId)
      expect(results).toEqual([{
        runId: first.id, entry: expect.objectContaining({
          toolCall: expect.objectContaining({ assistantMessageId: batch.assistantMessageId }),
          message: expect.objectContaining({ role: 'toolResult', toolName: 'ask_user_question', isError: false }),
        }),
      }])
      const result = results[0]!.entry.message
      if (result.role !== 'toolResult' || result.content[0]?.type !== 'text') throw new Error('没有保存反问结果')
      expect(JSON.parse(result.content[0].text)).toMatchObject({ answers })
      await testInfo.attach('feature10-live-evidence', {
        contentType: 'application/json',
        body: JSON.stringify({ model: first.modelId, runs: runs.map(({ id, status }) => ({ id, status })),
          toolCallId: batch.toolCallId, answers, matchingFiles: ['decision.txt', 'first.txt', 'second.txt'] }),
      })
    } finally { db.close() }
  } finally {
    await Promise.allSettled([context.clearCookies(), server.close()])
    await rm(temporary, { recursive: true, force: true })
  }
})
