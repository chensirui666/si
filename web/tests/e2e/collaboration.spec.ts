import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, ready, saveKey, seedSession, startBackend, stop } from './test-utils'

const editor = (page: Page) => page.getByRole('textbox', { name: '消息', exact: true })
const send = (page: Page) => page.getByRole('button', { name: '发送', exact: true })
const queue = (page: Page) => page.getByRole('region', { name: '待发送消息' })
const answers = (page: Page) => page.getByRole('region', { name: '回答问题' })
const questionReview = (page: Page) => page.getByRole('region', { name: '查看问题' })
const history = (page: Page) => page.getByRole('region', { name: '消息列表' })
const questionRecord = (page: Page, toolCallId: string) => history(page).locator(`[data-question-batch][data-tool-call-id="${toolCallId}"]`).getByRole('button')
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC', 'base64')

type TestServer = Awaited<ReturnType<typeof startBackend>>
type ServerControls = { restart(): Promise<void>; tick(ms: number): Promise<void> }

async function controlled(page: Page, run: (provider: Awaited<ReturnType<typeof startModelServer>>, observed: ReturnType<typeof observe>, directory: string, controls: ServerControls) => Promise<void>, clock = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-collaboration-'))
  const provider = await startModelServer()
  const secret = join(directory, 'browser-auth.json')
  let backend: TestServer | undefined
  try {
    backend = await startBackend(secret, 0, provider.baseURL, undefined, clock)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, 'controlled-stage3-key')
    await run(provider, observed, directory, {
      async restart() {
        const port = Number(new URL(backend!.result.url).port)
        await stop(backend!.child)
        backend = await startBackend(secret, port, provider.baseURL, undefined, clock)
        const beforeReload = observed.snapshots.length
        await page.reload()
        await ready(page, observed, beforeReload, false)
      },
      async tick(ms) {
        const child = backend!.child
        const advanced = once(child, 'message')
        child.send({ type: 'advanceModelClock', ms })
        expect((await advanced)[0]).toEqual({ type: 'modelClockAdvanced' })
      },
    })
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
}

