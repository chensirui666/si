import { WebServer } from '@agent-learning/server'
import { dirname, join } from 'node:path'

const options = {
  port: Number(process.argv[2]),
  browserSecretPath: process.argv[3],
  modelAuthPath: join(dirname(process.argv[3]), 'auth.json'),
  devOrigin: 'http://127.0.0.1:5173',
  ...(process.env.AGENT_LEARNING_E2E_MODEL_BASE_URL
    ? { modelOptions: { baseURL: process.env.AGENT_LEARNING_E2E_MODEL_BASE_URL } }
    : {}),
}
let server = new WebServer(options)
let closing = false

async function start() {
  const result = await server.start()
  options.port = Number(new URL(result.url).port)
  process.send?.({ type: 'started', result })
}

async function close() {
  if (closing) return
  closing = true
  await server.close()
  process.exit(0)
}

process.on('message', async message => {
  if (message?.type !== 'restart-listener' || closing) return
  try {
    await server.close()
    server = new WebServer(options)
    await start()
  } catch { process.send?.({ type: 'error' }) }
})
process.once('SIGTERM', () => { void close() })
process.once('SIGINT', () => { void close() })
try { await start() } catch { process.send?.({ type: 'error' }); process.exit(1) }
