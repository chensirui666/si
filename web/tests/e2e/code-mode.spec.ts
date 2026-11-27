import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { McpClient } from '@agent-learning/mcp'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './chinese-fixture'
import { readLiveKey } from './live-key'
import { declaredToolNames, mcpTestServer, observeMcpModelRequests, openMcpSettings, registerMcpServer, setupMcpChat } from './mcp-test-utils'
import { startModelServer } from './model-server'
import { addWorkspace, authorize, observe, ready, saveKey, seedSession, startBackend, stop } from './test-utils'

const modelKeyFile = process.env.DEEPSEEK_LIVE_KEY_FILE
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: '消息', exact: true }).fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
}

test('Feature 13 受控模型从真实 Node 入口运行脚本，刷新后可查看 SQLite 保存的父子记录', async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'si-codemode-e2e-'))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    await writeFile(join(cwd, 'current.md'), '仅返回这行\n不要回填这一行')
    await writeFile(join(cwd, 'old.md'), '旧文件')
    backend = await startBackend(join(cwd, 'browser-auth.json'), 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, 'controlled-codemode-key')
    await send(page, '选中当前文件')
    await expect.poll(() => provider.exchanges.length).toBe(1)
    const first = provider.exchanges[0]!
    expect(declaredToolNames(first.body as Parameters<typeof declaredToolNames>[0])).toEqual(expect.arrayContaining(['codemode', 'read', 'write']))
    const code = 'const p = (await tools.find({pattern:"*.md"})).split("\\n").find(p=>p.startsWith("current")); return (await tools.read({path:p})).split("\\n")[0]'
    first.delta({ tool_calls: [{ index: 0, id: 'script', type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] })
    first.finish('tool_calls')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    expect(provider.exchanges[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'script', content: '仅返回这行' })
    provider.exchanges[1]!.delta({ content: '已确认当前文件' })
    provider.exchanges[1]!.finish()
    await expect(page.getByText('已确认当前文件', { exact: true })).toBeVisible()
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    await page.locator('.process-group > summary').first().click()
    const children = page.locator('.nested-tool-calls .tool-block')
    await expect(children).toHaveCount(2)
    await expect(children.nth(0).locator('[data-state="ok"]')).toBeVisible()
    await expect(children.nth(1).locator('summary')).toContainText('current.md')
    await children.nth(1).locator('summary').click()
    await expect(children.nth(1).locator('.tool-result')).toContainText('仅返回这行')
  } finally {
    await stop(backend?.child)
    await provider.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Feature 13 14 后端在写入后被杀掉，重启显示结果未知并交回实际目标', async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'si-codemode-crash-'))
  const secret = join(cwd, 'browser-auth.json')
  const target = join(cwd, 'notes.txt')
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined
  try {
    const extensions = join(cwd, 'global-context', 'extensions')
    await mkdir(extensions, { recursive: true })
    await writeFile(target, 'before')
    await writeFile(join(extensions, 'pause.ts'), `
      export default si => si.on('tool_result', event => {
        if (event.toolName === 'write') return new Promise(() => {});
      });
    `)
    backend = await startBackend(secret, 0, provider.baseURL)
    const observed = observe(page)
    await authorize(page, backend.result.authUrl)
    const sessionId = await seedSession(page, observed, await addWorkspace(page))
    await saveKey(page, 'controlled-codemode-crash')
    await send(page, '用程序修改文件')
    await expect.poll(() => provider.exchanges.length).toBe(1)
    provider.exchanges[0]!.delta({ tool_calls: [{
      index: 0, type: 'function', id: 'program-crash', function: {
        name: 'codemode', arguments: JSON.stringify({ code: 'return await tools.write({path:"notes.txt",content:"after"});' }),
      },
    }] })
    provider.exchanges[0]!.finish('tool_calls')
    await expect.poll(() => readFile(target, 'utf8')).toBe('after')
    await expect(page.locator('.nested-tool-calls [data-state="running"]')).toBeVisible()
    const port = Number(new URL(backend.result.url).port)
    await stop(backend.child, 'SIGKILL')
    expect(backend.child.signalCode).toBe('SIGKILL')
    backend = await startBackend(secret, port, provider.baseURL)
    const before = observed.snapshots.length
    await page.reload()
    await ready(page, observed, before, false)
    expect(observed.snapshots.at(-1)).toMatchObject({
      sessionId, snapshot: { running: null, nestedToolCalls: [
        { id: 'program-crash/1', status: 'unknown', argumentsPreview: { path: 'notes.txt' } },
      ] },
    })
    await page.locator('.process-group > summary').first().click()
    await expect(page.locator('.nested-tool-calls summary')).toContainText('notes.txt')
    await expect(page.locator('.nested-tool-calls [data-state="unknown"]')).toBeVisible()
    await send(page, '续做前核对文件')
    await expect.poll(() => provider.exchanges.length).toBe(2)
    const followup = provider.exchanges[1]!
    expect(followup.body.messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'program-crash',
      content: expect.stringMatching(/结果未知[\s\S]*"status":"unknown","target":"notes\.txt"/),
    }))
    followup.delta({ content: '先核对 notes.txt 的实际内容' })
    followup.finish()
    await expect(page.getByText('先核对 notes.txt 的实际内容', { exact: true })).toBeVisible()
    expect(await readFile(target, 'utf8')).toBe('after')
  } finally {
    await stop(backend?.child)
    await provider.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Feature 13 16/17 同次执行发现 MCP，停用服务后旧绑定无法发送', async ({ page }) => {
  const received: unknown[] = []
  const remote = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const { id, method, params } = JSON.parse(body)
    if (method === 'notifications/initialized') { response.writeHead(202).end(); return }
    let result: unknown
    if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1' } }
    if (method === 'tools/list') result = { tools: [{ name: 'lookup_ticket', description: 'Read a ticket by id',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    }] }
    if (method === 'tools/call') {
      received.push(params)
      result = { content: [{ type: 'text', text: 'T-42: active' }] }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const provider = await startModelServer()
  let backend: Awaited<ReturnType<typeof mcpTestServer>> | undefined
  try {
    backend = await mcpTestServer({ modelOptions: { baseURL: provider.baseURL } })
    const observed = await setupMcpChat(page, backend.authUrl, 'controlled-tracker-key')
    const endpoint = `http://127.0.0.1:${(remote.address() as { port: number }).port}/mcp`
    const settings = await openMcpSettings(page)
    const row = await registerMcpServer(settings, { name: 'tracker', url: endpoint, token: 'controlled-tracker' })
    const toggle = row.getByRole('switch', { name: '切换 tracker', exact: true })
    await toggle.click()
    await expect(toggle).toBeChecked()
    await page.keyboard.press('Escape')
    for (const pause of [false, true]) {
      const offset = provider.exchanges.length
      await send(page, '查询工单 T-42')
      await expect.poll(() => provider.exchanges.length).toBe(offset + 1)
      const code = `
        const [{name}] = await searchTools("lookup_ticket");
        const schema = await describeTool(name);
        if (!schema.inputSchema.required.includes("id")) throw Error("missing id");
        ${pause ? 'await tools.bash({command:"while [ ! -f release ]; do sleep 0.05; done",timeout:30});' : ''}
        try { return await tools[name]({id:"T-42"}); } catch (error) { return error.message; }
      `
      const first = provider.exchanges[offset]!
      const id = 'tracker-' + offset
      first.delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'codemode', arguments: JSON.stringify({ code }) } }] })
      first.finish('tool_calls')
      if (pause) {
        await expect.poll(() => observed.updates.some(({ update: { change } }) => change.type === 'nested-tool'
          && change.record.name === 'bash' && change.record.id.startsWith(id + '/') && change.record.status === 'running')).toBe(true)
        await openMcpSettings(page)
        await toggle.click()
        await expect(toggle).not.toBeChecked()
        await page.keyboard.press('Escape')
        await writeFile(join(backend.cwd, 'release'), '')
      }
      await expect.poll(() => provider.exchanges.length).toBe(offset + 2)
      const followup = provider.exchanges[offset + 1]!
      expect(followup.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: id,
        content: expect.stringContaining(pause ? '当前不可用' : 'T-42: active'),
      })
      const tool = 'mcp__tracker__lookup_ticket'
      for (const exchange of [first, followup]) {
        expect(declaredToolNames(exchange.body as Parameters<typeof declaredToolNames>[0])).not.toContain(tool)
      }
      expect(observed.updates.some(({ update: { change } }) => change.type === 'nested-tool'
        && change.record.name === tool && change.record.id.startsWith(id + '/')
        && change.record.status === (pause ? 'not-executed' : 'succeeded'))).toBe(true)
      followup.delta({ content: pause ? '停用后没有查询' : 'T-42 当前有效' })
      followup.finish()
      await expect(page.getByText(pause ? '停用后没有查询' : 'T-42 当前有效', { exact: true })).toBeVisible()
    }
    expect(received).toEqual([{ name: 'lookup_ticket', arguments: { id: 'T-42' } }])
  } finally {
    await Promise.allSettled([backend?.close(), provider.close()])
    remote.closeAllConnections()
    await new Promise<void>(resolve => remote.close(() => resolve()))
  }
})

