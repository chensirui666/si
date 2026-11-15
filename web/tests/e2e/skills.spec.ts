import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WebServer } from '@agent-learning/server'
import type { WorkspacePick, WorkspaceSkills } from '@agent-learning/server/protocol'
import { expect, test } from './chinese-fixture'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, saveKey } from './test-utils'

type Exchange = Awaited<ReturnType<typeof startModelServer>>['exchanges'][number]
function calls(exchange: Exchange, ...operations: { name: string; args: object }[]) {
  exchange.delta({ tool_calls: operations.map(({ name, args }, index) => ({
    index, id: `call-skill-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  })) })
  exchange.finish('tool_calls')
}

const markdown = (name: string, body: string, manual = false) =>
  `---\nname: ${name}\ndescription: 复核交付文件。\n${manual ? 'disable-model-invocation: true\n' : ''}---\n${body}\n`

test('Skill 从正式入口发现、显式与自动加载、重试恢复，以及创建后的刷新', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'si-skill-web-'))
  const cwd = join(root, 'workspace'), home = join(root, 'home'), second = join(root, 'other')
  const skillPath = join(cwd, '.si/skills/review/SKILL.md'), ref = join(dirname(skillPath), 'references/check.txt')
  const automatic = join(cwd, '.si/skills/check/SKILL.md')
  const created = join(cwd, '.si/skills/follow-up/SKILL.md')
  const personal = join(home, '.si/skills/personal/SKILL.md')
  let picked = cwd
  const model = await startModelServer()
  const options = {
    port: 0, directoryPicker: async () => picked, skillHome: home,
    browserSecretPath: join(root, 'browser-auth.json'), modelAuthPath: join(root, 'auth.json'),
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'),
    webSettingsPath: join(root, 'settings.json'), globalContextDirectory: join(root, 'global-context'),
    modelOptions: { baseURL: model.baseURL },
  }
  const server = new WebServer(options)
  let restarted: WebServer | undefined
  const observed = observe(page)
  const editor = page.getByRole('textbox', { name: '消息', exact: true })
  const send = page.getByRole('button', { name: '发送', exact: true })
  const messages = page.locator('.message-list')
  const request = async (index: number) => {
    await expect.poll(() => model.exchanges.length).toBeGreaterThan(index)
    return model.exchanges[index]!
  }
  const submit = async (text: string) => {
    await editor.fill(text)
    await expect(send).toBeEnabled()
    await send.click()
  }
  const complete = async (exchange: Exchange, text: string) => {
    exchange.delta({ content: text })
    exchange.finish()
    await expect(messages).toContainText(text)
    await expect(page.getByRole('button', { name: '中止', exact: true })).toHaveCount(0)
  }
  try {
    await mkdir(dirname(ref), { recursive: true })
    await mkdir(dirname(automatic), { recursive: true })
    await mkdir(second)
    await mkdir(join(cwd, 'docs'))
    await writeFile(join(cwd, 'docs/skills.md'), 'WORKSPACE-DOC-MUST-NOT-LOAD')
    await writeFile(skillPath, markdown('review', 'REVIEW-BODY-A：读取 references/check.txt。', true))
    await writeFile(ref, 'REF-VERIFIED')
    await writeFile(automatic, markdown('check', 'AUTO-SKILL-BODY'))
    const { authUrl, url } = await server.start()
    expect((await fetch(url + '/api/workspaces/unknown/skills')).status).toBe(401)
    await authorize(page, authUrl)
    const workspaceId = await addWorkspace(page)
    await saveKey(page, 'controlled-stage3-key')
    const catalog = async (id: string, base = url): Promise<WorkspaceSkills> => {
      const response = await page.request.get(`${base}/api/workspaces/${id}/skills`)
      expect(response.status()).toBe(200)
      return response.json()
    }
    expect(await (await page.request.get(url + '/api/sessions')).json()).toEqual({ sessions: [] })
    expect((await catalog(workspaceId)).skills).toEqual(expect.arrayContaining([
      ...['skill-creator', 'agents-md', 'grill-me'].map(name => expect.objectContaining({ name, source: 'bundled' })),
      { name: 'review', source: 'project-si', description: '复核交付文件。', disableModelInvocation: true },
    ]))
    expect(JSON.stringify(await catalog(workspaceId))).not.toContain(root)
    const firstPost = page.waitForRequest(req => req.method() === 'POST' && req.url().endsWith('/api/sessions/start'))
    await editor.fill('/')
    await page.getByRole('option', { name: /review/ }).click()
    const prefix = editor.locator('[style*="--skill-prefix-color"]')
    await expect(prefix).toHaveText('/skill:review')
    await expect(prefix).toHaveCSS('color', 'rgb(37, 84, 199)')
    expect(model.exchanges).toHaveLength(0)
    await editor.pressSequentially('核对交付')
    await expect(prefix).toHaveText('/skill:review')
    await send.click()
    const firstInput = (await firstPost).postDataJSON()
    const first = await request(0)
    expect(first.body.messages.at(-1)?.content).toContain('REVIEW-BODY-A')
    expect(first.body.messages.at(-1)?.content).toContain('核对交付')
    expect(first.body.messages.at(-1)?.content).toContain(await realpath(dirname(skillPath)))
    expect(first.body.messages[0].content).toContain('<name>check</name>')
    expect(first.body.messages[0].content).not.toContain('<name>review</name>')
    expect(first.body.messages[0].content).not.toContain('AUTO-SKILL-BODY')
    await expect(messages).toContainText('/skill:review 核对交付')
    await expect(messages).toContainText('已加载 review')
    calls(first, { name: 'read', args: { path: ref } })
    const withReference = await request(1)
    expect(JSON.stringify(withReference.body.messages)).toContain('REF-VERIFIED')
    await complete(withReference, '已核对交付。')

    await writeFile(skillPath, markdown('review', 'REVIEW-BODY-B', true))
    const retry = await page.request.post(url + '/api/sessions/start', { data: firstInput, headers: { Origin: url } })
    expect(retry.status()).toBe(202)
    expect(model.exchanges).toHaveLength(2)
    await server.close()
    restarted = new WebServer({ ...options, port: Number(new URL(url).port) })
    const resumed = await restarted.start()
    await authorize(page, resumed.authUrl)
    await expect(messages).toContainText('已加载 review')
    const snapshot = observed.snapshots.at(-1)?.snapshot
    expect(snapshot?.messages[0]).toMatchObject({ skillInvocation: { name: 'review', source: 'project-si', status: 'loaded' } })
    expect(snapshot?.messages[0]?.skillInvocation).toEqual({ name: 'review', source: 'project-si', status: 'loaded' })

    await submit('/skill:review 第二次')
    const secondUse = await request(2)
    expect(secondUse.body.messages.filter(item => item.role === 'user').map(item => item.content)).toEqual([
      expect.stringContaining('REVIEW-BODY-A'), expect.stringContaining('REVIEW-BODY-B'),
    ])
    await complete(secondUse, '已使用新版。')

    await submit('按规则创建项目 Skill 和个人 Skill')
    const create = await request(3)
    const system = String(create.body.messages[0].content)
    const docs = /Skill 规则见 (\/[^\n]+\/docs\/skills\.md)。/.exec(system)?.[1]
    expect(docs).toBeTruthy()
    expect(system).not.toContain('## 文件格式')
    calls(create, { name: 'read', args: { path: docs } }, { name: 'read', args: { path: automatic } })
    const rules = await request(4)
    expect(JSON.stringify(rules.body.messages)).toContain('## 文件格式')
    expect(JSON.stringify(rules.body.messages)).toContain('AUTO-SKILL-BODY')
    expect(JSON.stringify(rules.body.messages)).not.toContain('WORKSPACE-DOC-MUST-NOT-LOAD')
    calls(rules,
      { name: 'write', args: { path: created, content: markdown('follow-up', 'FOLLOW-UP-BODY') } },
      { name: 'write', args: { path: personal, content: markdown('personal', 'PERSONAL-BODY') } },
      { name: 'write', args: { path: join(ref, 'impossible.md'), content: 'must fail' } },
    )
    const wrote = await request(5)
    expect(wrote.body.messages[0].content).not.toContain('<name>follow-up</name>')
    expect(wrote.body.messages.slice(-3)).toEqual([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('已写入') }),
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('已写入') }),
      expect.objectContaining({ role: 'tool', content: expect.stringMatching(/EEXIST|ENOTDIR/) }),
    ])
    await expect(readFile(join(ref, 'impossible.md'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    calls(wrote, { name: 'read', args: { path: created } }, { name: 'read', args: { path: personal } })
    const checked = await request(6)
    expect(JSON.stringify(checked.body.messages.filter(message => message.role === 'tool'))).toContain('FOLLOW-UP-BODY')
    expect(await readFile(personal, 'utf8')).toContain('PERSONAL-BODY')
    await complete(checked, '已创建并读回两份 Skill。')

    expect((await catalog(workspaceId, resumed.url)).skills.map(item => item.name)).toContain('follow-up')
    await submit('/skill:follow-up 核对新建')
    const next = await request(7)
    expect(next.body.messages[0].content).toContain('<name>follow-up</name>')
    expect(next.body.messages.at(-1)?.content).toContain('FOLLOW-UP-BODY')
    await complete(next, '已按新规则核对。')

    const denied = join(cwd, 'script-effect.txt')
    await page.locator('.composer-actions').getByRole('combobox', { name: '权限', exact: true }).click()
    await page.getByRole('option', { name: '只读', exact: true }).click()
    await submit('/skill:review 测试权限')
    const readOnly = await request(8)
    calls(readOnly, { name: 'read', args: { path: ref } },
      { name: 'bash', args: { command: 'touch script-effect.txt' } },
      { name: 'edit', args: { path: ref, edits: [{ oldText: 'REF-VERIFIED', newText: 'MODIFIED' }] } })
    const protectedResult = await request(9)
    const results = protectedResult.body.messages.slice(-3)
    expect(results).toEqual([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('REF-VERIFIED') }),
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('只读模式') }),
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('只读模式') }),
    ])
    expect(await readFile(ref, 'utf8')).toBe('REF-VERIFIED')
    await expect(readFile(denied)).rejects.toMatchObject({ code: 'ENOENT' })
    await complete(protectedResult, '只读限制已核对。')

    picked = second
    await page.getByRole('button', { name: '新建会话', exact: true }).click()
    const selected = page.waitForResponse('**/api/workspaces/pick')
    await page.getByRole('combobox', { name: '工作区', exact: true }).click()
    await page.getByRole('option', { name: '添加工作区…', exact: true }).click()
    const selection: WorkspacePick = await (await selected).json()
    if (selection.cancelled) throw new Error('第二个临时工作区未选择')
    const other = (await catalog(selection.workspaceId, resumed.url)).skills
    expect(other.map(item => item.name)).not.toContain('follow-up')
    expect(other).toContainEqual(expect.objectContaining({ name: 'personal', source: 'user-si' }))
  } finally {
    await Promise.allSettled([server.close(), restarted?.close(), model.close()])
    await rm(root, { recursive: true, force: true })
  }
})
