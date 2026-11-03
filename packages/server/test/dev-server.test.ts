import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

it('实际开发入口监听全部后端依赖并重启，退出释放监听与子进程', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const directory = await mkdtemp(join(tmpdir(), 'agent-dev-'))
  // Watcher checks edit an isolated project copy so tests cannot overwrite a developer's changes.
  await cp(join(root, 'packages'), join(directory, 'packages'), { recursive: true })
  for (const file of ['package.json', 'tsconfig.base.json', 'scripts/dev-server.mjs']) {
    await mkdir(join(directory, file, '..'), { recursive: true })
    await cp(join(root, file), join(directory, file))
  }
  await mkdir(join(directory, 'node_modules/@agent-learning'), { recursive: true })
  for (const name of await readdir(join(root, 'node_modules'))) {
    if (name !== '@agent-learning') await symlink(join(root, 'node_modules', name), join(directory, 'node_modules', name))
  }
  for (const name of ['credentials', 'model', 'agent', 'server']) {
    await symlink(join(directory, 'packages', name), join(directory, 'node_modules/@agent-learning', name))
  }
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as import('node:net').AddressInfo).port
  await new Promise<void>(done => reservation.close(() => done()))
  const child = spawn(process.execPath, ['scripts/dev-server.mjs'], { cwd: directory, env: { ...process.env, AGENT_LEARNING_SERVER_PORT: String(port), AGENT_LEARNING_BROWSER_AUTH_FILE: join(directory, 'private/browser-auth.json'), AGENT_LEARNING_MODEL_AUTH_FILE: join(directory, 'private/auth.json') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 15000
    while (!condition() && child.exitCode === null && Date.now() < deadline) await new Promise(done => setTimeout(done, 50))
    if (!condition()) throw new Error('开发入口未按期启动或响应依赖变化；输出已省略以保护启动令牌。')
  }
  try {
    await waitFor(() => output.includes('打开聊天：'))
    await waitFor(() => output.includes('Watching for file changes'))
    for (const name of ['credentials', 'model', 'agent', 'server']) {
      const file = join(directory, `packages/${name}/src/${name === 'server' ? 'main' : 'index'}.ts`)
      const original = await readFile(file, 'utf8')
      const count = output.split('打开聊天：').length
      await writeFile(file, original + `\n// dev watcher check: ${name}\n`)
      await waitFor(() => output.split('打开聊天：').length > count)
    }
    expect(output).not.toMatch(/error TS\d+/)
  } finally {
    child.kill('SIGTERM')
    const exited = once(child, 'exit')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await exited
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true })
  }
  const probe = createServer()
  probe.listen(port, '127.0.0.1')
  await once(probe, 'listening')
  await new Promise<void>(done => probe.close(() => done()))
}, 90000)