async function live(page: Page, nestedToolName: string, scenario: (backend: Awaited<ReturnType<typeof mcpTestServer>>) => Promise<string>) {
  const model = observeMcpModelRequests()
  const backend = await mcpTestServer({ modelOptions: { fetch: model.fetch } })
  try {
    const observed = await setupMcpChat(page, backend.authUrl, await readLiveKey(modelKeyFile!))
    const prompt = await scenario(backend)
    const first = observed.updates.length
    await send(page, prompt)
    const changes = () => observed.updates.slice(first).map(({ update }) => update.change)
    await expect.poll(() => changes().some(change => change.type === 'task' && change.running === null), { timeout: 180_000 }).toBe(true)
    const replies = changes().flatMap(change => change.type === 'model' && (change.event.type === 'done' || change.event.type === 'replace') ? [change.event.message] : [])
    const scripts = changes().flatMap(change => {
      if (change.type !== 'model') return []
      const event = change.event
      const blocks = event.type === 'toolcall_end' ? [event.toolCall]
        : event.type === 'done' || event.type === 'replace' ? event.message.content : []
      return blocks.flatMap(block => block.type === 'toolCall' && block.name === 'codemode' ? [block] : [])
    })
    const results = changes().flatMap(change => change.type === 'task' && change.message?.message.role === 'toolResult'
      && change.message.message.toolName === 'codemode' && !change.message.message.isError ? [change.message.message] : [])
    const nested = changes().flatMap(change => change.type === 'nested-tool' && change.record.status === 'succeeded' ? [change.record] : [])
    expect(declaredToolNames(model.requests[0]!)).toContain('codemode')
    const related = nested.filter(item => item.name === nestedToolName)
    const result = results.find(result => related.some(item => item.id.startsWith(result.toolCallId + '/')))
    const attempts = replies.flatMap(reply => reply.content.flatMap(block => block.type === 'toolCall' ? [block.name] : []))
    expect(scripts.length, '真实模型调用 Code Mode，实际工具：' + attempts.join(', ')).toBeGreaterThan(0)
    expect(result, '实际 Node 沙箱完成脚本，内部工具：' + nested.map(item => item.name).join(', ')).toBeDefined()
    const followup = model.requests.find(request => request.messages.some(message => message.tool_call_id === result!.toolCallId))
    expect(followup, '已选结果回填真实模型').toBeDefined()
    expect(followup?.messages.filter(message => message.role === 'tool' && message.tool_call_id === result!.toolCallId)).toHaveLength(1)
    expect(followup?.messages.some(message => message.role === 'tool' && nested.some(item => item.id === message.tool_call_id))).toBe(false)
    const answer = replies.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? ''
    const output = result!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const process = page.locator('.process-group').filter({ has: page.locator('.nested-tool-calls') }).last()
    if (await process.getAttribute('open') === null) await process.locator(':scope > summary').click()
    expect(await process.locator('.nested-tool-calls [data-state="ok"]').count()).toBeGreaterThan(0)
    return { scripts, nested, output, answer, requests: model.requests }
  } finally { await backend.close() }
}

