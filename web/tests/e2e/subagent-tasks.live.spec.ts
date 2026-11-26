import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, type ConversationMessage } from '@agent-learning/coding-agent'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, saveKey, seedSession } from './test-utils'

const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
test.setTimeout(240_000)

type SavedCheck = (store: SessionStore, rootId: string) => void
type Setup = {
  cwd: string
  home: string
  send(prompt: string): Promise<() => Promise<string>>
}

async function live(page: Page, scenario: (setup: Setup) => Promise<SavedCheck>) {
  const root = await mkdtemp(join(tmpdir(), 'si-subagent-live-'))
  const cwd = join(root, 'workspace'), home = join(root, 'home'), sessionPath = join(root, 'sessions.sqlite')
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, skillHome: home, sessionPath,
    browserSecretPath: join(root, 'browser-auth.json'), modelAuthPath: join(root, 'auth.json'),
    workspacePath: join(root, 'workspaces.json'), webSettingsPath: join(root, 'web-settings.json'),
    globalContextDirectory: join(root, 'global-context'),
  })
  try {
    await mkdir(cwd)
    await mkdir(join(home, '.si', 'agents'), { recursive: true })
    const observed = observe(page)
    await authorize(page, (await server.start()).authUrl)
    const workspace = await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    const rootId = await seedSession(page, observed, workspace)
    const verify = await scenario({ cwd, home, send: async prompt => {
      const from = observed.updates.length
      const editor = page.getByRole('textbox', { name: '消息', exact: true })
      await editor.fill(prompt)
      const button = page.getByRole('button', { name: '发送', exact: true })
      await expect(button).toBeEnabled()
      await button.click()
      return async () => {
        const changes = () => observed.updates.slice(from).filter(update => update.sessionId === rootId).map(update => update.update.change)
        await expect.poll(() => changes().some(change => change.type === 'task' && change.running === null), { timeout: 120_000 }).toBe(true)
        return changes().flatMap(change =>
          change.type === 'model' && change.event.type === 'done' && change.event.reason === 'stop' ? [change.event.message] : [])
          .at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
      }
    } })
    await server.close()
    const store = SessionStore.open(sessionPath)
    try { verify(store, rootId) } finally { store.close() }
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function calls(messages: readonly ConversationMessage[], name: 'subagent' | 'team') {
  return messages.flatMap(entry => entry.message.role === 'assistant' ? entry.message.content.flatMap((block, index) =>
    block.type === 'toolCall' && block.name === name ? [{
      id: block.id, args: block.arguments,
      result: messages.find(result => result.toolCall?.assistantMessageId === entry.id && result.toolCall.contentIndex === index)?.message,
    }] : []) : [])
}

test('59 DeepSeek Flash 按注册角色审查文件，并沿原子会话继续', async ({ page }) => {
  await live(page, async ({ home, cwd, send }) => {
    const marker = 'missing-negative-' + randomUUID().slice(0, 8)
    const implementation = join(cwd, 'normalize.ts')
    const roleFile = join(home, '.si', 'agents', 'test-reviewer.md')
    await writeFile(implementation, `export function normalize(count: number) {
  if (count < 0) throw new Error('${marker}')
  return count
}
`)
    await writeFile(join(cwd, 'normalize.test.ts'), "import { equal } from 'node:assert/strict'\nimport { normalize } from './normalize.ts'\nequal(normalize(1), 1)\n")
    const created = await send(`请创建个人子 Agent 角色 test-reviewer，用来查单元测试缺口。保存到 ${roleFile}。
先用 read 阅读 SI 应用文档中的 docs/subagents.md。按指南写角色文件，名称 test-reviewer，工具只需要 read。
角色工作要求是阅读实现和现有测试，列出缺失用例并引用真实错误标记。先创建角色，这轮不要委派。`)
    await created()
    expect(await readFile(roleFile, 'utf8')).toMatch(/^---[\s\S]*name:\s*test-reviewer\b/)

    const reviewed = await send(`用 subagent.run 按个人注册角色 test-reviewer 新建一个同名子会话进行前台审查，显式传 background: false。
让它读 normalize.ts 和 normalize.test.ts 找缺失的边界测试，并汇报源码中的报错原文。你只汇总子 Agent 的真实输出。`)
    expect(await reviewed()).toContain(marker)

    const followed = await send(`用 subagent.continue 前台继续刚才那一个 test-reviewer 子会话，传 background: false，必须在调用中用上一轮实际返回的 sessionId。
请它根据已有历史解释为什么负数应单独测试，并重复原错误标记。你只汇总它这一次的输出。`)
    expect(await followed()).toContain(marker)
    return (store, rootId) => {
      const root = store.loadSession(rootId)!
      expect(root.messages.some(entry => entry.fileOperation?.kind === 'read' && entry.fileOperation.path.endsWith('/docs/subagents.md'))).toBe(true)
      expect(root.messages.some(entry => entry.fileOperation?.kind === 'modified' && entry.fileOperation.path.endsWith('/.si/agents/test-reviewer.md'))).toBe(true)
      const children = store.listSubagents(rootId)
      expect(children).toHaveLength(1)
      const child = store.loadSession(children[0]!.id)!
      expect(child.summary.subagent?.role?.name).toBe('test-reviewer')
      expect(child.runs.map(run => run.status)).toEqual(['completed', 'completed'])
      expect(child.messages.filter(entry => entry.fileOperation?.kind === 'read').map(entry => entry.fileOperation!.path))
        .toEqual(expect.arrayContaining([expect.stringMatching(/\/normalize\.ts$/), expect.stringMatching(/\/normalize\.test\.ts$/)]))
      const [start, resume] = calls(root.messages, 'subagent').filter(call => ['run', 'continue'].includes(String(call.args.action)))
      expect(start).toMatchObject({ args: { action: 'run', agent: 'test-reviewer' }, result: { role: 'toolResult', toolCallId: start?.id, isError: false } })
      expect(resume).toMatchObject({ args: { action: 'continue', sessionId: child.summary.id }, result: { role: 'toolResult', toolCallId: resume?.id, isError: false } })
      expect(JSON.stringify(start?.result)).toContain(marker)
      expect(JSON.stringify(resume?.result)).toContain(marker)
    }
  })
})

test('60 DeepSeek Flash 前台并行，侦查用 team 把独有识别码交给审查', async ({ page }) => {
  await live(page, async ({ cwd, send }) => {
    const marker = 'survey-' + randomUUID()
    await writeFile(join(cwd, 'scout-input.txt'), marker + '\n')
    const finished = await send(`请仅用一次 subagent.run 的 tasks（background: false）前台并行启动两个普通子 Agent，名称分别为 scout 和 reviewer，按下面原样交办。
scout 的任务：先用前台 bash 执行 until test -f reviewer-ready; do sleep 0.1; done，然后只由你读取 scout-input.txt。用 team.list 查询同批 reviewer，再用 team.steer 把读取到的准确识别码交给 reviewer 的当前轮。只有在 team.steer 已经接受后，才用 bash 执行 touch scout-sent。最终答复报告识别码和成功交接。
reviewer 的任务：第一步立即用前台 bash 运行 touch reviewer-ready; until test -f reviewer-release; do sleep 0.1; done（timeout 120）。你会收到同级 scout 的插话，识别码只从其插话获取。等待前台命令结束，读到插话后，用最终答复原样重复识别码并说明来源。
主 Agent 自己无需读文件或运行 bash。用原工具调用的两个结果汇总交接和识别码。`)
    try {
      await expect.poll(() => readFile(join(cwd, 'scout-sent'), 'utf8').then(() => true, () => false), { timeout: 90_000 }).toBe(true)
    } finally {
      await writeFile(join(cwd, 'reviewer-release'), '')
    }
    expect(await finished()).toContain(marker)
    return (store, rootId) => {
      const children = store.listSubagents(rootId)
      expect(children.map(child => child.name).sort()).toEqual(['reviewer', 'scout'])
      const scout = store.loadSession(children.find(child => child.name === 'scout')!.id)!
      const reviewer = store.loadSession(children.find(child => child.name === 'reviewer')!.id)!
      const team = calls(scout.messages, 'team')
      const listed = team.find(call => call.args.action === 'list')
      expect(JSON.stringify(listed?.result)).toContain(reviewer.summary.id)
      expect(JSON.stringify(listed?.result)).toContain('reviewer')
      const steer = team.find(call => call.args.action === 'steer' && String(call.args.message).includes(marker))
      expect(steer?.result).toMatchObject({ role: 'toolResult', isError: false })
      expect(steer?.args.name === 'reviewer' || steer?.args.sessionId === reviewer.summary.id).toBe(true)
      expect(reviewer.runs).toHaveLength(1)
      const requested = reviewer.messages.find(entry => entry.agentSource?.kind === 'task')
      expect(JSON.stringify(requested?.message)).not.toContain(marker)
      const notice = reviewer.messages.find(entry => entry.agentSource?.kind === 'steer')
      expect(notice).toMatchObject({ runId: reviewer.runs[0]?.id, agentSource: { sessionId: scout.summary.id, name: 'scout' } })
      expect(JSON.stringify(notice?.message)).toContain(marker)
      expect(JSON.stringify(reviewer.messages.at(-1)?.message)).toContain(marker)
      const delegated = calls(store.loadSession(rootId)!.messages, 'subagent').filter(call => call.args.action === 'run')
      expect(delegated).toHaveLength(1)
      expect(JSON.stringify(delegated[0]?.result)).toContain('scout')
      expect(JSON.stringify(delegated[0]?.result)).toContain('reviewer')
      expect(JSON.stringify(delegated[0]?.result)).toContain(marker)
    }
  })
})
