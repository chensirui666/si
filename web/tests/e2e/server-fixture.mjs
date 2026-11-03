import { WebServer } from '@agent-learning/server'

const options = {
  port: Number(process.argv[2]),
  browserSecretPath: process.argv[3],
  devOrigin: 'http://127.0.0.1:5173',
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