test.describe('Feature 13 真实模型验收', () => {
  test.skip(!modelKeyFile, '未提供 DEEPSEEK_LIVE_KEY_FILE')
  test.setTimeout(240_000)

  test('18 文件筛选后，只回填选中的内容', async ({ page }) => {
    const marker = 'SI-LIVE-' + randomUUID().slice(0, 8)
    const execution = await live(page, 'read', async ({ cwd }) => {
      await writeFile(join(cwd, 'current-plan.txt'), `项目编号：${marker}\nEXCLUDED-DETAIL`)
      await writeFile(join(cwd, 'obsolete-plan.txt'), '作废编号')
      await writeFile(join(cwd, 'draft-plan.txt'), '草稿编号')
      return '请实际调用 codemode 工具，禁止直接调用 find 或 read。通过一次 codemode 用 tools.find 搜索 *-plan.txt，从搜索结果选以 current- 开头的文件，再用 tools.read 读取，只 return 第一行；最后回答项目编号。'
    })
    expect(execution.nested).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'find', resultPreview: expect.stringContaining('current-plan.txt') }),
      expect.objectContaining({ name: 'read', argumentsPreview: expect.objectContaining({ path: 'current-plan.txt' }) }),
    ]))
    expect(execution.output).toContain(marker)
    expect(execution.output).not.toContain('EXCLUDED-DETAIL')
    expect(execution.answer).toContain(marker)
  })

  for (const hasIssues of [true, false]) test(`19 前台子 Agent 的实际答复经校验并汇总（${hasIssues ? '有问题' : '无有效问题'}）`, async ({ page }) => {
    const marker = 'SI-ISSUE-' + randomUUID().slice(0, 8)
    const execution = await live(page, 'subagent', async ({ cwd, home }) => {
      await mkdir(join(home, '.si', 'agents'), { recursive: true })
      await writeFile(join(home, '.si', 'agents', 'module-check.md'),
        '---\nname: module-check\ndescription: Read one assigned module file and report its marker\ntools:\n  - read\n---\nRead only the assigned module and follow the requested output format exactly.')
      await writeFile(join(cwd, 'Alpha.txt'), hasIssues ? `ALPHA MODULE\nISSUE: ${marker}` : 'ALPHA MODULE\nNO ISSUES')
      await writeFile(join(cwd, 'Beta.txt'), 'BETA MODULE\nNO ISSUES')
      await writeFile(join(cwd, 'Gamma.txt'), 'GAMMA MODULE\nNO ISSUES')
      return '必须实际调用 codemode，禁止直接使用 read 或 subagent。脚本只负责调用一次 tools.subagent({action:"run",background:false,agentScope:"user",tasks:[...]})，为 Alpha、Beta、Gamma 各委派一项，每项 agent 为 module-check。'
        + ' 让每个子 Agent 用 read 读对应的 .txt 文件。子 Agent 可看到这里是格式校验练习。Alpha 和 Beta 必须只写 JSON，字段 module 为任务模块名，issues 为问题列表（只有以 ISSUE: 开头的行才是问题，逐条放入原文）。Gamma 应用自然语言写读到的结论（本用例用它来检验非 JSON 回答）。'
        + ' 返回的 tasks 按请求排列，只有 sessionId、status、reply、error。脚本用数组下标和 ["Alpha","Beta","Gamma"] 配对，从 tasks[index].reply 解析 JSON（容许 Markdown 代码块），检查 module 和配对模块完全一致、issues 为数组。只累计有效模块的 issues，疑似格式错误的模块单独标记为需复核。'
        + ' 脚本用累计的问题数组长度选择 HAS_ISSUES 或 NO_VALID_ISSUES，只返回命中的一个标记、问题列表和需复核的模块列表。最终答案复述实际问题和需复核的模块。'
    })
    for (const label of ['ALPHA MODULE', 'BETA MODULE', 'GAMMA MODULE']) {
      expect(execution.requests.some(request => request.messages.some(message => message.role === 'tool'
        && typeof message.content === 'string' && message.content.includes(label)))).toBe(true)
    }
    expect(execution.output).toContain(hasIssues ? 'HAS_ISSUES' : 'NO_VALID_ISSUES')
    expect(execution.output).toContain('Gamma')
    if (hasIssues) {
      expect(execution.nested.find(item => item.name === 'subagent')?.resultPreview).toEqual(expect.stringContaining(marker))
      expect(execution.output).toContain(marker)
      expect(execution.answer).toContain(marker)
    }
    expect(execution.answer).toContain('Gamma')
  })

  test('20 同一脚本发现、检查并调用真实 Microsoft Learn MCP', async ({ page }) => {
    const endpoint = 'https://learn.microsoft.com/api/mcp'
    const url = 'https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records'
    const tool = 'mcp__learn__microsoft_docs_fetch'
    let title = ''
    await expect(async () => {
      const client = new McpClient({ url: endpoint, timeoutMs: 9000 })
      try {
        await client.connect()
        const result = await client.callTool('microsoft_docs_fetch', { url })
        const content = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
        title = /^#\s+([^\r\n]+)/m.exec(content)?.[1]?.trim() ?? ''
        expect(!result.isError && title.length > 0, '直接从真实 MCP 取得对照标题').toBe(true)
      } finally { await client.close().catch(() => {}) }
    }).toPass({ timeout: 45_000, intervals: [1000, 2000, 3500] })
    const execution = await live(page, tool, async () => {
      const settings = await openMcpSettings(page)
      const row = await registerMcpServer(settings, { name: 'learn', url: endpoint, token: 'si-public-docs-verification' })
      const toggle = row.getByRole('switch', { name: '切换 learn', exact: true })
      await expect(async () => {
        if (await toggle.isChecked()) return
        if (await toggle.getAttribute('aria-busy') !== 'true') await toggle.click()
        await expect(toggle).toBeChecked({ timeout: 12_000 })
      }).toPass({ timeout: 55_000, intervals: [1000, 1500] })
      await page.keyboard.press('Escape')
      return `请实际调用一次 codemode 取回 ${url} 的原始英文标题。用 await searchTools("microsoft_docs_fetch") 查工具名，await describeTool(name) 核对 inputSchema 必填参数，然后在同一脚本 await tools[name]({url})。只 return 文档里的 Markdown 一级标题，最终原样引用标题。不要调用 tool_search 或其他直接工具。`
    })
    expect(execution.requests.every(request => !declaredToolNames(request).includes(tool))).toBe(true)
    expect(execution.scripts.some(call => typeof call.arguments.code === 'string'
      && call.arguments.code.includes('searchTools') && call.arguments.code.includes('describeTool'))).toBe(true)
    expect(execution.nested).toEqual(expect.arrayContaining([expect.objectContaining({ name: tool, argumentsPreview: { url } })]))
    expect(execution.output).toContain(title)
    expect(execution.answer).toContain(title)
  })
})
