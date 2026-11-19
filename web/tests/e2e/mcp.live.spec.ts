import { execFile } from 'node:child_process'
import { channel } from 'node:diagnostics_channel'
import { promisify } from 'node:util'
import { readGitHubMcpKey, readLiveKey } from './live-key'
import { expect, test } from './chinese-fixture'
import { authorize } from './test-utils'
import { expectMcpDiscovery, mcpTestServer, mcpTools, observeMcpModelRequests, openMcpSettings, registerMcpServer, runMcpTask, setupMcpChat } from './mcp-test-utils'

const modelKeyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
const gitHubKeyFile = process.env.GITHUB_MCP_LIVE_KEY_FILE
const gitHubEndpoint = 'https://api.githubcopilot.com/mcp/x/issues/readonly'
const notionEndpoint = 'https://mcp.notion.com/mcp'
const notionOrigin = new URL(notionEndpoint).origin

test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function githubIssue(value: string, key: string) {
  const url = new URL(value)
  const match = /^\/([a-z0-9._-]+)\/([a-z0-9._-]+)\/issues\/(\d+)\/?$/i.exec(url.pathname)
  if (url.origin !== 'https://github.com' || url.username || url.password || !match) throw new Error('GITHUB_MCP_ISSUE_URL 需要 GitHub Issue 链接')
  const [, owner, repo, number] = match
  let response: Response
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + key },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
  } catch { throw new Error('独立核对 GitHub Issue 时请求失败') }
  if (!response.ok) throw new Error(`独立核对 GitHub Issue 时返回 HTTP ${response.status}`)
  const issue = await response.json() as { title: string; state: string; html_url: string; pull_request?: unknown }
  if (!issue.title || !['open', 'closed'].includes(issue.state) || !issue.html_url || issue.pull_request) {
    throw new Error('GitHub 返回的 Issue 缺少验收字段')
  }
  return { title: issue.title, state: issue.state, url: issue.html_url, owner, repo, number: Number(number) }
}

async function readSiClientMetadata(baseUrl: string) {
  if (!URL.canParse(baseUrl)) throw new Error('MCP_CLIENT_METADATA_BASE_URL 需要有效的 HTTPS 地址')
  const base = new URL(baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('MCP_CLIENT_METADATA_BASE_URL 需要不含凭据、查询参数和片段的 HTTPS 地址')
  }
  const clientId = `${base.href.replace(/\/$/, '')}/client.json`
  let response: Response
  try { response = await fetch(clientId, { redirect: 'error', signal: AbortSignal.timeout(15_000) }) }
  catch { throw new Error('无法读取 SI 的公开 OAuth 客户端身份文件') }
  if (!response.ok) throw new Error(`SI 的公开 OAuth 客户端身份文件返回 HTTP ${response.status}`)
  const document = await response.json() as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown }
  expect(document.client_id === clientId && document.client_name === 'SI', '身份文件声明自身 HTTPS 地址和 SI 名称').toBe(true)
  return { clientId, redirectUris: document.redirect_uris }
}

function observeNotionOAuth() {
  const requests = channel('undici:request:create')
  const responses = channel('undici:request:headers')
  const evidence = { registrationRequests: 0, tokenStatuses: [] as number[] }
  type Diagnostic = { request: { origin: string; method: string; path: string }; response: { statusCode: number } }
  function onRequest(event: unknown) {
    const { origin, method, path } = (event as Diagnostic).request
    if (origin === notionOrigin && method === 'POST' && path === '/register') evidence.registrationRequests++
  }
  function onResponse(event: unknown) {
    const { request: { origin, method, path }, response } = event as Diagnostic
    if (origin === notionOrigin && method === 'POST' && path === '/token') evidence.tokenStatuses.push(response.statusCode)
  }
  requests.subscribe(onRequest)
  responses.subscribe(onResponse)
  return { evidence, close() {
    requests.unsubscribe(onRequest)
    responses.unsubscribe(onResponse)
  } }
}

