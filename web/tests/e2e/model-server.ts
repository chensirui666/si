import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type RequestBody = {
  model: string
  stream: boolean
  messages: { role: string; content: string | null | ContentPart[]; reasoning_content?: string }[]
  thinking: { type: string }
  reasoning_effort: string
  max_tokens: number
  tools?: unknown
}

// 只替换服务商边界，SDK、Agent、HTTP/WS 与页面全部使用生产实现。
export async function startModelServer() {
  const exchanges: {
    path: string | undefined
    authorized: boolean
    authorization?: string
    body: RequestBody
    delta: (delta: Record<string, unknown>) => void
    finish: (reason?: 'stop' | 'tool_calls' | 'length') => void
    closed: boolean
  }[] = []
  const responses = new Set<ServerResponse>()
  let rejected = 0
  let rejectNext = false
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (rejectNext) {
      rejectNext = false
      rejected++
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Invalid message format for this conversation history' } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    response.flushHeaders()
    responses.add(response)
    response.once('close', () => responses.delete(response))
    const id = `controlled-${exchanges.length + 1}`
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      response.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
    }
    const exchange = {
      path: request.url,
      authorized: request.headers.authorization === 'Bearer controlled-stage3-key',
      authorization: request.headers.authorization,
      body: JSON.parse(body) as RequestBody,
      delta: (delta: Record<string, unknown>) => chunk(delta),
      finish: (reason: 'stop' | 'tool_calls' | 'length' = 'stop') => {
        chunk({}, reason)
        response.write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [],
          usage: { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 },
        })}\n\ndata: [DONE]\n\n`)
        response.end()
      },
      closed: false,
    }
    response.once('close', () => { exchange.closed = true })
    exchanges.push(exchange)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('受控模型服务未能取得端口')
  return {
    exchanges,
    get rejected() { return rejected },
    rejectHistory() { rejectNext = true },
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      for (const response of responses) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