function tool(index: number, id: string, name: string, args: object) {
  return { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('保留原编号编辑队列，带图转为插话，模型收完本步后按序继续', async ({ page }) => {
  await controlled(page, async (provider, observed, directory, server) => {
    await writeFile(join(directory, 'note.txt'), '已完成的读取')
    await editor(page).fill('第一轮任务')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(1)

    const stopRun = page.getByRole('button', { name: '中止', exact: true })
    await expect(stopRun).toBeEnabled()
    await expect(send(page)).toHaveCount(0)
    await editor(page).fill('原说明')
    await expect(stopRun).toHaveCount(0)
    await expect(page.getByRole('button', { name: '插话', exact: true })).toHaveCount(0)
    const originalRequest = page.waitForRequest(req => new URL(req.url()).pathname === '/api/messages')
    await send(page).click()
    const submitted = (await originalRequest).postDataJSON()
    const originalId = await queue(page).getByRole('listitem').filter({ hasText: '原说明' }).getAttribute('data-queue-id')
    await expect(stopRun).toBeEnabled()
    await expect(send(page)).toHaveCount(0)
    await expect.poll(async () => {
      const [dock, composer] = await Promise.all([queue(page).boundingBox(), page.locator('.message-input').boundingBox()])
      return dock && composer ? dock.y + dock.height - composer.y : 0
    }).toBeGreaterThan(0)
    const originalRow = queue(page).locator(`[data-queue-id="${originalId}"]`)
    await originalRow.getByRole('button', { name: '编辑待发消息' }).click()
    await originalRow.getByRole('textbox').fill('临时说明')
    await originalRow.getByRole('button', { name: '取消', exact: true }).click()
    await expect(originalRow).toContainText('原说明')
    await originalRow.getByRole('button', { name: '编辑待发消息' }).click()
    await originalRow.getByRole('textbox').fill('第一行说明\n第二行说明')
    await originalRow.getByRole('button', { name: '保存', exact: true }).click()
    await expect(originalRow.locator('.queue-text')).toHaveAttribute('title', '第一行说明\n第二行说明')
    await expect(originalRow.getByRole('button')).toHaveCount(3)
    const retry = await page.request.post(new URL('/api/messages', page.url()).href, { data: submitted })
    expect(await retry.json()).toMatchObject({ kind: 'queued', clientMessageId: originalId })
    await expect(queue(page).getByRole('listitem')).toHaveCount(1)
    await expect(originalRow.locator('.queue-text')).toHaveAttribute('title', '第一行说明\n第二行说明')

    await page.locator('input[type=file]').setInputFiles({ name: 'queue.png', mimeType: 'image/png', buffer: image })
    await editor(page).fill('这个呢')
    await send(page).click()
    const picture = queue(page).getByRole('listitem').filter({ hasText: '[image] 这个呢' })
    await expect(picture.getByRole('button', { name: '编辑待发消息' })).toBeDisabled()
    const pictureId = await picture.getAttribute('data-queue-id')
    await expect(editor(page)).toHaveText('')
    await page.locator('input[type=file]').setInputFiles({ name: 'image-only.png', mimeType: 'image/png', buffer: image })
    await send(page).click()
    const imageOnly = queue(page).getByRole('listitem').filter({ has: page.getByText('[image]', { exact: true }) })
    await expect(imageOnly.getByRole('button', { name: '编辑待发消息' })).toBeDisabled()
    await imageOnly.getByRole('button', { name: '删除待发消息' }).click()
    await expect(queue(page).getByRole('listitem')).toHaveCount(2)
    const beforeReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeReload, false)
    await expect(queue(page).getByRole('listitem').first()).toHaveAttribute('data-queue-id', originalId!)
    await expect(picture).toHaveAttribute('data-queue-id', pictureId!)
    await picture.getByRole('button', { name: '转为插话' }).click()
    await expect(queue(page).getByRole('listitem')).toHaveCount(1)
    const pendingPicture = history(page).getByRole('listitem').filter({ hasText: '这个呢' })
    await expect(pendingPicture.getByRole('status')).toHaveAttribute('title', '等待交给模型')
    await expect(pendingPicture.getByRole('status')).toHaveText('等待交给模型')
    await expect.poll(() => pendingPicture.getByAltText('queue.png').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)

    provider.exchanges[0]!.delta({ tool_calls: [
      tool(0, 'read-first', 'read', { path: 'note.txt' }),
      tool(1, 'bash-second', 'bash', {
        command: 'printf started > second.started; while [ ! -f second.release ]; do sleep 0.05; done; printf "第二项完成"',
        timeout: 20,
      }),
    ] })
    provider.exchanges[0]!.finish('tool_calls')
    await expect.poll(() => readFile(join(directory, 'second.started'), 'utf8').catch(() => '')).toBe('started')
    let unhold!: () => void
    const held = new Promise<void>(resolve => { unhold = resolve })
    await page.route('**/api/messages', async route => {
      if (route.request().postDataJSON().mode === 'steer') await held
      await route.continue()
    })
    const direct = history(page).getByRole('listitem').filter({ hasText: '保留旧接口' })
    const directImage = direct.getByAltText('direct.png')
    try {
      await page.locator('input[type=file]').setInputFiles({ name: 'direct.png', mimeType: 'image/png', buffer: image })
      await editor(page).fill('保留旧接口')
      await expect(send(page)).toBeEnabled()
      await editor(page).press('Control+Enter')
      await expect(direct.getByRole('status')).toContainText('正在提交')
      await expect.poll(() => directImage.evaluate((element: HTMLImageElement) => element.naturalWidth), { timeout: 3000 }).toBe(1)
    } finally { unhold() }
    await expect.poll(() => directImage.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1)
    await expect(history(page).getByRole('listitem').filter({ hasText: '保留旧接口' })).toContainText('等待交给模型')
    expect(provider.exchanges).toHaveLength(1)

    await writeFile(join(directory, 'second.release'), '')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const messages = provider.exchanges[1]!.body.messages.slice(-4)
    expect(messages[0]).toMatchObject({ role: 'tool', content: expect.stringContaining('已完成的读取') })
    expect(messages[1]).toMatchObject({ role: 'tool', content: expect.stringContaining('第二项完成') })
    expect(JSON.stringify(messages[2])).toContain('data:image/png;base64,')
    expect(JSON.stringify(messages[2])).toContain('这个呢')
    expect(messages[3]).toMatchObject({ role: 'user', content: expect.arrayContaining([
      { type: 'text', text: expect.stringMatching(/^保留旧接口\n/u) },
      { type: 'image_url', image_url: { url: expect.stringContaining('data:image/png;base64,') } },
    ]) })
    await expect(history(page).getByText('等待交给模型', { exact: true })).toHaveCount(0)
    await expect(history(page).getByText('保留旧接口', { exact: true })).toHaveCount(1)
    provider.exchanges[1]!.delta({ content: '第一轮已完成' })
    provider.exchanges[1]!.finish()

    await expect.poll(() => provider.exchanges.length).toBe(3)
    expect(provider.exchanges[2]!.body.messages.at(-1)).toMatchObject({ role: 'user', content: '第一行说明\n第二行说明' })
    provider.exchanges[2]!.delta({ content: '第二轮已完成' })
    provider.exchanges[2]!.finish()
    await expect(queue(page)).toHaveCount(0)
    await expect(history(page).getByText('第二轮已完成', { exact: true })).toBeVisible()
    await server.restart()
    await expect(history(page).getByText('保留旧接口', { exact: true })).toHaveCount(1)
    await expect(history(page).getByText('等待交给模型', { exact: true })).toHaveCount(0)
    const messagesAfterRestart = observed.snapshots.at(-1)!.snapshot.messages
    const runId = messagesAfterRestart.find(item => item.message.role === 'user' && item.message.content === '第一轮任务')?.id
    expect(messagesAfterRestart.find(item => item.message.role === 'user' && item.message.content === '保留旧接口')).toMatchObject({ runId, steering: true })
    expect(messagesAfterRestart.filter(item => item.message.role === 'toolResult').map(item => item.toolCall?.contentIndex)).toEqual([0, 1])
  })
})

test('原位提问按钮直接打开回答或只读查看，保留草稿、工具顺序和补答', async ({ page }) => {
  await controlled(page, async (provider, observed, directory, server) => {
    await writeFile(join(directory, 'before.txt'), '提问前读取')
    await writeFile(join(directory, 'after.txt'), '提问后读取')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const setting = page.getByRole('combobox', { name: '提问等待方式' })
    await expect(setting).toHaveText('等待 120 秒后继续')
    await setting.click()
    await page.getByRole('option', { name: '一直等待回复' }).click()
    await expect(setting).toHaveText('一直等待回复')
    await page.keyboard.press('Escape')

    await editor(page).fill('处理两个文件')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    await editor(page).fill('保留普通草稿')
    provider.exchanges[0]!.delta({ tool_calls: [
      tool(0, 'before', 'read', { path: 'before.txt' }),
      tool(1, 'ask-first', 'ask_user_question', { timeout: 60, questions: [
        { id: 'single', header: '下一步', question: '选择一种方式', options: [{ label: '方式 A' }, { label: '方式 B' }] },
        { id: 'multiple', question: '有哪些范围', multi_select: true, options: [{ label: '范围 A' }, { label: '范围 C' }] },
        { id: 'custom', question: '还有补充吗？', options: [{ label: '没有补充' }] },
      ] }),
      tool(2, 'after', 'read', { path: 'after.txt' }),
    ] })
    provider.exchanges[0]!.finish('tool_calls')
    const panel = answers(page)
    const firstQuestion = questionRecord(page, 'ask-first')
    const timeline = history(page)
    await expect(panel).toBeVisible()
    const deadline = await panel.locator('time').getAttribute('datetime')
    await expect(timeline.locator('[data-question-batch]')).toHaveCount(1)
    await expect(firstQuestion).toHaveText('3 Questions')
    await expect(firstQuestion).toHaveAccessibleName(/3 Questions.*等待回答/)
    await expect(timeline).not.toContainText('选择一种方式')
    await panel.getByRole('button', { name: '收起', exact: true }).click()
    await expect(panel).toBeHidden()
    await expect(editor(page)).toBeVisible()
    await expect(editor(page)).toHaveText('保留普通草稿')
    await firstQuestion.click()
    await expect(panel.getByText('选择一种方式', { exact: false })).toBeVisible()
    await expect(panel.locator('time')).toHaveAttribute('datetime', deadline!)
    const beforeReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeReload, false)
    let answerPosts = 0
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/reply')) answerPosts++
    })
    const progress = (value: string) => panel.getByText(value, { exact: true })
    const next = panel.getByRole('button', { name: '下一题', exact: true })
    const submit = panel.getByRole('button', { name: '提交', exact: true })
    const custom = panel.getByRole('textbox', { name: '补充回答' })
    await expect(panel.locator('time')).toHaveAttribute('datetime', deadline!)
    await expect(panel.getByText('下一步', { exact: true })).toBeVisible()
    await expect(progress('1/3')).toBeVisible()
    await expect(next).toBeDisabled()
    await expect(submit).toHaveCount(0)
    await panel.getByRole('radio', { name: '方式 A' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(panel.getByRole('radio', { name: '方式 B' })).toBeChecked()
    await expect(progress('1/3')).toBeVisible()
    await panel.getByText('方式 B', { exact: true }).click()
    await expect(progress('2/3')).toBeVisible()
    await panel.getByText('范围 A', { exact: true }).click()
    await expect(progress('2/3')).toBeVisible()
    await panel.getByText('范围 C', { exact: true }).click()
    await custom.fill('同时保留现有入口')
    await custom.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await expect(progress('2/3')).toBeVisible()
    await custom.press('Enter')
    await expect(progress('3/3')).toBeVisible()
    await expect(next).toHaveCount(0)
    await expect(submit).toBeDisabled()
    await custom.fill('暂时的草稿')
    await custom.press('Enter')
    await panel.getByText('没有补充', { exact: true }).click()
    await expect(submit).toBeEnabled()
    await expect(panel.getByRole('radio', { name: '没有补充' })).toBeChecked()
    await panel.getByRole('button', { name: '上一题' }).focus()
    await page.keyboard.press('Enter')
    await expect(panel.locator('legend')).toBeFocused()
    await expect(panel.getByRole('checkbox', { name: '范围 C' })).toBeChecked()
    await expect(custom).toHaveValue('同时保留现有入口')
    await next.click()
    await expect(panel.getByRole('radio', { name: '没有补充' })).toBeChecked()
    expect(answerPosts).toBe(0)
    expect(provider.exchanges).toHaveLength(1)
    await submit.click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(answerPosts).toBe(1)
    const results = provider.exchanges[1]!.body.messages.filter(message => message.role === 'tool')
    expect(results).toHaveLength(3)
    expect(results[0]!.content).toContain('提问前读取')
    expect(results[1]!.content).toContain('方式 B')
    expect(results[1]!.content).toContain('同时保留现有入口')
    expect(results[2]!.content).toContain('提问后读取')
    await expect(editor(page)).toHaveText('保留普通草稿')
    await expect(firstQuestion).toHaveAccessibleName(/3 Questions.*已回答/)
    await expect(timeline.getByText('读取 · before.txt', { exact: true })
      .or(firstQuestion)
      .or(timeline.getByText('读取 · after.txt', { exact: true })))
      .toHaveText(['读取 · before.txt', '3 Questions', '读取 · after.txt'])
    await expect(timeline.getByText('ask_user_question', { exact: true })).toHaveCount(0)
    await firstQuestion.click()
    const review = questionReview(page)
    const reviewNext = review.getByRole('button', { name: '向后翻题', exact: true })
    await expect(review).toBeVisible()
    await expect(panel).toBeHidden()
    await expect(review).toContainText('选择一种方式')
    const savedChoice = review.getByRole('radio', { name: '方式 B' })
    await expect(savedChoice).toBeChecked()
    await expect(savedChoice).toBeDisabled()
    await reviewNext.click()
    await expect(review).toContainText('有哪些范围')
    await expect(review.getByRole('checkbox', { name: '范围 A' })).toBeChecked()
    await expect(review.getByRole('checkbox', { name: '范围 C' })).toBeChecked()
    await expect(review).toContainText('同时保留现有入口')
    await reviewNext.click()
    await expect(review).toContainText('还有补充吗？')
    await expect(review.getByRole('button', { name: /^(下一题|提交|跳过本题)$/ })).toHaveCount(0)
    await review.getByRole('button', { name: '收起', exact: true }).click()
    await expect(review).toBeHidden()
    await expect(editor(page)).toHaveText('保留普通草稿')
    expect(answerPosts).toBe(1)

    provider.exchanges[1]!.delta({ tool_calls: [tool(0, 'ask-later', 'ask_user_question', { timeout: 30, questions: [
      { id: 'one', question: '保留旧行为吗？' }, { id: 'two', question: '还有限制吗？' },
    ] })] })
    provider.exchanges[1]!.finish('tool_calls')
    await expect(panel.getByText('保留旧行为吗？', { exact: true })).toBeVisible()
    await expect(custom).toHaveValue('')
    await expect(timeline.locator('[data-question-batch]')).toHaveCount(2)
    await server.tick(30_000)
    await expect.poll(() => provider.exchanges.length).toBe(3)
    const result = provider.exchanges[2]!.body.messages.filter(message => message.role === 'tool').at(-1)
    expect(result?.content).toContain('"pending":true')
    await expect(panel).toBeHidden()
    await expect(editor(page)).toBeVisible()
    await expect(editor(page)).toHaveText('保留普通草稿')
    provider.exchanges[2]!.delta({ content: '超时后已经继续' })
    provider.exchanges[2]!.finish()
    const secondQuestion = questionRecord(page, 'ask-later')
    await expect(secondQuestion).toHaveText('2 Questions')
    await expect(secondQuestion).toHaveAccessibleName(/2 Questions.*超时未答/)
    await expect(timeline).not.toContainText('保留旧行为吗？')
    await secondQuestion.click()
    await expect(panel.getByText('保留旧行为吗？', { exact: true })).toBeVisible()
    await expect(custom).toHaveValue('')
    await expect(panel).not.toContainText('同时保留现有入口')
    await panel.getByRole('button', { name: '跳过本题' }).click()
    await expect(submit).toBeDisabled()
    await panel.getByRole('button', { name: '跳过本题' }).click()
    expect(answerPosts).toBe(1)
    await submit.click()
    await expect(secondQuestion).toHaveAccessibleName(/2 Questions.*已关闭/)
    await expect(firstQuestion).toHaveAccessibleName(/3 Questions.*已回答/)
    await secondQuestion.click()
    await expect(review).toContainText('保留旧行为吗？')
    await expect(review.getByRole('button', { name: '提交', exact: true })).toHaveCount(0)
    await review.getByRole('button', { name: '收起', exact: true }).click()
    await expect(editor(page)).toHaveText('保留普通草稿')
    expect(provider.exchanges).toHaveLength(3)
  }, true)
})

