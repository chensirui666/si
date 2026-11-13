import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, ready, saveKey, startBackend, stop } from './test-utils'

for (const replaced of [true, false]) test(`Read after restart uses the original path (${replaced ? 'replaced file' : 'missing file'})`, async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-read-image-'))
  const secret = join(directory, 'browser-auth.json')
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC'
  const replacement = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC'
  const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }
  try {
    await writeFile(join(directory, 'shot.png'), Buffer.from(png, 'base64'))
    await writeFile(join(directory, 'note.txt'), '一段文本')
    const path = await realpath(join(directory, 'shot.png'))
    backend = await startBackend(secret, 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const editor = page.getByRole('textbox', { name: '消息', exact: true })
    const send = page.getByRole('button', { name: '发送', exact: true })
    await editor.fill('读取 shot.png 和 note.txt')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ tool_calls: ['shot.png', 'note.txt'].map((path, index) => ({
      index, id: `read-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) },
    })) })
    provider.exchanges[0]!.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]!.body.messages.slice(-3)).toMatchObject([
      { role: 'tool', tool_call_id: 'read-0', content: expect.stringContaining(path) },
      { role: 'tool', tool_call_id: 'read-1', content: '一段文本' },
      { role: 'user', content: expect.arrayContaining([image]) },
    ])
    provider.exchanges[1]!.delta({ content: '图片和文本已收到' })
    provider.exchanges[1]!.finish()
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')

    const expectToolPath = async () => {
      await page.locator('.process-group > summary').click()
      const card = page.locator('.tool-block').filter({ hasText: 'shot.png' })
      await card.locator('summary').click()
      await expect(card.locator('.tool-result')).toContainText(path)
      await expect(card.locator('img')).toHaveCount(0)
    }
    await expectToolPath()
    expect(JSON.stringify(observed.updates)).not.toContain(png)

    await editor.fill('刚才读到了什么？')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(3)
    expect(provider.exchanges[2]!.body.messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: expect.arrayContaining([image]) }),
    )
    provider.exchanges[2]!.delta({ content: '同一会话还能看到原图' })
    provider.exchanges[2]!.finish()
    await expect(page.getByText('同一会话还能看到原图', { exact: true })).toBeVisible()
    await expect(send).toBeDisabled()
    await expect.poll(() => observed.updates.at(-1)?.update.run?.status).toBe('completed')

    if (replaced) await writeFile(path, Buffer.from(replacement, 'base64'))
    else await rm(path)
    const port = Number(new URL(backend.result.url).port)
    await stop(backend.child)
    backend = await startBackend(secret, port, provider.baseURL)
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    await expectToolPath()
    await expect(page.getByText('图片和文本已收到', { exact: true })).toBeVisible()
    expect(JSON.stringify(observed.snapshots.at(-1))).not.toContain(png)
    await editor.fill('继续讨论刚才的图')
    await send.click()
    await expect.poll(() => provider.exchanges.length).toBe(4)
    const resumed = provider.exchanges[3]!
    expect(resumed.body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'read-0',
      content: expect.stringContaining(`${path}\n[历史图片未随会话保存。需要看图时可按原路径重新调用 read。]`),
    }))
    expect(JSON.stringify(resumed.body.messages)).not.toContain('data:image/')
    resumed.delta({ tool_calls: [{ index: 0, id: 'read-again', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path }) } }] })
    resumed.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(5)
    const reread = provider.exchanges[4]!
    if (replaced) {
      expect(reread.body.messages.slice(-2)).toMatchObject([
        { role: 'tool', tool_call_id: 'read-again', content: expect.stringContaining(path) },
        { role: 'user', content: expect.arrayContaining([{ type: 'image_url', image_url: { url: `data:image/png;base64,${replacement}` } }]) },
      ])
    } else {
      expect(reread.body.messages.at(-1)).toMatchObject({
        role: 'tool', tool_call_id: 'read-again', content: expect.stringContaining('ENOENT'),
      })
      expect(JSON.stringify(reread.body.messages)).not.toContain('data:image/')
    }
    reread.delta({ content: '重读完成' })
    reread.finish()
    await expect(page.getByText('重读完成', { exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled([stop(backend?.child), provider.close()])
    await rm(directory, { recursive: true, force: true })
  }
})