test('Feature 5 28/29：网页连接真实 GitHub MCP，由真实模型发现工具并读取 Issue', async ({ page }, info) => {
  test.skip(!gitHubKeyFile, '未提供 GITHUB_MCP_LIVE_KEY_FILE')
  test.setTimeout(240_000)
  const token = await readGitHubMcpKey(gitHubKeyFile!)
  const model = observeMcpModelRequests()
  const backend = await mcpTestServer({ modelOptions: { fetch: model.fetch } })
  try {
    const observed = modelKeyFile
      ? await setupMcpChat(page, backend.authUrl, await readLiveKey(modelKeyFile))
      : undefined
    if (!observed) await authorize(page, backend.authUrl)
    const settings = await openMcpSettings(page)
    await test.step('28 连接后获得远端 Issue 工具', async () => {
      const row = await registerMcpServer(settings, { name: 'github', url: gitHubEndpoint, token })
      const toggle = row.getByRole('switch', { name: '切换 github', exact: true })
      await toggle.click()
      await expect(toggle).toBeChecked({ timeout: 45_000 })
      const toolNames = await mcpTools(page, 'github')
      expect(toolNames).toContain('mcp__github__issue_read')
      await info.attach('case-28-github-connected', {
        contentType: 'application/json',
        body: JSON.stringify({ endpoint: gitHubEndpoint, state: 'connected', toolNames }),
      })
    })
    if (observed) await test.step('29 真实模型调用和 GitHub 原始记录一致', async () => {
      const issue = await githubIssue(process.env.GITHUB_MCP_ISSUE_URL ?? 'https://github.com/github/github-mcp-server/issues/1', token)
      await page.keyboard.press('Escape')
      const first = model.requests.length
      const toolName = 'mcp__github__issue_read'
      const task = await runMcpTask(
        page, observed, `用 GitHub MCP 读取 ${issue.url}。只输出标题、state 字段的英文原值、以及真实链接。`,
        toolName,
      )
      const discovery = expectMcpDiscovery(model.requests.slice(first), task, toolName)
      expect(task.call.arguments).toMatchObject({ owner: issue.owner, repo: issue.repo, issue_number: issue.number })
      expect(task.resultText.includes(issue.title) && task.resultText.includes(issue.url)
        && new RegExp(`"state"\\s*:\\s*"${issue.state}"`).test(task.resultText), '实际 MCP 结果包含独立核对的三个字段').toBe(true)
      expect(task.answerText.includes(issue.title) && task.answerText.includes(issue.url)
        && new RegExp(`\\b${issue.state}\\b`, 'i').test(task.answerText), '最终模型回答包含核对的三个字段').toBe(true)
      await info.attach('case-29-github-issue', {
        contentType: 'application/json',
        body: JSON.stringify({ title: issue.title, state: issue.state, url: issue.url, callId: task.call.id, discovery }),
      })
    })
    else info.annotations.push({ type: 'note', description: '用例 29 需要 DEEPSEEK_LIVE_KEY_FILE，本次验证了用例 28。' })
  } finally {
    await backend.close()
  }
})