test('通用等待设置重启后生效，超时问题中止及重启后仍可补答', async ({ page }) => {
  await controlled(page, async (provider, observed, directory, server) => {
    const settings = page.getByRole('button', { name: '设置', exact: true })
    const wait = page.getByRole('combobox', { name: '提问等待方式' })
    const chooseWait = async (label: string) => {
      await wait.click()
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect(wait).toHaveText(label)
    }
    await settings.click()
    await expect(wait).toHaveText('等待 120 秒后继续')
    await chooseWait('一直等待回复')
    expect(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).questionWaitTimeout).toBe(-1)
    await page.keyboard.press('Escape')
    await server.restart()
    await settings.click()
    await expect(wait).toHaveText('一直等待回复')
    await page.keyboard.press('Escape')

    await editor(page).fill('确认接口兼容性')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ tool_calls: [tool(0, 'unlimited', 'ask_user_question', {
      questions: [{ id: 'interface', question: '保留哪个接口？' }],
    })] })
    provider.exchanges[0]!.finish('tool_calls')
    const panel = answers(page)
    const custom = panel.getByRole('textbox', { name: '补充回答' })
    const submit = panel.getByRole('button', { name: '提交', exact: true })
    await expect(custom).toBeVisible()
    await expect(panel.locator('time')).toHaveCount(0)
    await settings.click()
    await chooseWait('等待 120 秒后继续')
    await page.keyboard.press('Escape')
    await server.tick(121_000)
    await expect(custom).toBeVisible()
    expect(provider.exchanges).toHaveLength(1)
    await custom.fill('保留只读查询接口')
    await submit.click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]!.body.messages.at(-1)?.content).toContain('保留只读查询接口')

    provider.exchanges[1]!.delta({ tool_calls: [tool(0, 'default-timeout', 'ask_user_question', {
      questions: [
        { id: 'branch', question: '在哪个分支工作？' },
        { id: 'version', question: '目标版本？', multi_select: true, options: [{ label: 'v1' }, { label: 'v2' }] },
        { id: 'constraints', question: '还有别的限制吗？' },
      ],
    })] })
    provider.exchanges[1]!.finish('tool_calls')
    await expect(panel.locator('time')).toBeVisible()
    await server.tick(120_000)
    await expect.poll(() => provider.exchanges.length).toBe(3)
    expect(provider.exchanges[2]!.body.messages.at(-1)?.content).toContain('"pending":true')
    const timedOut = questionRecord(page, 'default-timeout')
    await expect(timedOut).toHaveAccessibleName(/3 Questions.*超时未答/)
    await timedOut.click()
    await panel.getByRole('button', { name: '中止', exact: true }).click({ timeout: 2000 })
    await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
    await expect(timedOut).toHaveAccessibleName(/3 Questions.*超时未答/)

    await server.restart()
    const pendingBatch = observed.snapshots.at(-1)!.snapshot.interaction!.questions.find(batch => batch.toolCallId === 'default-timeout')!
    const batchURL = `/api/sessions/${observed.snapshots.at(-1)!.sessionId}/questions/${pendingBatch.id}/reply`
    await expect(editor(page)).toBeVisible()
    await timedOut.click()
    await custom.fill('release')
    await panel.getByRole('button', { name: '收起', exact: true }).click()
    await timedOut.click()
    await expect(custom).toHaveValue('release')
    await panel.getByRole('button', { name: '下一题' }).click()
    await panel.getByText('v2', { exact: true }).click()
    await custom.fill('兼容旧接口')
    await expect(submit).toHaveCount(0)
    expect(provider.exchanges).toHaveLength(3)
    await panel.getByRole('button', { name: '下一题' }).click()
    await panel.getByRole('button', { name: '跳过本题' }).click()
    const request = page.waitForRequest(req => new URL(req.url()).pathname === batchURL)
    await submit.click()
    const originalReply = (await request).postDataJSON()
    await expect.poll(() => provider.exchanges.length).toBe(4)
    const lastRequest = provider.exchanges[3]!.body.messages
    expect(lastRequest.filter(message => message.role === 'tool').at(-1)?.content).toContain('"pending":true')
    expect(lastRequest.at(-1)?.role).toBe('user')
    expect(JSON.parse(lastRequest.at(-1)?.content as string)).toMatchObject({
      callId: 'default-timeout', questions: pendingBatch.questions,
      answers: [{ id: 'branch', selected: [], custom: 'release' }, { id: 'version', selected: ['v2'], custom: '兼容旧接口' }, { id: 'constraints', selected: [] }],
    })
    expect(await (await page.request.post(new URL(batchURL, page.url()).href, { data: originalReply })).json()).toMatchObject({ kind: 'late' })
    expect(provider.exchanges).toHaveLength(4)
    provider.exchanges[3]!.delta({ content: '已记录答案' })
    provider.exchanges[3]!.finish()
    await expect(timedOut).toHaveText('3 Questions')
    await expect(timedOut).toHaveAccessibleName(/3 Questions.*已补答/)
    const replyBubble = history(page).locator(`[data-question-reply="${pendingBatch.id}"]`)
    await expect(replyBubble).toHaveCount(1)
    await expect(replyBubble).toBeVisible()
    await expect(replyBubble.locator('dt')).toHaveText(['在哪个分支工作？', '目标版本？', '还有别的限制吗？'])
    const displayedAnswers = ['release', 'v2 · 兼容旧接口', '已跳过']
    await expect(replyBubble.locator('dt + dd')).toHaveText(displayedAnswers)
    await page.reload()
    await expect(replyBubble).toHaveCount(1)
    await expect(replyBubble.locator('dt + dd')).toHaveText(displayedAnswers)
    await timedOut.click()
    const review = questionReview(page)
    await expect(review).toContainText('在哪个分支工作？')
    await expect(review.getByRole('button', { name: '提交', exact: true })).toHaveCount(0)
    await expect(panel).toBeHidden()
  }, true)
})

