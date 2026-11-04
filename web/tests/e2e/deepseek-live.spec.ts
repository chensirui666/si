import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { parseLiveKey, readLiveKey } from './live-key'
import { authorize, observe, ready, saveKey, startBackend, stop } from './test-utils'

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test('真实模型凭据文件解析只接收明确的 DeepSeek 变量', () => {
  expect(parseLiveKey('OTHER=ignore\nDEEPSEEK=example-key\n')).toBe('example-key')
  expect(parseLiveKey('export DEEPSEEK_API_KEY="replacement-key" # local\n')).toBe('replacement-key')
  expect(parseLiveKey("DEEPSEEK='quoted-key'\n")).toBe('quoted-key')
  expect(() => parseLiveKey('OTHER=ignore\n')).toThrow('需要非空')
  expect(() => parseLiveKey('DEEPSEEK=""\n')).toThrow('需要非空')
})

test('真实 DeepSeek 设置、两轮历史、流式进度与无效 Key 恢复', async ({ page, context }) => {
  test.setTimeout(600_000)
  const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
  test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE；默认测试不读取真实用户凭据')
  let key = await readLiveKey(keyFile!)
  const temporary = await mkdtemp(join(tmpdir(), 'agent-learning-deepseek-live-'))
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    backend = await startBackend(join(temporary, 'browser-auth.json'))
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await ready(page, observed)
    await saveKey(page, key)
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === key).toBe(true)
    expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} })

    const code = `memo-${randomUUID().slice(0, 8)}`
    const first = await complete(page, observed, `请记住口令 ${code}。只回答“记住了”，不要复述口令。`)
    expect(first.message.stopReason).toBe('stop')
    expect(first.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText('记住了')
    const second = await complete(page, observed, '上一条我告诉你的口令是什么？只回答口令。')
    expect(textOf(second.message)).toContain(code)
    expect(second.sawTextBeforeTerminal).toBe(true)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText(code)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem')).toHaveCount(4)

    await saveKey(page, 'invalid-stage3-live-key')
    expect(JSON.parse(await readFile(join(temporary, 'auth.json'), 'utf8')).deepseek.key === 'invalid-stage3-live-key').toBe(true)
    const failed = await complete(page, observed, '只回答“验证无效凭据”。', true)
    expect(failed.message.stopReason).toBe('error')
    expect(Boolean(failed.message.errorMessage)).toBe(true)
    const failureText = await page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last().innerText()
    expect(/失败|错误|无效|认证|401|authentication/i.test(failureText)).toBe(true)
    await saveKey(page, key)
    const recovered = await complete(page, observed, '只回答“恢复成功”。')
    expect(textOf(recovered.message)).toContain('恢复成功')
    expect(recovered.message.stopReason).toBe('stop')
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toContainText('恢复成功')
    expect(observed.submissions).toEqual(['POST', 'POST', 'POST', 'POST'])
    expect(observed.updates.filter(({ update }) => update.change.type === 'accepted')).toHaveLength(4)
  } finally {
    key = ''
    await Promise.allSettled([context.clearCookies(), stop(backend?.child)])
    await rm(temporary, { recursive: true, force: true })
  }
})

async function complete(page: Page, observed: ReturnType<typeof observe>, prompt: string, expectFailure = false) {
  const before = observed.updates.length
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  await editor.fill(prompt)
  const send = page.getByRole('button', { name: '发送', exact: true })
  await expect(send).toBeEnabled()
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
  await send.click()
  expect((await accepted).status()).toBe(202)
  await expect(editor).toHaveText('')
  await expect.poll(() => observed.updates.slice(before).some(({ update }) => update.change.type === 'model' && ['done', 'error'].includes(update.change.event.type)), { timeout: 150_000 }).toBe(true)
  const frames = observed.updates.slice(before).flatMap(({ update }) => update.change.type === 'model' ? [update.change.event] : [])
  const terminal = frames.find(frame => frame.type === 'done' || frame.type === 'error')!
  if (terminal.type !== 'done' && terminal.type !== 'error') throw new Error('没有收到最终模型回复')
  expect(terminal.type).toBe(expectFailure ? 'error' : 'done')
  const message = terminal.type === 'done' ? terminal.message : terminal.error
  const text = textOf(message)
  if (!expectFailure) {
    expect(text.length).toBeGreaterThan(0)
    await expect(page.getByRole('region', { name: '消息列表' }).getByRole('listitem').last()).toBeVisible()
  }
  await editor.fill('下一轮仍可发送的草稿')
  await expect(send).toBeEnabled()
  const delta = frames.findIndex(frame => frame.type === 'text_delta' && frame.delta.length > 0)
  return { message, sawTextBeforeTerminal: delta >= 0 && delta < frames.indexOf(terminal) }
}

function textOf(message: { content: { type: string; text?: string }[] }) {
  return message.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
}
