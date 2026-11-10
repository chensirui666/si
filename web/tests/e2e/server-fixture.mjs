import { WebServer } from '@agent-learning/server'
import { dirname, join } from 'node:path'

const options = {
  port: Number(process.argv[2]),
  browserSecretPath: process.argv[3],
  modelAuthPath: join(dirname(process.argv[3]), 'auth.json'),
  ...(process.argv[4] ? { devOrigin: 'http://127.0.0.1:' + process.argv[4] } : {}),
  workspacePath: join(dirname(process.argv[3]), 'workspaces.json'),
  webSettingsPath: join(dirname(process.argv[3]), 'settings.json'),
  directoryPicker: async () => dirname(process.argv[3]),
  ...(process.env.AGENT_LEARNING_E2E_MODEL_BASE_URL
    ? { modelOptions: { baseURL: process.env.AGENT_LEARNING_E2E_MODEL_BASE_URL } }
    : {}),
}
const server = new WebServer(options)
let closing = false

async function start() {
  const result = await server.start()
  process.send?.({ type: 'started', result })
}

async function close() {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}

process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
try { await start() } catch { process.send?.({ type: 'error' }); process.exit(1) }