test('中止关闭仍在等待的问题，保留提问前已经写入的文件', async ({ page }) => {
  await controlled(page, async (provider, observed, directory) => {
    await editor(page).fill('写入两个文件，中间先向我确认')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ tool_calls: [
      tool(0, 'write-first', 'write', { path: 'before.txt', content: '已保存' }),
      tool(1, 'cancel-question', 'ask_user_question', { questions: [{ id: 'continue', question: '继续写入吗？' }] }),
      tool(2, 'write-second', 'write', { path: 'after.txt', content: '不应写入' }),
    ] })
    provider.exchanges[0]!.finish('tool_calls')
    const panel = answers(page)
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: '中止', exact: true }).click()
    await expect(panel).toHaveCount(0)
    const record = questionRecord(page, 'cancel-question')
    await expect(record).toHaveText('1 Question')
    await expect(record).toHaveAccessibleName(/1 Question.*已中止/)
    expect(await readFile(join(directory, 'before.txt'), 'utf8')).toBe('已保存')
    await expect(readFile(join(directory, 'after.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(provider.exchanges).toHaveLength(1)
    const beforeReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeReload, false)
    await expect(record).toHaveAccessibleName(/1 Question.*已中止/)
    await expect(history(page)).not.toContainText('继续写入吗？')
    await record.click()
    const review = questionReview(page)
    await expect(review).toContainText('继续写入吗？')
    await expect(review.getByRole('button', { name: /^(提交|跳过本题)$/ })).toHaveCount(0)
    await review.getByRole('button', { name: '收起', exact: true }).click()
    await expect(review).toBeHidden()
    const frame = observed.snapshots.at(-1)!
    const batch = frame.snapshot.interaction!.questions.find(batch => batch.toolCallId === 'cancel-question')!
    const reply = await page.request.post(new URL(`/api/sessions/${frame.sessionId}/questions/${batch.id}/reply`, page.url()).href, {
      data: { replyId: 'closed-answer', answers: [{ id: 'continue', selected: [], custom: '继续' }] },
    })
    expect(reply.ok()).toBe(false)
  })
})

