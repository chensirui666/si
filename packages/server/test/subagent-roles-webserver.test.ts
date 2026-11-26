import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionStore } from '@agent-learning/coding-agent'
import { expect, it, vi } from 'vitest'
import type { WorkspaceView } from '../src/webserver/protocol.js'
import { finish, fixture, stop, toolCall, userTexts, type Exchange } from './collaboration-fixture.js'

type WorkspaceRecord = { id: string; path: string; projectAgentsEnabled?: boolean }
type App = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['start']>>

const rolePath = (base: string, name: string) => join(base, '.si', 'agents', name + '.md')
const personal = (directory: string) => join(directory, 'skill-home')
const markdown = (name: string, description: string, body: string, settings = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${settings}---\n${body}\n`

async function putRole(base: string, name: string, description: string, body: string, settings?: string) {
  const path = rolePath(base, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, markdown(name, description, body, settings))
  return path
}

const writeWorkspaces = (directory: string, ...workspaces: WorkspaceRecord[]) =>
  writeFile(join(directory, 'workspaces.json'), JSON.stringify({ workspaces }), { mode: 0o600 })

async function setup() {
  const environment = await fixture()
  const app = await environment.start()
  await app.saveKey()
  const workspaceId = await app.pick()
  const id = await app.create(workspaceId)
  return { ...environment, app, id, workspaceId }
}

function system(exchange: Exchange) {
  const content = exchange.body.messages.find(message => message.role === 'system')?.content
  expect(content).toEqual(expect.any(String))
  return String(content)
}

function roleCatalog(exchange: Exchange) {
  return /<subagent_roles>\n([\s\S]*?)\n<\/subagent_roles>/.exec(system(exchange))?.[1] ?? ''
}

function result(exchange: Exchange, tool: string) {
  const message = exchange.body.messages.at(-1)
  expect(message).toMatchObject({ role: 'tool', tool_call_id: `call-${tool}` })
  return String(message?.content)
}

async function settle(app: App, id: string, exchange: Exchange) {
  finish(exchange)
  await vi.waitFor(async () => expect((await app.snapshot(id)).running).toBeNull())
}

it('01 个人角色向主模型提供摘要，子会话采用角色正文、模型和获准工具', async () => {
  const { app, directory, id, requestNumber } = await setup()
  await app.saveKey('qwen')
  const body = 'PERSONAL-REVIEW-INSTRUCTIONS'
  const path = await putRole(personal(directory), 'test-reviewer', '查找测试缺口', body,
    'model: qwen/qwen3.6-plus\ntools: [read, grep, bash]\n')
  expect((await app.call(`/api/sessions/${id}/permission`, { permissionMode: 'read-only' }, 'PUT')).status).toBe(200)

  await app.accept(id, 'roles-01', '使用 test-reviewer 检查测试缺口')
  const parent = await requestNumber(1)
  expect(parent.body.model).toBe('deepseek-flash')
  expect(roleCatalog(parent)).toBe('- test-reviewer：查找测试缺口')
  expect(system(parent)).not.toContain(body)
  expect(system(parent)).not.toContain(path)
  expect(system(parent)).not.toContain('qwen3.6-plus')
  toolCall(parent, 'subagent', { action: 'run', agent: 'test-reviewer', task: '检查测试缺口', background: false })

  const child = await requestNumber(2)
  expect(child.body.model).toBe('qwen3.6-plus')
  expect(child.authorized).toBe(true)
  expect(system(child)).toContain(body)
  expect(userTexts(child)).toEqual(['Task: 检查测试缺口'])
  const tools = child.body.tools as { function: { name: string } }[]
  expect(tools.map(tool => tool.function.name).sort()).toEqual(['grep', 'read', 'team'])
  finish(child, '报告测试缺口')
  await settle(app, id, await requestNumber(3))
}, 15000)

it('02 缺少项目角色开关的旧工作区仍可用，项目角色默认关闭', async () => {
  const { directory, provider, start, requestNumber } = await fixture()
  const path = await realpath(directory)
  const workspaceId = 'legacy-workspace'
  await writeWorkspaces(directory, { id: workspaceId, path })
  await putRole(personal(directory), 'personal-review', '个人审查', '个人正文')
  await putRole(directory, 'project-only', '项目审查', '项目正文')
  const app = await start()
  await app.saveKey()
  expect(await app.pick()).toBe(workspaceId)
  const view = await (await app.request('/api/workspaces')).json() as WorkspaceView
  expect(view.workspaces).toMatchObject([{ id: workspaceId, path, available: true }])
  const id = await app.create(workspaceId)

  await app.accept(id, 'roles-02', '运行 project-only')
  const parent = await requestNumber(1)
  expect(roleCatalog(parent)).toBe('- personal-review：个人审查')
  toolCall(parent, 'subagent', { action: 'run', agent: 'project-only', task: '检查配置', background: false })
  const denied = await requestNumber(2)
  expect(result(denied, 'subagent')).toContain('未启用项目子 Agent 角色')
  await settle(app, id, denied)
  expect(provider.exchanges).toHaveLength(2)
  expect((await app.snapshot(id)).subagents ?? []).toEqual([])
}, 15000)

it('03 启用项目角色后默认采用项目版，明确指定 user 时采用个人版', async () => {
  const { app, directory, id, workspaceId, requestNumber } = await setup()
  await putRole(personal(directory), 'reviewer', '个人审查', 'PERSONAL-REVIEW-VERSION')
  await putRole(directory, 'reviewer', '项目审查', 'PROJECT-REVIEW-VERSION')
  await writeWorkspaces(directory, { id: workspaceId, path: await realpath(directory), projectAgentsEnabled: true })

  await app.accept(id, 'roles-03', '先使用项目 reviewer，再使用个人 reviewer')
  const parent = await requestNumber(1)
  expect(roleCatalog(parent)).toBe('- reviewer：项目审查')
  toolCall(parent, 'subagent', { action: 'run', agent: 'reviewer', task: '项目检查', background: false })
  const project = await requestNumber(2)
  expect(system(project)).toContain('PROJECT-REVIEW-VERSION')
  finish(project)
  const followup = await requestNumber(3)
  toolCall(followup, 'subagent', { action: 'run', agent: 'reviewer', agentScope: 'user', task: '个人检查', background: false })
  const user = await requestNumber(4)
  expect(system(user)).toContain('PERSONAL-REVIEW-VERSION')
  expect(system(user)).not.toContain('PROJECT-REVIEW-VERSION')
  finish(user)
  await settle(app, id, await requestNumber(5))
}, 15000)

it('04 一次工具调用改写角色目录，同一轮模型看到新版，启动前再读取正文', async () => {
  const { app, directory, id, requestNumber } = await setup()
  const changed = await putRole(personal(directory), 'changed', '旧用途', 'OLD-BODY')
  await putRole(personal(directory), 'discarded', '移除的用途', 'DISCARD-BODY')
  const relative = 'skill-home/.si/agents'
  await app.accept(id, 'roles-04', '更新角色后立即委派')
  const first = await requestNumber(1)
  expect(roleCatalog(first).split('\n')).toEqual(['- changed：旧用途', '- discarded：移除的用途'])
  toolCall(first, 'bash', { command: [
    `cat > ${relative}/changed.md <<'ROLE'\n${markdown('changed', '新用途', 'CATALOG-BODY')}ROLE`,
    `cat > ${relative}/added.md <<'ROLE'\n${markdown('added', '新增用途', 'ADDED-BODY')}ROLE`,
    `rm -- ${relative}/discarded.md`,
  ].join('\n') })

  const next = await requestNumber(2)
  expect(roleCatalog(next).split('\n')).toEqual(['- added：新增用途', '- changed：新用途'])
  await writeFile(changed, markdown('changed', '新用途', 'LATEST-LAUNCH-BODY'))
  toolCall(next, 'subagent', { action: 'run', agent: 'changed', task: '使用最新说明', background: false })
  const child = await requestNumber(3)
  expect(system(child)).toContain('LATEST-LAUNCH-BODY')
  expect(system(child)).not.toContain('CATALOG-BODY')
  finish(child)
  await settle(app, id, await requestNumber(4))
}, 15000)

it('05 主模型看到项目角色后撤销授权，换任务目录也会拒绝启动', async () => {
  const { app, directory, id, workspaceId, provider, requestNumber } = await setup()
  const path = await realpath(directory)
  const other = join(path, 'other')
  await putRole(path, 'reviewer', '原工作区角色', 'ORIGINAL-WORKSPACE-BODY')
  await putRole(other, 'reviewer', '另一个工作区角色', 'OTHER-WORKSPACE-BODY')
  await putRole(personal(directory), 'reviewer', '同名个人角色', 'PERSONAL-WORKSPACE-BODY')
  const alternative = { id: 'other-workspace', path: other, projectAgentsEnabled: true }
  await writeWorkspaces(directory, { id: workspaceId, path, projectAgentsEnabled: true }, alternative)

  await app.accept(id, 'roles-05', '请 reviewer 检查另一个目录')
  const parent = await requestNumber(1)
  expect(roleCatalog(parent)).toBe('- reviewer：原工作区角色')
  await writeWorkspaces(directory, { id: workspaceId, path, projectAgentsEnabled: false }, alternative)
  toolCall(parent, 'subagent', { action: 'run', agent: 'reviewer', cwd: other, task: '检查文件', background: false })
  const denied = await requestNumber(2)
  expect(result(denied, 'subagent')).toContain('未启用项目子 Agent 角色')
  await settle(app, id, denied)
  expect(provider.exchanges).toHaveLength(2)
  expect((await app.snapshot(id)).subagents ?? []).toEqual([])
}, 15000)

it('06 关闭项目授权并重启后，保留已有子会话历史并拒绝续用', async () => {
  const { app, directory, id, workspaceId, provider, requestNumber, start } = await setup()
  const path = await realpath(directory)
  await putRole(directory, 'reviewer', '项目审查', 'PROJECT-RESUME-CHECK')
  await writeWorkspaces(directory, { id: workspaceId, path, projectAgentsEnabled: true })
  await app.accept(id, 'roles-06-start', '先做一次检查')
  toolCall(await requestNumber(1), 'subagent', { action: 'run', agent: 'reviewer', task: '已有子任务', background: false })
  const child = await requestNumber(2)
  expect(system(child)).toContain('PROJECT-RESUME-CHECK')
  finish(child, '保留已完成子会话历史')
  await settle(app, id, await requestNumber(3))
  const savedChild = (await app.snapshot(id)).subagents?.[0]
  expect(savedChild).toMatchObject({ name: 'reviewer', status: 'completed' })

  await writeWorkspaces(directory, { id: workspaceId, path, projectAgentsEnabled: false })
  expect(await stop(app.child, 'SIGTERM')).toEqual([0, null])
  const reopened = await start()
  expect((await reopened.snapshot(id)).subagents).toEqual([savedChild])
  await reopened.accept(id, 'roles-06-resume', '接着做之前的检查')
  toolCall(await requestNumber(4), 'subagent', { action: 'continue', sessionId: savedChild!.sessionId, message: '新增检查', background: false })
  const denied = await requestNumber(5)
  expect(result(denied, 'subagent')).toContain('未启用项目子 Agent 角色')
  await settle(reopened, id, denied)
  expect(provider.exchanges).toHaveLength(5)

  expect(await stop(reopened.child, 'SIGTERM')).toEqual([0, null])
  const store = SessionStore.open(join(directory, 'sessions.sqlite'))
  try {
    const restored = store.loadSession(savedChild!.sessionId)
    expect(restored?.runs.map(run => ({ id: run.id, status: run.status }))).toEqual([{ id: savedChild!.runId, status: 'completed' }])
    expect(JSON.stringify(restored?.messages)).toContain('保留已完成子会话历史')
  } finally { store.close() }
}, 15000)

it('07 前台与后台通用子 Agent 读取指定目录说明并沿用主会话模型与推理级别', async () => {
  const { app, directory, id, provider, requestNumber } = await setup()
  const cwd = join(await realpath(directory), 'task-dir')
  await mkdir(cwd)
  await writeFile(join(cwd, 'AGENTS.md'), '# TASK-DIR-INSTRUCTIONS\n在这个目录执行子任务。\n')
  const selection = { provider: 'deepseek', modelId: 'deepseek-flash', reasoningEffort: 'max' } as const
  expect((await app.call('/api/model-selection', { ...selection, sessionId: id }, 'PUT')).status).toBe(200)
  await app.accept(id, 'roles-07', '前后台都使用指定目录', selection)
  const main = await requestNumber(1)
  expect(main.body.reasoning_effort).toBe('max')
  const checkChild = (child: Exchange, name: string) => {
    expect(system(child)).toContain(`你是子 Agent「${name}」`)
    expect(system(child)).toContain('为主 Agent 工作')
    expect(system(child)).toContain('简洁作答')
    expect(system(child)).toContain('最终答复会报告给')
    expect(system(child)).toContain('team')
    expect(system(child)).toContain('TASK-DIR-INSTRUCTIONS')
    expect(system(child)).toContain(cwd)
    expect(child.body.model).toBe(main.body.model)
    expect(child.body.reasoning_effort).toBe('max')
  }

  toolCall(main, 'subagent', { action: 'run', name: 'foreground', task: '前台检查', cwd: 'task-dir', background: false })
  const foreground = await requestNumber(2)
  expect(userTexts(foreground)).toEqual(['Task: 前台检查'])
  checkChild(foreground, 'foreground')
  finish(foreground)
  toolCall(await requestNumber(3), 'subagent', { action: 'run', name: 'background', task: '后台检查', cwd, background: true })

  await requestNumber(5)
  const background = provider.exchanges.slice(3).find(exchange => userTexts(exchange).at(-1) === 'Task: 后台检查')!
  const receipt = provider.exchanges.slice(3).find(exchange => exchange !== background)!
  expect(background).toBeDefined()
  checkChild(background, 'background')
  expect(result(receipt, 'subagent')).toContain('delegationId')
  finish(background, '后台检查完毕')
  finish(receipt)
  const report = await requestNumber(6)
  expect(JSON.stringify(userTexts(report))).toContain('后台检查完毕')
  await settle(app, id, report)
}, 15000)

it('08 无效工作目录不会启动子会话，之后仍可正常委派', async () => {
  const { app, directory, id, provider, requestNumber } = await setup()
  const cwd = join(await realpath(directory), 'absent')
  await app.accept(id, 'roles-08', '检查接单失败后的恢复')
  toolCall(await requestNumber(1), 'subagent', { action: 'run', task: '不能启动', cwd, background: false })
  const denied = await requestNumber(2)
  expect(result(denied, 'subagent')).toContain(`子任务工作目录不可用：${cwd}`)
  expect(provider.exchanges).toHaveLength(2)
  expect((await app.snapshot(id)).subagents ?? []).toEqual([])

  toolCall(denied, 'subagent', { action: 'run', name: 'valid', task: '正常启动', background: false })
  const child = await requestNumber(3)
  expect(userTexts(child)).toEqual(['Task: 正常启动'])
  finish(child)
  await settle(app, id, await requestNumber(4))
}, 15000)

it('09 主模型读取 SI 自带指南，用真实 write 工具注册角色后同一轮可委派', async () => {
  const { app, directory, id, requestNumber } = await setup()
  const workspaceGuide = join(directory, 'docs', 'subagents.md')
  const appGuide = fileURLToPath(new URL('../../../docs/subagents.md', import.meta.url))
  await mkdir(dirname(workspaceGuide))
  await writeFile(workspaceGuide, 'WORKSPACE-GUIDE-MUST-NOT-BE-USED')

  await app.accept(id, 'roles-09', '创建个人子 Agent test-reviewer，负责检查测试缺口')
  const first = await requestNumber(1)
  expect(system(first)).toContain(`先用 read 完整阅读 ${appGuide}`)
  expect(system(first)).not.toContain(workspaceGuide)
  toolCall(first, 'read', { path: appGuide })
  const readGuide = await requestNumber(2)
  expect(result(readGuide, 'read')).toContain('在 SI 创建和使用子 Agent 角色')
  expect(result(readGuide, 'read')).not.toContain('WORKSPACE-GUIDE-MUST-NOT-BE-USED')

  const path = rolePath(personal(directory), 'test-reviewer')
  const content = markdown('test-reviewer', '检查测试缺口', 'CREATE-AND-USE-ROLE-BODY', 'tools: [read, grep]\n')
  toolCall(readGuide, 'write', { path, content })
  const created = await requestNumber(3)
  expect(await readFile(path, 'utf8')).toBe(content)
  expect(roleCatalog(created)).toBe('- test-reviewer：检查测试缺口')
  toolCall(created, 'subagent', { action: 'run', agent: 'test-reviewer', task: '验证新角色可用', background: false })
  const child = await requestNumber(4)
  expect(system(child)).toContain('CREATE-AND-USE-ROLE-BODY')
  finish(child)
  await settle(app, id, await requestNumber(5))
}, 15000)

it('后台报告等项目角色重新获得授权后才开启新一轮', async () => {
  const { directory, provider, requestNumber, start } = await fixture()
  const attempted = join(directory, 'report-attempted')
  const marker = 'AUTH-GATED-REPORT-PAYLOAD'
  const extension = join(directory, 'global-context', 'extensions', 'report-authorization.ts')
  await mkdir(dirname(extension), { recursive: true })
  await writeFile(extension, `
    import { writeFile } from 'node:fs/promises'
    export default si => si.on('before_agent_start', async ({ prompt }) => {
      if (prompt.startsWith('[后台完成报告') && prompt.includes(${JSON.stringify(marker)})) {
        await writeFile(${JSON.stringify(attempted)}, '')
      }
    })
  `)
  await putRole(directory, 'reviewer', '项目审查', 'PROJECT-ROLE-AUTH-REPORT')
  const app = await start()
  await app.saveKey()
  const workspaceId = await app.pick()
  const path = await realpath(directory)
  const authorize = (projectAgentsEnabled: boolean) => writeWorkspaces(directory, { id: workspaceId, path, projectAgentsEnabled })
  await authorize(true)
  const id = await app.create(workspaceId)
  const lastUser = (exchange: Exchange) => String(userTexts(exchange).at(-1))
  const subject = '准备后台报告验收'
  await app.accept(id, 'report-auth-initial', subject)
  toolCall(await requestNumber(1), 'subagent', { action: 'run', background: true, tasks: [
    { agent: 'reviewer', task: '项目角色首轮' },
    { name: 'scout', task: '保持原批次运行' },
  ] })
  await requestNumber(4)
  const main = provider.exchanges.slice(1, 4).find(item => lastUser(item) === subject)!
  const reviewer = provider.exchanges.slice(1, 4).find(item => lastUser(item) === 'Task: 项目角色首轮')!
  expect(system(reviewer)).toContain('PROJECT-ROLE-AUTH-REPORT')
  const child = (await app.snapshot(id)).subagents?.find(item => item.name === 'reviewer')
  expect(child).toMatchObject({ status: 'running' })
  await settle(app, id, main)

  toolCall(reviewer, 'team', { action: 'continue', name: 'parent', message: '生成一份会回到项目角色的报告', background: true })
  await requestNumber(6)
  const generating = provider.exchanges.slice(4, 6).find(item => lastUser(item).includes('生成一份会回到项目角色的报告'))!
  const childReceipt = provider.exchanges.slice(4, 6).find(item => lastUser(item) === 'Task: 项目角色首轮')!
  expect(JSON.parse(result(childReceipt, 'team'))).toMatchObject({ sessionId: id, status: 'accepted' })
  finish(childReceipt, '等待主会话报告')
  await vi.waitFor(async () => {
    expect((await app.snapshot(id)).subagents).toContainEqual({ ...child, status: 'completed' })
  })
  await authorize(false)
  finish(generating, marker)
  await vi.waitFor(() => stat(attempted), { timeout: 4000 })
  await vi.waitFor(async () => expect((await app.snapshot(id)).running).toBeNull())

  await app.accept(id, 'report-auth-check', '检查撤权后的项目角色')
  const probe = await requestNumber(7)
  expect(lastUser(probe)).toBe('检查撤权后的项目角色')
  toolCall(probe, 'subagent', { action: 'continue', sessionId: child!.sessionId, message: '项目授权关闭时禁止继续', background: false })
  const denied = await requestNumber(8)
  expect(result(denied, 'subagent')).toContain('未启用项目子 Agent 角色')
  expect(provider.exchanges).toHaveLength(8)
  expect((await app.snapshot(id)).subagents).toContainEqual({ ...child, status: 'completed' })

  await authorize(true)
  toolCall(denied, 'subagent', { action: 'continue', sessionId: child!.sessionId, message: '项目重新授权后继续', background: false })
  const resumed = await requestNumber(9)
  expect(lastUser(resumed)).toContain('项目重新授权后继续')
  expect(system(resumed)).toContain('PROJECT-ROLE-AUTH-REPORT')
  finish(resumed)
  await requestNumber(11)
  const afterAuthorization = provider.exchanges.slice(9, 11)
  const report = afterAuthorization.find(item => lastUser(item).startsWith('[后台完成报告'))!
  const parent = afterAuthorization.find(item => item !== report)!
  expect(lastUser(report)).toContain(marker)
  expect(system(report)).toContain('PROJECT-ROLE-AUTH-REPORT')
  finish(report, '已读取这份报告')
  await settle(app, id, parent)

  expect(await stop(app.child, 'SIGTERM')).toEqual([0, null])
  const store = SessionStore.open(join(directory, 'sessions.sqlite'))
  try {
    const history = store.loadSession(child!.sessionId)
    expect(history?.runs).toHaveLength(3)
    expect(history?.messages.filter(entry => entry.agentSource?.kind === 'report')).toMatchObject([
      { message: { role: 'user', content: expect.stringContaining(marker) } },
    ])
  } finally { store.close() }
}, 15000)
