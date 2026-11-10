import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const packages = ['credentials', 'model', 'agent', 'coding-agent', 'server'].map(name => `packages/${name}`)
const children = [
  spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-b', '--watch', '--preserveWatchOutput', ...packages], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', ...packages.map(path => `--watch-path=${path}/dist`), 'packages/server/dist/main.js', '--dev'], { stdio: 'inherit' }),
]
let closing = false
function close(code = 0) {
  if (closing) return
  closing = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}
for (const child of children) {
  child.on('error', () => close(1))
  child.on('exit', code => close(code ?? 1))
}
process.on('SIGINT', () => close())
process.on('SIGTERM', () => close())
