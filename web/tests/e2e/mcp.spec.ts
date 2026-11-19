import { createHash } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { expect, test } from './chinese-fixture'
import { authorize } from './test-utils'
import { declaredToolNames, expectMcpDiscovery, mcpTestServer, mcpTools, observeMcpModelRequests, openMcpSettings, registerMcpServer, runMcpTask, setupMcpChat, type McpModelRequest } from './mcp-test-utils'

test('MCP 网页按需披露、目录刷新和掉线恢复，依照调用编号回填结果', async ({ page, context }) => {
  const methods: string[] = []
  const toolArguments: unknown[] = []
  const explicitToggles: unknown[] = []
  context.on('request', request => {
    if (request.method() === 'PUT' && /^\/api\/mcp\/servers\/[^/]+\/enabled$/.test(new URL(request.url()).pathname)) {
      explicitToggles.push(request.postDataJSON())
    }
  })
  let releaseToolList = () => {}
  const toolList = new Promise<void>(resolve => { releaseToolList = resolve })
  let releaseRecovery = () => {}
  const recovery = new Promise<void>(resolve => { releaseRecovery = resolve })
  let connection: 'accept' | 'hold' | 'refuse' = 'accept'
  let eventStream: ServerResponse | undefined
  const toolName = 'mcp__github__issue_read'
  const repoName = 'mcp__github__repo_list'
  const originalSchema = { type: 'object', properties: { issue_number: { type: 'number' } }, required: ['issue_number'] }
  const updatedSchema = { type: 'object', properties: { issue_number: { type: 'number' }, format: { type: 'string' } },
    required: ['issue_number', 'format'] }
  const repo = { name: 'repo_list', description: 'List repositories', inputSchema: { type: 'object' } }
  const initialIssue = { name: 'issue_read', description: 'Read issue', inputSchema: originalSchema }
  const updatedIssue = { name: 'issue_read', description: 'Read issue in the selected format', inputSchema: updatedSchema }
  let tools = [initialIssue, repo]
  const remoteResult = (issueNumber: number) => `实际 MCP 端点返回的 Issue ${issueNumber}`
  const remote = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fake-mcp-token') { res.writeHead(401).end(); return }
    if (req.method === 'GET') {
      eventStream = res
      res.on('close', () => { if (eventStream === res) eventStream = undefined })
      res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': connected\n\n')
      return
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const { id, method, params } = JSON.parse(body)
    methods.push(method)
    if (method === 'notifications/initialized') { res.writeHead(202).end(); return }
    let result: unknown
    if (method === 'initialize') {
      if (connection === 'refuse') { res.writeHead(503).end(); return }
      if (connection === 'hold') await recovery
      result = {
        protocolVersion: params.protocolVersion, serverInfo: { name: 'github-fixture', version: '1' },
        capabilities: { tools: { listChanged: true } }, instructions: 'Work with GitHub issues.\nOnly the first line should appear.',
      }
    }
    if (method === 'tools/list') {
      await toolList
      result = { tools }
    }
    if (method === 'tools/call') {
      toolArguments.push(params)
      const issueNumber = params.arguments.issue_number
      if ([8, 10].includes(issueNumber)) { req.socket.destroy(); return }
      result = { content: [{ type: 'text', text: remoteResult(issueNumber) }] }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  let backend: Awaited<ReturnType<typeof mcpTestServer>> | undefined
  try {
    const model = observeMcpModelRequests(async (_url, options) => {
      if (String(options?.body).includes('你是会话标题生成器。')) return new Response('', { status: 400 })
      const body = JSON.parse(String(options?.body)) as McpModelRequest
      const lastMessage = body.messages.at(-1)
      const issueNumber = Number(body.messages.slice().reverse().find(message => message.role === 'user')?.content?.match(/Issue (\d+)/)?.[1])
      const selected = body.tools?.find(tool => tool.function.name === toolName)
      const afterSearch = lastMessage?.tool_call_id === `search-${issueNumber}`
      let delta: { content: string } | { tool_calls: { index: number; id: string; type: 'function'; function: { name: string; arguments: string } }[] }
      if (lastMessage?.role === 'user' && !selected) {
        delta = { tool_calls: [{ index: 0, id: `search-${issueNumber}`, type: 'function',
          function: { name: 'tool_search', arguments: JSON.stringify({ query: 'issue_read', limit: 1 }) } }] }
      } else if (lastMessage?.role === 'user' || afterSearch) {
        const format = (selected?.function.parameters.required as string[] | undefined)?.includes('format') ? { format: 'short' } : {}
        delta = { tool_calls: [{ index: 0, id: `issue-${issueNumber}`, type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ issue_number: issueNumber, ...format }) } }] }
      } else {
        delta = { content: `模型读取到：${lastMessage?.content}` }
      }
      const chunk = { id: 'test', model: 'deepseek-flash', created: 1, choices: [{ index: 0, delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const requests = model.requests
    backend = await mcpTestServer({ modelOptions: { fetch: model.fetch } })
    const observed = await setupMcpChat(page, backend.authUrl, 'fixture-model-key')
    const peer = await context.newPage()
    await peer.goto(backend.url)
    await expect(peer.locator('.chat-page')).toHaveAttribute('data-connection', 'ready')
    const peerSettings = await openMcpSettings(peer)
    const settings = await openMcpSettings(page)
    const { port } = remote.address() as { port: number }
    const row = await registerMcpServer(settings, { name: 'github', url: `http://127.0.0.1:${port}/mcp`, token: 'fake-mcp-token' })
    const peerRow = peerSettings.getByRole('article', { name: 'github', exact: true })
    const toggle = row.getByRole('switch', { name: '切换 github', exact: true })
    const peerToggle = peerRow.getByRole('switch', { name: '切换 github', exact: true })
    await expect(peerToggle).not.toBeChecked()
    expect(methods).toHaveLength(0)

    await row.getByRole('button', { name: '更多操作', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '编辑', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await toggle.click()
    await expect.poll(() => methods.includes('tools/list')).toBe(true)
    await expect(toggle).not.toBeChecked()
    await expect(peerToggle).not.toBeChecked()
    releaseToolList()
    await expect(toggle).toBeChecked()
    await expect(peerToggle).toBeChecked()

    await page.keyboard.press('Escape')
    const task = await runMcpTask(page, observed, '读取 Issue 7', toolName)
    expect(toolArguments).toEqual([{ name: 'issue_read', arguments: { issue_number: 7 } }])
    expect(task.resultText).toContain(remoteResult(7))
    expect(task.answerText).toContain(remoteResult(7))
    expect(requests).toHaveLength(3)
    const discovery = expectMcpDiscovery(requests, task, toolName)
    const searchText = requests[1].messages.find(message => message.tool_call_id === discovery.searchCallId)?.content
    expect(searchText).toContain(`- ${toolName}: ${initialIssue.description}`)
    expect(searchText).not.toContain('issue_number')
    const system = requests[0].messages.find(message => message.role === 'system')?.content
    expect(system).toContain('Work with GitHub issues.')
    expect(system).not.toContain('Only the first line')
    expect(system).not.toContain(toolName)
    expect(declaredToolNames(requests[1]).filter(name => name.startsWith('mcp__'))).toEqual([toolName])
    expect(requests[1].tools?.find(tool => tool.function.name === toolName)).toEqual({
      type: 'function', function: { name: toolName, description: initialIssue.description, parameters: originalSchema },
    })
    expect(requests[2]).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: task.call.id, content: expect.stringContaining(remoteResult(7)) })]) })

    const announceToolsChanged = () => {
      eventStream!.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n')
    }
    await expect.poll(() => !!eventStream).toBe(true)
    tools = [updatedIssue, repo, { ...repo, name: 'label_list', description: 'List labels' }]
    announceToolsChanged()
    await expect.poll(() => mcpTools(page, 'github')).toEqual([toolName, repoName, 'mcp__github__label_list'])
    const beforeHotUpdate = requests.length
    const updated = await runMcpTask(page, observed, '读取 Issue 11', toolName)
    expect(updated.calls.map(call => call.name)).toEqual([toolName])
    expect(requests[beforeHotUpdate].tools?.find(tool => tool.function.name === toolName)).toEqual({
      type: 'function', function: { name: toolName, description: updatedIssue.description, parameters: updatedSchema },
    })
    expect(updated.call.arguments).toEqual({ issue_number: 11, format: 'short' })

    tools = [repo]
    announceToolsChanged()
    await expect.poll(() => mcpTools(page, 'github')).toEqual([repoName])
    tools = [updatedIssue, repo]
    announceToolsChanged()
    await expect.poll(() => mcpTools(page, 'github')).toEqual([toolName, repoName])
    const beforeReappearing = requests.length
    const rediscovered = await runMcpTask(page, observed, '读取 Issue 12', toolName)
    expectMcpDiscovery(requests.slice(beforeReappearing), rediscovered, toolName)
    expect(methods.filter(method => method === 'initialize')).toHaveLength(1)

    const priorDiscoveries = methods.filter(method => method === 'tools/list').length
    connection = 'hold'
    const interrupted = await runMcpTask(page, observed, '读取 Issue 8', toolName, 'error')
    expect(interrupted.resultText).toContain('The remote MCP tool result is unknown')
    await expect.poll(() => methods.filter(method => method === 'initialize').length).toBe(2)
    await openMcpSettings(page)
    await expect(toggle).toBeChecked()
    await expect(peerToggle).toBeChecked()
    connection = 'accept'
    releaseRecovery()
    await expect.poll(() => methods.filter(method => method === 'tools/list').length).toBe(priorDiscoveries + 1)
    await page.keyboard.press('Escape')
    const recovered = await runMcpTask(page, observed, '读取 Issue 9', toolName)
    expect(recovered.resultText).toContain(remoteResult(9))
    expect(recovered.calls.map(call => call.name)).toEqual([toolName])
    const callArguments = (issue_number: number) => ({ name: 'issue_read', arguments: {
      issue_number, ...(issue_number === 7 ? {} : { format: 'short' }),
    } })
    expect(toolArguments).toEqual([7, 11, 12, 8, 9].map(callArguments))

    await peerToggle.click()
    await expect(peerToggle).not.toBeChecked()
    await openMcpSettings(page)
    await expect(toggle).not.toBeChecked()
    expect(await mcpTools(page, 'github')).toEqual([])
    await peerToggle.click()
    await expect(toggle).toBeChecked()
    await expect(peerToggle).toBeChecked()
    expect(explicitToggles).toEqual([{ enabled: true }, { enabled: false }, { enabled: true }])

    connection = 'refuse'
    await page.keyboard.press('Escape')
    const beforeReenabling = requests.length
    const finalAttempt = await runMcpTask(page, observed, '读取 Issue 10', toolName, 'error')
    expect(finalAttempt.calls.map(call => call.name)).toEqual([toolName])
    expect(declaredToolNames(requests[beforeReenabling])).toContain(toolName)
    await expect.poll(() => methods.filter(method => method === 'initialize').length).toBeGreaterThan(3)
    await expect(peerToggle).not.toBeChecked({ timeout: 15_000 })
    await openMcpSettings(page)
    await expect(toggle).not.toBeChecked()
    expect(await mcpTools(page, 'github')).toEqual([])
    expect(toolArguments).toEqual([7, 11, 12, 8, 9, 10].map(callArguments))
  } finally {
    releaseToolList()
    releaseRecovery()
    eventStream?.destroy()
    try { await backend?.close() }
    finally { await new Promise<void>(resolve => remote.close(() => resolve())) }
  }
})