test('中止后重开保留插话和队列，新发送按原顺序恢复', async ({ page }) => {
  await controlled(page, async (provider, observed) => {
    await editor(page).fill('先启动任务')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    for (const text of ['插话一', '插话二']) {
      await editor(page).fill(text)
      await editor(page).press('Control+Enter')
      await expect(history(page).getByRole('listitem').filter({ hasText: text })).toContainText('等待交给模型')
    }
    for (const text of ['队列一', '队列二']) {
      await editor(page).fill(text)
      await editor(page).press('Enter')
      await expect(queue(page).getByText(text, { exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: '中止', exact: true }).click()
    await expect(queue(page)).toContainText('队列已暂停')
    await expect(history(page).getByText('等待交给模型', { exact: true })).toHaveCount(2)
    await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
    const beforeReload = observed.snapshots.length
    await page.reload()
    await ready(page, observed, beforeReload, false)
    await expect(queue(page)).toContainText('队列已暂停')
    await expect(history(page).getByText('等待交给模型', { exact: true })).toHaveCount(2)
    expect(provider.exchanges).toHaveLength(1)

    await editor(page).fill('队列三')
    await send(page).click()
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]!.body.messages.filter(message => message.role === 'user').slice(-3).map(message => message.content))
      .toEqual(['插话一', '插话二', '队列一'])
    await expect(history(page).locator('.message-text')).toHaveText(['先启动任务', '插话一', '插话二', '队列一'])
    await expect(history(page).getByText('等待交给模型', { exact: true })).toHaveCount(0)
    for (const [index, text] of ['队列一', '队列二', '队列三'].entries()) {
      await expect.poll(() => provider.exchanges.length).toBe(index + 2)
      const exchange = provider.exchanges[index + 1]!
      expect(exchange.body.messages.at(-1)?.content).toBe(text)
      exchange.delta({ content: text + '已完成' })
      exchange.finish()
    }
    await expect(queue(page)).toHaveCount(0)
    await expect(history(page).locator('.message-text')).toHaveText(['先启动任务', '插话一', '插话二', '队列一', '队列二', '队列三'])
  })
})
