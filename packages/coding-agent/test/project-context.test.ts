import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { loadProjectContextFiles, ProjectContextOverflow } from '../src/project-context.js'

vi.mock('node:fs/promises', { spy: true })

const temporary: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  await Promise.all(temporary.splice(0).map(path => fs.rm(path, { recursive: true, force: true })))
})

async function fixture(base = tmpdir()) {
  const root = await fs.realpath(await fs.mkdtemp(join(base, 'agent-project-context-')))
  temporary.push(root)
  const load = (cwd = root, globalDirectory?: string, maxBytes = 1024) =>
    loadProjectContextFiles({ cwd, globalDirectory, maxBytes, signal: new AbortController().signal })
  return { root, load }
}

it('选中首个可读候选，保留全文并去掉 UTF-8 BOM', async () => {
  const { root, load } = await fixture(process.env.FEATURE9_CASE_SENSITIVE_TEST_DIR)
  const names = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']
  const paths: string[] = []
  for (const name of names) {
    const path = join(root, name)
    try { await fs.writeFile(path, '\uFEFF 正文 ' + name + '\n', { flag: 'wx' }); paths.push(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || process.env.FEATURE9_CASE_SENSITIVE_TEST_DIR) throw error
    }
  }
  expect(paths.length).toBeGreaterThanOrEqual(3)
  for (const path of paths) {
    const selected = (await load()).filter(file => file.path.startsWith(root + '/'))
    expect(selected).toEqual([{ path, content: ' 正文 ' + basename(path) + '\n' }])
    await fs.unlink(path)
  }
})

it('目录、断链和 FIFO 会跳过，可读链接保留候选路径', async () => {
  const { root, load } = await fixture()
  await fs.mkdir(join(root, 'AGENTS.override.md'))
  await fs.symlink('missing', join(root, 'AGENTS.md'))
  const target = join(root, 'actual')
  execFileSync('mkfifo', [target])
  const path = join(root, 'CLAUDE.md')
  await fs.symlink(target, path)
  expect((await load()).filter(file => file.path.startsWith(root + '/'))).toEqual([])
  await fs.unlink(target)
  await fs.writeFile(target, '使用 pnpm 检查')
  expect(await load()).toContainEqual({ path, content: '使用 pnpm 检查' })
})

it('打开失败时记录路径和原因，再尝试下一候选', async () => {
  const { root, load } = await fixture()
  const blocked = join(root, 'AGENTS.override.md'), path = join(root, 'AGENTS.md')
  await fs.writeFile(blocked, '不应进入日志的正文')
  await fs.writeFile(path, '先阅读 README.md')
  const { open } = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.open).mockImplementation((candidate, ...args) => candidate === blocked
    ? Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })) : open(candidate, ...args))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(await load()).toContainEqual({ path, content: '先阅读 README.md' })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.join(' ')).toContain(blocked)
  expect(warn.mock.calls[0]?.join(' ')).toContain('EACCES')
  expect(warn.mock.calls[0]?.join(' ')).not.toContain('不应进入日志的正文')
})

it('全局、根和各级祖先依序加入，同路径去重，忽略同级和下级', async () => {
  const { root, load } = await fixture()
  const global = join(root, 'global'), project = join(root, 'project'), cwd = join(project, 'src')
  const dirs = [global, root, project, cwd, join(root, 'another'), join(cwd, 'child')]
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'AGENTS.md'), basename(dir))
  }
  const rootFixture = join(root, 'filesystem-root')
  await fs.writeFile(rootFixture, 'filesystem-root')
  const { stat, open } = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.stat).mockImplementation((path, ...args) => stat(path === '/AGENTS.override.md' ? rootFixture : path, ...args))
  vi.mocked(fs.open).mockImplementation((path, ...args) => open(path === '/AGENTS.override.md' ? rootFixture : path, ...args))
  const files = (await load(cwd, global)).filter(file => file.path === '/AGENTS.override.md' || file.path.startsWith(root + '/'))
  expect(files.map(file => file.content)).toEqual(['global', 'filesystem-root', basename(root), 'project', 'src'])
  expect((await load(cwd, project)).filter(file => file.path === join(project, 'AGENTS.md'))).toHaveLength(1)
})

it('真实嵌套 worktree 遮蔽主工作区同名说明，并保留上一级说明', async () => {
  const { root, load } = await fixture()
  const main = join(root, 'main\ncheckout'), worktree = join(main, 'feature'), cwd = join(worktree, 'src')
  await fs.mkdir(main)
  const git = (...args: string[]) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' })
  git('init', '--quiet')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '--quiet', '-m', 'fixture')
  git('worktree', 'add', '--quiet', '--detach', worktree)
  await fs.mkdir(cwd)
  await fs.writeFile(join(cwd, '.git'), '普通文件，不是 Git 指针')
  await fs.writeFile(join(root, 'AGENTS.md'), '外层')
  await fs.writeFile(join(main, 'AGENTS.md'), 'x'.repeat(2000))
  await fs.writeFile(join(worktree, 'AGENTS.md'), 'worktree')
  const local = async () => (await load(cwd)).filter(file => file.path.startsWith(root + '/')).map(file => file.content)
  expect(await local()).toEqual(['外层', 'worktree'])
  await fs.unlink(join(worktree, 'AGENTS.md'))
  await fs.writeFile(join(main, 'AGENTS.md'), '主工作区')
  expect(await local()).toEqual(['外层', '主工作区'])
})

it('只接受能完整容纳的文件，多个文件共同使用预算', async () => {
  const { root, load } = await fixture()
  const cwd = join(root, 'project')
  await fs.mkdir(cwd)
  await fs.writeFile(join(root, 'AGENTS.md'), 'a'.repeat(40))
  await fs.writeFile(join(cwd, 'AGENTS.md'), 'b'.repeat(40))
  await fs.writeFile(join(cwd, 'CLAUDE.md'), '短候选')
  await expect(load(cwd, undefined, 79)).rejects.toBeInstanceOf(ProjectContextOverflow)
  await expect(load(cwd, undefined, 256)).resolves.toContainEqual({ path: join(cwd, 'AGENTS.md'), content: 'b'.repeat(40) })
})