for (const registration of ['DCR', 'CIMD'] as const) test(`MCP 从开关开始 ${registration} 授权，经真实 Chromium 完成回调并同步两个标签页`, async ({ page, context }) => {
  const mcpClientMetadataBaseUrl = registration === 'CIMD' ? 'https://si.example.test/oauth' : undefined
  const clientId = mcpClientMetadataBaseUrl ? `${mcpClientMetadataBaseUrl}/client.json` : 'fixture-client'
  let origin: string
  let callback: string
  let challenge: string | null
  let registrations = 0
  let exchanges = 0
  let discoveries = 0
  let eventStream: ServerResponse | undefined
  let revoked = false
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url!, origin)
    const json = (value: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    let body = ''
    for await (const chunk of req) body += chunk
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ['code'],
        token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
      })
    }
    if (url.pathname === '/register') {
      registrations++
      return json({ ...JSON.parse(body), client_id: 'fixture-client' })
    }
    if (url.pathname === '/authorize') {
      const params = url.searchParams
      const destination = new URL(params.get('redirect_uri')!)
      destination.search = new URLSearchParams({ state: params.get('state')!, code: 'fixture-code', iss: origin }).toString()
      challenge = params.get('code_challenge')
      callback = destination.href
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(`<!doctype html><a href="${callback.replaceAll('&', '&amp;')}">同意授权</a>`)
    }
    if (url.pathname === '/token') {
      exchanges++
      const params = new URLSearchParams(body)
      const actualChallenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
      if (params.get('code') !== 'fixture-code' || params.get('client_id') !== clientId || actualChallenge !== challenge
        || params.get('redirect_uri') !== callback.split('?')[0]) return res.writeHead(400).end()
      return json({ access_token: 'fixture-authorized', token_type: 'Bearer' })
    }
    if (url.pathname !== '/mcp' || (req.method !== 'POST' && !(registration === 'DCR' && req.method === 'GET'))) {
      return res.writeHead(405).end()
    }
    if (revoked || req.headers.authorization !== 'Bearer fixture-authorized') {
      return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end()
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).write(': connected\n\n')
      eventStream = res
      return
    }
    const { id, method, params } = JSON.parse(body)
    const reply = (result: unknown) => json({ jsonrpc: '2.0', id, result })
    if (method === 'initialize') return reply({
      protocolVersion: params.protocolVersion, serverInfo: { name: 'notion-fixture', version: '1' }, capabilities: { tools: {} },
    })
    if (method === 'tools/list') {
      discoveries++
      return reply({ tools: [{ name: 'notion-fetch', inputSchema: { type: 'object' } }] })
    }
    return res.writeHead(202).end()
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(remote.address() as { port: number }).port}`
  let backend: Awaited<ReturnType<typeof mcpTestServer>> | undefined
  try {
    backend = await mcpTestServer({ mcpClientMetadataBaseUrl })
    await authorize(page, backend.authUrl)
    const peer = await context.newPage()
    await peer.goto(backend.url)
    await expect(peer.locator('.chat-page')).toHaveAttribute('data-connection', 'ready')
    const settings = await openMcpSettings(page)
    const peerSettings = await openMcpSettings(peer)
    const row = await registerMcpServer(settings, { name: 'notion', url: `${origin}/mcp` })
    const peerRow = peerSettings.getByRole('article', { name: 'notion', exact: true })
    const toggle = row.getByRole('switch', { name: '切换 notion', exact: true })
    const peerToggle = peerRow.getByRole('switch', { name: '切换 notion', exact: true })
    const fallback = row.getByRole('link', { name: '打开授权页', exact: true })
    const popupBlocked = registration === 'CIMD'
    if (popupBlocked) await page.evaluate(() => { window.open = () => null })
    let opened = popupBlocked ? undefined : context.waitForEvent('page')
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(peerToggle).not.toBeChecked()
    await expect(peerRow.getByRole('link', { name: '打开授权页', exact: true })).toHaveCount(0)
    if (popupBlocked) {
      await expect(fallback).toBeVisible()
      await expect(row.getByRole('button', { name: '取消授权', exact: true })).toBeVisible()
      expect(context.pages()).toHaveLength(2)
      opened = context.waitForEvent('page')
      await fallback.click()
    }
    const popup = await opened!
    await expect(popup.getByRole('link', { name: '同意授权' })).toBeVisible()
    if (!popupBlocked) {
      await expect(fallback).toHaveCount(0)
      await expect(row.getByRole('button', { name: '取消授权', exact: true })).toHaveCount(0)
    }
    expect(new URL(popup.url()).searchParams.get('client_id')).toBe(clientId)
    expect(await popup.evaluate(() => window.opener === null)).toBe(true)
    await popup.getByRole('link', { name: '同意授权' }).click()
    await expect(popup).toHaveURL(url => url.origin === new URL(backend!.url).origin && (mcpClientMetadataBaseUrl
      ? url.pathname === '/api/mcp/oauth/callback' : url.pathname.startsWith('/api/mcp/oauth/callback/')))
    await expect(toggle).toBeChecked()
    await expect(peerToggle).toBeChecked()
    await expect(fallback).toHaveCount(0)
    expect(await mcpTools(page, 'notion')).toEqual(['mcp__notion__notion_fetch'])
    expect([registrations, exchanges, discoveries]).toEqual([mcpClientMetadataBaseUrl ? 0 : 1, 1, 1])
    expect(context.pages()).toHaveLength(3)
    if (registration === 'DCR') {
      await expect.poll(() => !!eventStream).toBe(true)
      revoked = true
      eventStream!.destroy()
      await expect(toggle).not.toBeChecked()
      await expect(peerToggle).not.toBeChecked()
      await expect(fallback).toHaveCount(0)
      expect(await mcpTools(page, 'notion')).toEqual([])
      expect(context.pages()).toHaveLength(3)
      expect([registrations, exchanges, discoveries]).toEqual([1, 1, 1])
    }
  } finally {
    eventStream?.destroy()
    try { await backend?.close() }
    finally { await new Promise<void>(resolve => remote.close(() => resolve())) }
  }
})
