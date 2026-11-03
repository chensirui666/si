import { WebServer } from './webserver/index.js'

const portText = process.env.AGENT_LEARNING_SERVER_PORT ?? '3000'
const port = Number(portText)
if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('启动失败：AGENT_LEARNING_SERVER_PORT 必须为 1–65535 的端口。')
  process.exitCode = 1
} else {
  const server = new WebServer({ port, browserSecretPath: process.env.AGENT_LEARNING_BROWSER_AUTH_FILE, ...(process.argv.includes('--dev') ? { devOrigin: 'http://127.0.0.1:5173' as const } : {}) })
  try {
    const started = await server.start()
    console.log(`打开聊天：${started.authUrl}`)
    if (started.devAuthUrl) console.log(`开发入口：${started.devAuthUrl}`)
    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      void server.close().catch(() => { console.error('退出时资源清理失败。'); process.exitCode = 1 })
    }
    process.on('SIGINT', close)
    process.on('SIGTERM', close)
  } catch (error) {
    console.error(error instanceof Error ? error.message : '服务启动失败。')
    process.exitCode = 1
  }
}
