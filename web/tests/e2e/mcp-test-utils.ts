import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebServer, type WebServerOptions } from '@agent-learning/server'
import type { McpServerView } from '@agent-learning/server/protocol'
import type { ToolCall } from '@agent-learning/model'
import { expect, type Page } from './chinese-fixture'
import { addWorkspace, authorize, observe, saveKey, seedSession } from './test-utils'

export type McpModelRequest = {
  messages: { role: string; content?: string | null; tool_call_id?: string }[]
  tools?: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[]
}

export function observeMcpModelRequests(fetcher: typeof fetch = globalThis.fetch) {
  const requests: McpModelRequest[] = []
  const capture: typeof fetch = (input, options) => {
    if (typeof options?.body === 'string' && !options.body.includes('你是会话标题生成器。')) {
      requests.push(JSON.parse(options.body))
    }
    return fetcher(input, options)
  }
  return { requests, fetch: capture }
}

export function declaredToolNames(request: McpModelRequest) {
  return (request.tools ?? []).map(tool => tool.function.name)
}

export async function mcpTestServer(options: Pick<WebServerOptions, 'modelOptions' | 'mcpClientMetadataBaseUrl'> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'si-mcp-e2e-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const server = new WebServer({
    port: 0, directoryPicker: async () => cwd, globalContextDirectory: root, skillHome: join(root, 'home'),
    extensionsDirectory: join(root, 'extensions'), mcpConfigDirectory: join(root, 'mcp'),
    browserSecretPath: join(root, 'browser.json'), modelAuthPath: join(root, 'auth.json'),
    sessionPath: join(root, 'sessions.sqlite'), workspacePath: join(root, 'workspaces.json'),
    webSettingsPath: join(root, 'settings.json'), ...options,
  })
  try {
    const entry = await server.start()
    return { ...entry, async close() {
      try { await server.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    } }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export async function openMcpSettings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置', exact: true })
  await settings.getByRole('button', { name: 'MCP', exact: true }).click()
  return settings
}

export async function registerMcpServer(settings: Awaited<ReturnType<typeof openMcpSettings>>, config: {
  name: string; url: string; token?: string
}) {
  await settings.getByRole('button', { name: '添加服务' }).click()
  await settings.getByLabel('服务名称').fill(config.name)
  await settings.getByLabel('服务地址').fill(config.url)
  if (config.token !== undefined) {
    try { await settings.getByLabel('访问令牌', { exact: true }).fill(config.token) }
    catch { throw new Error('访问令牌输入失败，内容已省略') }
  } else {
    await settings.getByRole('combobox', { name: '授权方式' }).click()
    await settings.page().getByRole('option', { name: '浏览器 OAuth', exact: true }).click()
  }
  await settings.getByRole('button', { name: '保存', exact: true }).click()
  const row = settings.getByRole('article', { name: config.name, exact: true })
  await expect(row.getByRole('switch', { name: `切换 ${config.name}`, exact: true })).not.toBeChecked()
  return row
}

export async function mcpTools(page: Page, name: string) {
  const response = await page.request.get(new URL('/api/mcp/servers', page.url()).href)
  expect(response.ok()).toBe(true)
  const { servers } = await response.json() as { servers: McpServerView[] }
  return servers.find(server => server.name === name)?.tools.map(tool => tool.name)
}

export async function setupMcpChat(page: Page, authUrl: string, modelKey: string) {
  const observed = observe(page)
  await authorize(page, authUrl)
  const workspaceId = await addWorkspace(page)
  await saveKey(page, modelKey)
  await seedSession(page, observed, workspaceId)
  return observed
}

export async function runMcpTask(page: Page, observed: ReturnType<typeof observe>, prompt: string, toolName: string, outcome: 'ok' | 'error' = 'ok') {
  const first = observed.updates.length
  const startedAt = Date.now()
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt)
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/messages')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await accepted).status()).toBe(202)
  await expect.poll(() => observed.updates.slice(first).some(({ update: { change } }) =>
    change.type === 'task' && change.running === null), { timeout: 150_000 }).toBe(true)
  const updates = observed.updates.slice(first).map(({ update }) => update)
  const changes = updates.map(update => update.change)
  const rounds = updates.flatMap(({ change, contextUsage }) => change.type === 'model' && change.event.type === 'done'
    ? [{ message: change.event.message, estimatedToolTokens: contextUsage?.breakdown.toolsTokens }] : [])
  const allCalls = rounds.flatMap(({ message }) => message.content).filter((block): block is ToolCall => block.type === 'toolCall')
  const calls = allCalls.filter(call => call.name === toolName)
  expect(calls.length, '模型发出 MCP 工具调用').toBeGreaterThan(0)
  const results = changes.flatMap(change => change.type === 'task' && change.message?.message.role === 'toolResult'
    ? [change.message.message] : [])
  const paired = results.flatMap(result => {
    const call = calls.find(item => item.id === result.toolCallId)
    return call && result.isError === (outcome === 'error') ? [{ call, result }] : []
  }).at(-1)
  expect(!!paired, '按原调用编号收到预期的工具结果').toBe(true)
  const answer = rounds.at(-1)?.message
  expect(answer?.stopReason).toBe('stop')
  const resultText = paired!.result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const answerText = answer!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const cards = page.locator('.tool-block').filter({ hasText: toolName })
  const process = page.locator('.process-group').filter({ has: cards }).last()
  if (await process.getAttribute('open') === null) await process.locator(':scope > summary').click()
  const card = process.locator('.tool-block').filter({ hasText: toolName }).last()
  await expect(card.locator(`[data-state="${outcome}"]`)).toBeVisible()
  await card.locator('summary').click()
  await expect(card.locator('.tool-result')).toBeVisible()
  return {
    ...paired!, resultText, answerText, calls: allCalls, results,
    millisecondsToMcpResult: paired!.result.timestamp - startedAt,
    usage: rounds.map(({ message, estimatedToolTokens }) => ({ inputTokens: message.usage?.input, estimatedToolTokens })),
  }
}