test('Feature 5 30：在真实浏览器完成 Notion 授权，由模型发现工具并读取页面', async ({ page }, info) => {
  const url = process.env.NOTION_MCP_PAGE_URL
  const title = process.env.NOTION_MCP_PAGE_TITLE
  test.skip(process.env.NOTION_MCP_INTERACTIVE !== '1' || !url || !title || !modelKeyFile,
    '用例 30 需要 NOTION_MCP_INTERACTIVE=1、真实模型凭据、Notion 测试页 URL 和标题，并用 --headed 启动')
  const useDefaultBrowser = process.platform === 'darwin' && process.env.NOTION_MCP_OPEN_DEFAULT === '1'
  test.skip(!useDefaultBrowser && info.project.use.headless !== false, '用例 30 需要可见的浏览器供用户选择工作区和同意授权')
  test.setTimeout(420_000)
  const pageId = new URL(url!).pathname.match(/([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i)?.[1].replaceAll('-', '')
  if (!pageId) throw new Error('NOTION_MCP_PAGE_URL 需要带有页面编号的 Notion 链接')
  const mcpClientMetadataBaseUrl = process.env.MCP_CLIENT_METADATA_BASE_URL
  const clientMetadata = mcpClientMetadataBaseUrl ? await readSiClientMetadata(mcpClientMetadataBaseUrl) : undefined
  const model = observeMcpModelRequests()
  const backend = await mcpTestServer({ mcpClientMetadataBaseUrl, modelOptions: { fetch: model.fetch } })
  const oauth = observeNotionOAuth()
  try {
    const observed = await setupMcpChat(page, backend.authUrl, await readLiveKey(modelKeyFile!))
    const settings = await openMcpSettings(page)
    if (gitHubKeyFile) {
      const github = await registerMcpServer(settings, { name: 'github', url: gitHubEndpoint, token: await readGitHubMcpKey(gitHubKeyFile) })
      const toggle = github.getByRole('switch', { name: '切换 github', exact: true })
      await toggle.click()
      await expect(toggle).toBeChecked({ timeout: 45_000 })
    }
    const row = await registerMcpServer(settings, { name: 'notion', url: notionEndpoint })
    const toggle = row.getByRole('switch', { name: '切换 notion', exact: true })
    if (useDefaultBrowser) await page.evaluate(() => { window.open = () => null })
    const authorizationRequest = useDefaultBrowser ? undefined : page.context().waitForEvent('request', {
      predicate: request => {
        const url = new URL(request.url())
        return request.isNavigationRequest() && url.origin === notionOrigin && url.searchParams.has('client_id')
      },
      timeout: 30_000,
    })
    const [navigation] = await Promise.all([authorizationRequest, toggle.click()])
    const authorizationLink = row.getByRole('link', { name: '打开授权页', exact: true })
    if (useDefaultBrowser) await expect(authorizationLink).toBeVisible({ timeout: 30_000 })
    const href = navigation?.url() ?? await authorizationLink.getAttribute('href')
    if (!href || !URL.canParse(href)) throw new Error('Notion 授权地址无效')
    const authorizationUrl = new URL(href)
    if (authorizationUrl.origin !== notionOrigin) throw new Error('Notion 授权地址与预期域名不符')
    const callback = new URL('/api/mcp/oauth/callback', backend.url)
    if (clientMetadata) {
      expect(authorizationUrl.searchParams.get('client_id') === clientMetadata.clientId, 'Notion 授权使用 SI 的身份文件地址').toBe(true)
      expect(authorizationUrl.searchParams.get('redirect_uri') === callback.href, '授权使用本次后台监听的回环回调地址').toBe(true)
      const portlessCallback = new URL(callback)
      portlessCallback.port = ''
      expect(Array.isArray(clientMetadata.redirectUris) && clientMetadata.redirectUris.includes(portlessCallback.href),
        'SI 身份文件包含对应的回环回调地址').toBe(true)
    }
    if (useDefaultBrowser) {
      try { await promisify(execFile)('open', [authorizationUrl.href]) }
      catch { throw new Error('无法打开默认浏览器，授权地址已省略') }
      console.log('等待用户在默认浏览器完成 Notion 授权')
    }
    await expect(toggle).toBeChecked({ timeout: 285_000 })
    expect(oauth.evidence.registrationRequests, 'Notion 动态登记请求次数').toBe(clientMetadata ? 0 : 1)
    expect(oauth.evidence.tokenStatuses, 'Notion 换取令牌的 HTTP 状态').toEqual([200])
    await info.attach('case-30-notion-oauth', {
      contentType: 'application/json',
      body: JSON.stringify({
        registration: clientMetadata ? 'CIMD' : 'DCR',
        ...(clientMetadata && { clientId: clientMetadata.clientId, redirectUri: callback.href }),
        ...oauth.evidence,
      }),
    })
    expect(await mcpTools(page, 'notion')).toContain('mcp__notion__notion_fetch')
    await page.keyboard.press('Escape')
    const first = model.requests.length
    const toolName = 'mcp__notion__notion_fetch'
    const task = await runMcpTask(page, observed,
      `用 Notion MCP 读取 ${url}。只根据工具返回的信息回答页面标题和链接。`, toolName)
    const discovery = expectMcpDiscovery(model.requests.slice(first), task, toolName)
    const matches = (value: string) => value.includes(title!)
      && (value.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).some(link => link.replaceAll('-', '').toLowerCase().includes(pageId.toLowerCase()))
    expect(matches(task.resultText), '实际工具结果与指定页面一致').toBe(true)
    expect(matches(task.answerText), '最终模型回答与指定页面一致').toBe(true)
    const estimatedToolTokens = task.usage.at(-1)?.estimatedToolTokens
    if (gitHubKeyFile) expect(estimatedToolTokens).toBeGreaterThan(0)
    await info.attach('case-30-notion-page', {
      contentType: 'application/json',
      body: JSON.stringify({
        title, pageUrlVerified: true, callId: task.call.id,
        githubAlsoEnabled: !!gitHubKeyFile, estimatedToolTokens, discovery,
      }),
    })
  } finally {
    oauth.close()
    await backend.close()
  }
})
