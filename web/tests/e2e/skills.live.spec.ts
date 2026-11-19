import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebServer } from '@agent-learning/server'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { addWorkspace, authorize, observe, saveKey } from './test-utils'

const keyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
test.skip(!keyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
test.setTimeout(420_000)

const siRoot = fileURLToPath(new URL('../../../', import.meta.url))
const bundled = join(siRoot, 'resources/skills/grill-me')

async function liveProject(page: Page, scenario: (setup: {
  repo: string; cwd: string; home: string; turn: ReturnType<typeof turnRecorder>
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'si-skill-live-'))
  const repo = join(root, 'repo'), cwd = join(repo, 'src'), home = join(root, 'home')
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, skillHome: home,
    browserSecretPath: join(root, 'browser-auth.json'), modelAuthPath: join(root, 'auth.json'),
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'),
    webSettingsPath: join(root, 'settings.json'), globalContextDirectory: join(root, 'global-context'),
  })
  try {
    await mkdir(cwd, { recursive: true })
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    const turn = turnRecorder(page)
    await authorize(page, (await server.start()).authUrl)
    await addWorkspace(page)
    await saveKey(page, await readLiveKey(keyFile!))
    await scenario({ repo, cwd, home, turn })
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function turnRecorder(page: Page) {
  const observed = observe(page)
  return async (prompt: string) => {
    const start = observed.updates.length
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt)
    const send = page.getByRole('button', { name: '发送', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => observed.updates.slice(start).some(({ update: { change } }) =>
      change.type === 'task' && change.running === null), { timeout: 120_000 }).toBe(true)
    const turns = observed.updates.slice(start).map(item => item.update.change)
    const complete = turns.flatMap(change =>
      change.type === 'model' && change.event.type === 'done' && change.event.reason === 'stop' ? [change.event.message] : [])
    expect(complete.length).toBeGreaterThan(0)
    const text = complete.at(-1)!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    const tools = turns.flatMap(change =>
      change.type === 'task' && change.message?.message.role === 'toolResult' ? [change.message] : [])
    const effects = tools.filter(entry => entry.fileOperation?.kind === 'modified')
    return { text, tools, effects }
  }
}

test('Skill 23/26/29：先确认范围与同名冲突，新建后在真实任务使用', async ({ page }) => {
  await liveProject(page, async ({ cwd, home, turn }) => {
    const name = 'delivery-check'
    const projectSkill = join(cwd, '.si/skills', name, 'SKILL.md')
    const personalSkill = join(home, '.si/skills', name, 'SKILL.md')
    const marker = 'verified-' + randomUUID().slice(0, 8)
    const projectRequest = `创建一项叫 ${name} 的 SI Skill。它用于核对本工作区的交付文件：先读 proof.txt，再以该文件内容写入 checked.txt，并读回核对。`
    const missing = await turn('/skill:skill-creator ' + projectRequest)
    expect(missing.text).toMatch(/项目/)
    expect(missing.text).toMatch(/个人/)
    expect(missing.effects).toEqual([])
    await expect(readFile(projectSkill)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(personalSkill)).rejects.toMatchObject({ code: 'ENOENT' })

    const created = await turn(`选项目范围。继续创建 ${name}，这一轮只创建 Skill。`)
    const body = await readFile(projectSkill, 'utf8')
    expect(body).toContain(`name: ${name}`)
    expect(created.effects.some(entry => entry.fileOperation?.path.endsWith(`/skills/${name}/SKILL.md`))).toBe(true)
    expect(created.tools.some(entry => entry.fileOperation?.kind === 'read' &&
      entry.fileOperation.path.endsWith(`/skills/${name}/SKILL.md`))).toBe(true)
    expect([...missing.tools, ...created.tools].some(entry => entry.fileOperation?.path === join(siRoot, 'docs/skills.md'))).toBe(true)

    const conflict = await turn('/skill:skill-creator 请新建一个叫 delivery-check 的 Skill，用来交叉核对清单。')
    expect(conflict.text).toContain(`/.si/skills/${name}/SKILL.md`)
    expect(conflict.text).toMatch(/修改|更新|改已有|改现有/)
    expect(conflict.text).toMatch(/另[一]?个[名]?|换名|改名|新名称|不同.*名/)
    expect(conflict.effects).toEqual([])
    expect(await readFile(projectSkill, 'utf8')).toBe(body)

    await writeFile(join(cwd, 'proof.txt'), marker + '\n')
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    await turn(`/skill:${name} 核对这次交付。`)
    expect((await readFile(join(cwd, 'checked.txt'), 'utf8')).trim()).toBe(marker)
    await expect(page.locator('.message-list')).toContainText(`已加载 ${name}`)
  })
})

test('Skill 28/31：agents-md 用实际命令更新选中仓库根的 AGENTS.md', async ({ page }) => {
  await liveProject(page, async ({ repo, cwd, turn }) => {
    const originalApplication = await readFile(join(siRoot, 'AGENTS.md'), 'utf8')
    const original = '# 项目说明\n\n- 保留现有数据文件。\n'
    const path = join(repo, 'AGENTS.md')
    await writeFile(path, original)
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/index.js' } }))
    await writeFile(join(cwd, 'index.js'), 'export const ready = true\n')
    const result = await turn('/skill:agents-md 根据这个仓库的实际命令定义，把语法校验命令补进项目说明。保留现有约定。')
    const updated = await readFile(path, 'utf8')
    expect(updated).toContain('- 保留现有数据文件。')
    expect(updated).toContain('npm run check')
    expect(result.tools.some(entry => entry.fileOperation?.kind === 'read' && entry.fileOperation.path.endsWith('/repo/package.json'))).toBe(true)
    expect(result.effects.some(entry => entry.fileOperation?.path.endsWith('/repo/AGENTS.md'))).toBe(true)
    expect(await readFile(join(siRoot, 'AGENTS.md'), 'utf8')).toBe(originalApplication)
  })
})

test('Skill 32/33：grill-me 每轮一个问题，个人副本生效且保留许可证', async ({ page }) => {
  await liveProject(page, async ({ cwd, home, turn }) => {
    const original = await readFile(join(bundled, 'SKILL.md'), 'utf8')
    const license = await readFile(join(bundled, 'LICENSE'), 'utf8')
    await writeFile(join(cwd, 'cache.ts'), 'export const cacheTTLSeconds = 120\nexport const maxEntries = 100\n')
    const permission = page.locator('.composer-actions').getByRole('combobox', { name: '权限', exact: true })
    await permission.click()
    await page.getByRole('option', { name: '只读', exact: true }).click()
    const first = await turn('/skill:grill-me 讨论本工作区 cache.ts 的缓存设计。我们还没决定是否允许刷新旧值，以及满容量时如何淘汰。每个需要我回答的问题各写一行，以「本轮问题：」开头。')
    expect(first.tools.some(entry => entry.fileOperation?.path.endsWith('/cache.ts'))).toBe(true)
    const decision = (text: string) => {
      const questions = text.split('\n')
        .filter(line => /^本轮问题[：:]/.test(line.trim().replace(/^[*#`> -]+/, '').replaceAll('**', '')))
      expect(questions).toHaveLength(1)
      expect(text).toMatch(/推荐|建议/)
      return questions[0]
    }
    const firstDecision = decision(first.text)
    const second = await turn('同意你对上一个问题的建议。请按当前 Skill 的方式继续，每个需要我回答的问题各写一行，以「本轮问题：」开头。')
    expect(decision(second.text)).not.toBe(firstDecision)

    await permission.click()
    await page.getByRole('option', { name: '普通', exact: true }).click()
    const marker = 'review-choice-' + randomUUID().slice(0, 8)
    await turn(`修改预置的 grill-me 并保存个人副本。保留原指令及许可证，只增加一条：每次提问以“${marker}”开头。`)
    const target = resolve(home, '.si/skills/grill-me')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain(marker)
    expect(await readFile(join(target, 'LICENSE'), 'utf8')).toBe(license)
    expect(await readFile(join(bundled, 'SKILL.md'), 'utf8')).toBe(original)
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    const reloaded = await turn('/skill:grill-me 讨论缓存容量与内存之间的取舍。')
    const personalizedQuestion = reloaded.text.split('\n').find(line =>
      line.trim().replace(/^[*#`> -]+/, '').startsWith(marker))
    expect(personalizedQuestion).toMatch(/[?？]/)
    await expect(page.locator('[data-skill-status="loaded"]')).toHaveText('已加载 grill-me · 个人')
  })
})