export function expectMcpDiscovery(requests: McpModelRequest[], task: Awaited<ReturnType<typeof runMcpTask>>, toolName: string) {
  expect(requests.length, '捕获到带搜索和远端调用的模型请求').toBeGreaterThanOrEqual(3)
  const firstNames = declaredToolNames(requests[0])
  expect(firstNames).toContain('tool_search')
  expect(firstNames.filter(name => name.startsWith('mcp__'))).toEqual([])

  const next = requests.findIndex(request => declaredToolNames(request).includes(toolName))
  expect(next, '命中工具从后续请求开始可调用').toBeGreaterThan(0)
  const searchesBeforeCall = task.calls.slice(0, task.calls.indexOf(task.call)).filter(call => call.name === 'tool_search')
  const successfulSearch = searchesBeforeCall.find(search => task.results.some(result =>
    result.toolCallId === search.id && !result.isError && result.content.some(block => block.type === 'text' && block.text.includes(toolName))))
  expect(!!successfulSearch, '真实远端调用之前完成了命中该工具的搜索').toBe(true)
  expect(requests[next].messages.some(message => message.role === 'tool' && message.tool_call_id === successfulSearch!.id),
    '首次带远端工具定义的请求包含对应搜索结果').toBe(true)
  expect(requests[next].tools?.find(tool => tool.function.name === toolName)).toMatchObject({
    type: 'function', function: { name: toolName, description: expect.any(String), parameters: expect.any(Object) },
  })
  return { searchCallId: successfulSearch!.id, firstToolCount: firstNames.length, firstMcpToolCount: 0,
    disclosedMcpToolCount: declaredToolNames(requests[next]).filter(name => name.startsWith('mcp__')).length,
    requestCount: requests.length, millisecondsToMcpResult: task.millisecondsToMcpResult, usage: task.usage }
}
