import { expect, test } from '@playwright/experimental-ct-react';
import type { RunRecord } from '@agent-learning/server/protocol';
import type { ConversationMessage } from '../types';
import { MessageList } from './MessageList';

test('原文展示、长内容换行与复制', async ({ mount, page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const original = '  第一行\n\n    第二行  \n';
  const messages: readonly ConversationMessage[] = Object.freeze([
    Object.freeze({ id: 'plain', message: { role: 'user' as const, content: original, timestamp: 1 } }),
    Object.freeze({ id: 'tag', message: { role: 'user' as const, content: '<b>你好</b>', timestamp: 1 } }),
    Object.freeze({ id: 'markdown', message: { role: 'user' as const, content: '**你好**', timestamp: 1 } }),
    Object.freeze({ id: 'long', message: { role: 'user' as const, content: 'a'.repeat(1200), timestamp: 1 } }),
  ]);
  const component = await mount(
    <div style={{ width: 320, height: 320, display: 'flex' }}>
      <MessageList messages={messages} />
    </div>,
  );
  const region = component.getByRole('region', { name: '消息列表' });
  await expect(region).toHaveAttribute('tabindex', '0');
  const text = region.locator('.message-text');
  expect(await text.allTextContents()).toEqual([
    original, '<b>你好</b>', '**你好**', 'a'.repeat(1200),
  ]);
  await expect(region.locator('b')).toHaveCount(0);
  const layout = await text.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      width: rect.width,
      height: rect.height,
      lineHeight: Number.parseFloat(style.lineHeight),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  }));
  expect(layout[0].whiteSpace).toBe('pre-wrap');
  expect(layout[0].overflowWrap).toBe('anywhere');
  expect(layout[0].height).toBeGreaterThanOrEqual(layout[0].lineHeight * 3);
  expect(layout[3].height).toBeGreaterThan(layout[3].lineHeight);
  expect(layout[3].width).toBeLessThanOrEqual(320);
  expect(layout[3].scrollWidth).toBeLessThanOrEqual(layout[3].clientWidth + 1);
  expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  await text.first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(original);
  await page.keyboard.press('ControlOrMeta+c');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(original);

  const oldRegion = await region.elementHandle();
  const oldFirst = await region.getByRole('listitem').first().elementHandle();
  await component.update(
    <div style={{ width: 320, height: 320, display: 'flex' }}>
      <MessageList messages={[...messages, { id: 'later', message: { role: 'user', content: '后来发送', timestamp: 2 } }]} />
    </div>,
  );
  expect(await region.evaluate((element, old) => element === old, oldRegion)).toBe(true);
  expect(await region.getByRole('listitem').first().evaluate((element, old) => element === old, oldFirst)).toBe(true);

  await component.update(
    <div style={{ width: 320, height: 320, display: 'flex' }}>
      <MessageList messages={[]} />
    </div>,
  );
  await expect(region.getByRole('listitem')).toHaveCount(0);
  await expect(region).toHaveText('');
});

test('整轮计时从服务端开始，经过工具和回复，结束后固定为记录的用时', async ({ mount, page }) => {
  const start = new Date('2026-11-13T00:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 500));
  const user: ConversationMessage = { id: 'u', message: { role: 'user', content: '查一下', timestamp: start.getTime() } };
  const run: RunRecord = { id: 'u', sessionId: 'session-a', clientMessageId: 'client-u', modelId: 'deepseek-flash', kind: 'task', status: 'running', startedAt: start.getTime() + 500 };
  const running = { kind: 'task', runId: 'u', assistantMessageId: 'a', phase: 'model', activeTools: [] } as const;
  const assistant = { id: 'a', message: {
    role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: run.startedAt,
    stopReason: 'pending', content: [{ type: 'thinking', thinking: '检查文件' }, { type: 'text', text: '第一段回复' }, { type: 'thinking', thinking: '继续检查' }],
  } } satisfies ConversationMessage;
  const component = await mount(<MessageList messages={[user]} runs={[run]} running={{ ...running, activeTools: [] }} />);
  const status = component.locator('.run-status');
  await expect(status).toHaveText('正在执行');
  await page.clock.runFor(1000);
  await expect(status).toHaveText('正在执行 · 1 秒');
  await component.update(<MessageList messages={[user, assistant]} runs={[run]} running={{ ...running, phase: 'tools', activeTools: [] }} />);
  await expect(status).toHaveCount(1);
  await expect(component.getByText('第一段回复')).toBeVisible();
  await page.clock.runFor(1000);
  await expect(status).toHaveText('正在执行 · 2 秒');

  const completed: RunRecord = { ...run, status: 'completed', finishedAt: run.startedAt + 68_000 };
  await component.update(<MessageList messages={[user, assistant]} runs={[completed]} />);
  await expect(status).toHaveText('用时 1 分 08 秒');
  await page.clock.runFor(1000);
  await expect(status).toHaveText('用时 1 分 08 秒');
  await component.locator('.process-group > summary').filter({ has: page.locator('.run-status') }).press('Enter');
  await expect(component.getByText(/思考 · 检查文件/)).toBeVisible();

  await component.update(<MessageList messages={[user]} runs={[{ ...completed, status: 'aborted' }]} />);
  await expect(status).toHaveText('已中止 · 1 分 08 秒');
  await component.update(<MessageList messages={[user]} runs={[{ ...completed, status: 'failed' }]} />);
  await expect(status).toHaveText('执行失败 · 1 分 08 秒');
  await component.update(<MessageList messages={[user]} runs={[{ ...run, status: 'interrupted', restored: true }]} />);
  await expect(status).toHaveText('已中断');
});

test('执行过程逐步展示并独立展开，正文分段，结果按来源关联并随任务结束收起', async ({ mount }) => {
  const base = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'pending', content: [] } as const;
  const call = { type: 'toolCall', id: 'same', name: 'read', arguments: { path: 'note.txt' } } as const;
  const user: ConversationMessage = { id: 'u', message: { role: 'user', content: '读取文件', timestamp: 1 } };
  const first = { id: 'a', message: { ...base, content: [{ type: 'thinking', thinking: '先读' }, { type: 'toolCall', id: '', name: '', arguments: {} }] } } satisfies ConversationMessage;
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'model' as const, activeTools: [] };
  const component = await mount(<MessageList messages={[user, first]} running={running} activeContent={[
    { type: 'thinking', messageId: 'a', contentIndex: 0 },
    { type: 'toolCall', messageId: 'a', contentIndex: 1, argumentsText: '{"path":' },
  ]} />);
  const process = component.locator('details.process-group').first();
  const thinking = process.locator('.thinking-block');
  const tool = process.locator('.tool-block').first();
  await expect(process).toHaveAttribute('open');
  await expect(thinking.locator('summary')).toContainText('先读');
  await expect(thinking).not.toHaveAttribute('open');
  await expect(tool.locator('summary')).toContainText('准备中');
  await thinking.locator('summary').click();
  await expect(tool).not.toHaveAttribute('open');

  const assistant: ConversationMessage = { id: 'a', message: { ...base, content: [{ type: 'thinking', thinking: '先读文件，再核对' }, call] } };
  await component.update(<MessageList messages={[user, assistant]} running={running} />);
  await expect(thinking.locator('.markdown-text')).toHaveText('先读文件，再核对');
  await expect(tool.locator('summary')).toContainText('准备中');
  const activeTool = { assistantMessageId: 'a', contentIndex: 1 };
  await component.update(<MessageList messages={[user, assistant]} running={{ ...running, phase: 'tools', activeTools: [activeTool] }} />);
  await expect(tool.locator('summary')).toContainText('运行中');

  const answer: ConversationMessage = { id: 'answer', message: { ...base, stopReason: 'stop', content: [
    { type: 'thinking', thinking: '根据结果回答' }, call, { type: 'text', text: '**最终正文**' }, { type: 'thinking', thinking: '正文后思考' },
  ] } };
  const result = (id: string, assistantMessageId: string, contentIndex: number, text: string, isError: boolean): ConversationMessage => ({
    id, toolCall: { assistantMessageId, contentIndex }, message: { role: 'toolResult', toolCallId: 'same', toolName: 'read', timestamp: 2, isError, content: [{ type: 'text', text }] },
  });
  const messages = [user, assistant, result('r1', 'a', 1, '青禾（输出已截断）', false), answer, result('r2', 'answer', 1, '找不到文件', true)];
  await component.update(<MessageList messages={messages} running={{ ...running, phase: 'model', activeTools: [], assistantMessageId: 'answer' }} />);
  const groups = component.locator('details.process-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.first().locator('.thinking-block')).toHaveCount(2);
  await expect(groups.last().locator('.thinking-block summary')).toContainText('正文后思考');
  await expect(tool.locator('summary')).toContainText('读取 · note.txt');
  await expect(tool.locator('summary')).toContainText('成功');
  const failed = groups.first().locator('.tool-block').last();
  await expect(failed.locator('summary')).toContainText('失败');
  await tool.locator('summary').click();
  await expect(tool.getByText('青禾（输出已截断）')).toBeVisible();
  await expect(thinking.first()).toHaveAttribute('open');
  await expect(thinking.last()).not.toHaveAttribute('open');

  await component.update(<MessageList messages={messages} running={null} />);
  await expect(groups.first()).not.toHaveAttribute('open');
  await expect(groups.last()).not.toHaveAttribute('open');
  await expect(component.getByText('最终正文')).toBeVisible();
  await groups.first().locator(':scope > summary').click();
  await failed.locator('summary').click();
  await expect(failed.getByText('找不到文件')).toBeVisible();
  await expect(failed.getByText('青禾（输出已截断）')).toHaveCount(0);
});

test('W4 两轮读取使用相同调用编号，整次结束才收起并保留各自结果', async ({ mount }) => {
  const base = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'toolUse' } as const;
  const call = (path: string) => ({ type: 'toolCall' as const, id: 'read-1', name: 'read', arguments: { path } });
  const user: ConversationMessage = { id: 'u', message: { role: 'user', content: '找出项目名称', timestamp: 0 } };
  const first: ConversationMessage = { id: 'a1', message: { ...base, content: [call('index.txt')] } };
  const result = (id: string, assistantMessageId: string, text: string): ConversationMessage => ({ id, toolCall: { assistantMessageId, contentIndex: 0 }, message: { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', timestamp: 2, isError: false, content: [{ type: 'text', text }] } });
  const history = [user, first, result('r1', 'a1', '下一条线索在 note.txt')];
  const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a2', phase: 'model' as const, activeTools: [] };
  const component = await mount(<MessageList messages={history} running={running} />);
  const process = component.locator('.process-group');
  await expect(process).toHaveAttribute('open');
  const second: ConversationMessage = { id: 'a2', message: { ...base, content: [call('note.txt')] } };
  await component.update(<MessageList messages={[...history, second]} running={{ ...running, phase: 'tools', activeTools: [{ assistantMessageId: 'a2', contentIndex: 0 }] }} />);
  await expect(process).toHaveAttribute('open');
  await expect(process.locator('.tool-status')).toHaveText(['成功', '运行中']);
  const completed = [...history, second, result('r2', 'a2', '项目名称：青禾'), { id: 'a3', message: { ...base, stopReason: 'stop' as const, content: [{ type: 'text' as const, text: '青禾' }] } }];
  await component.update(<MessageList messages={completed} />);
  await expect(process).not.toHaveAttribute('open');
  await process.locator(':scope > summary').click();
  const tools = process.locator('.tool-block');
  await tools.nth(0).locator('summary').click();
  await tools.nth(1).locator('summary').click();
  await expect(tools.nth(0)).toContainText('下一条线索在 note.txt');
  await expect(tools.nth(1)).toContainText('项目名称：青禾');
  await expect(tools.nth(1)).not.toContainText('下一条线索');
  await process.locator(':scope > summary').click();
  await expect(process).not.toHaveAttribute('open');
  await process.locator(':scope > summary').click();
  await expect(process).toHaveAttribute('open');
});

test('结果保存失败的工具卡不可展开，并在本轮说明磁盘原因', async ({ mount }) => {
  const messages: ConversationMessage[] = [
    { id: 'u', message: { role: 'user', content: '修改文件', timestamp: 1 } },
    { id: 'a', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
      timestamp: 2, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'edit', name: 'edit', arguments: { path: 'README.md' } }] } },
  ]
  const component = await mount(<MessageList messages={messages}
    saveFailures={[{ runId: 'u', stage: 'tool-result', reason: 'storage-full', toolCall: { assistantMessageId: 'a', contentIndex: 0 } }]} />)
  await component.locator('.process-group > summary').click()
  const tool = component.locator('.tool-block')
  await expect(tool).toContainText('工具已执行，结果未保存')
  await expect(tool.locator('[data-state="error"]')).toHaveText('失败')
  await expect(tool.locator('summary')).toHaveCount(0)
  await expect(component.getByRole('alert')).toContainText('磁盘空间不足')
})

test('12 流式回答仍可读，轮末提示未保存', async ({ mount }) => {
  const messages: ConversationMessage[] = [
    { id: 'u', message: { role: 'user', content: '核对启动命令', timestamp: 1 } },
    { id: 'a', message: { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
      timestamp: 2, stopReason: 'stop', content: [{ type: 'text', text: '启动命令已核对' }] } },
  ]
  const component = await mount(<MessageList messages={messages} saveFailures={[{ runId: 'u', stage: 'answer', reason: 'write-failed' }]} />)
  await expect(component.getByText('启动命令已核对', { exact: true })).toBeVisible()
  await expect(component.getByRole('alert')).toContainText('回答已生成，但未保存')
})

test('Skill 读取失败时显示原因，并保留提交原文', async ({ mount }) => {
  const text = '/skill:review 请复核修改';
  const component = await mount(<MessageList messages={[{
    id: 'failed-skill',
    message: { role: 'user', content: text, timestamp: 1 },
    skillInvocation: { source: 'project-si', name: 'review', status: 'failed', reason: '说明文件已移走或删除。' },
  }]} />);
  await expect(component.locator('.message-text')).toHaveText(text);
  await expect(component.locator('[data-skill-status="failed"]')).toHaveText('读取 review 失败：说明文件已移走或删除。 · 项目');
});

test('加载记录分别标明预置版和个人版', async ({ mount }) => {
  const component = await mount(<MessageList messages={[
    {
      id: 'bundled-version',
      message: { role: 'user', content: '/skill:grill-me', timestamp: 1 },
      skillInvocation: { source: 'bundled', name: 'grill-me', status: 'loaded' },
    },
    {
      id: 'personal-version',
      message: { role: 'user', content: '/skill:grill-me', timestamp: 2 },
      skillInvocation: { source: 'user-si', name: 'grill-me', status: 'loaded' },
    },
  ]} />);
  await expect(component.locator('[data-skill-status="loaded"]'))
    .toHaveText(['已加载 grill-me · 预置', '已加载 grill-me · 个人']);
});

test.describe('模型请求恢复文案', () => {
  test.use({ timezoneId: 'Asia/Shanghai' })

  test('按状态文案记录表验证 01–47 和显示位置', async ({ mount, page }) => {
    const now = new Date('2026-11-16T08:00:00Z').getTime()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    type Running = Extract<NonNullable<import('@agent-learning/server/protocol').RunningState>, { kind: 'task' }>
    type Assistant = import('@agent-learning/model').AssistantMessage
    type Failure = NonNullable<Assistant['failure']>
    type Retry = NonNullable<Running['retry']>
    const user: ConversationMessage = { id: 'u', message: { role: 'user', content: '问题', timestamp: now } }
    const assistant: Assistant = { role: 'assistant', model: 'deepseek-flash', api: 'openai-completions', provider: 'deepseek',
      timestamp: now, content: [], stopReason: 'pending' }
    const oldText = { type: 'text' as const, text: '上次正文' }
    const newText = { type: 'text' as const, text: '本次正文' }
    const toolCall = { type: 'toolCall' as const, id: 'read', name: 'read', arguments: { path: 'note.txt' } }
    const run: RunRecord = { id: 'u', sessionId: 's', clientMessageId: 'c', modelId: 'deepseek-flash', kind: 'task', status: 'running', startedAt: now - 8000 }
    const running: Running = { kind: 'task', runId: 'u', assistantMessageId: 'a', phase: 'model', activeTools: [] }
    const limited = (reason: Failure['kind'], options: Partial<Extract<Retry, { mode: 'limited' }>> = {}): Retry =>
      ({ mode: 'limited', phase: 'waiting', reason, attempt: 1, maxAttempts: 5, retryAt: now + 1000, ...options })
    const fails = (kind: Failure['kind'], extra: Partial<Failure> = {}): Partial<Assistant> => ({ stopReason: 'error', failure: { kind, ...extra } })
    type Case = {
      status?: RunRecord['status']; retry?: Retry; patch?: Partial<Assistant>; text?: string;
      pageOffline?: boolean; summary?: string; compacting?: boolean; next?: boolean;
    }
    const waits: [number, Failure['kind'], string, number?][] = [
      [10, 'connection-reset', '模型连接中断'],
      [11, 'stream-read', '模型回复读取失败'],
      [12, 'stream-ended', '模型回复中断'],
      [13, 'timeout', '模型请求超时'],
      [14, 'temporary-rate-limit', '模型服务暂时限流'],
      [15, 'rate-limit', '模型服务限制了请求'],
      [16, 'internal', '模型服务内部错误'],
      [17, 'bad-gateway', '模型服务网关错误'],
      [18, 'unavailable', '模型服务暂不可用'],
      [19, 'gateway-timeout', '模型服务网关超时'],
      [20, 'overloaded', '模型服务繁忙'],
      [21, 'capacity', '模型容量暂不可用'],
      [45, 'request-error', '模型请求异常'],
      [46, 'response-error', '模型回复异常'],
      [47, 'http-error', '模型请求异常（HTTP 418）', 418],
    ]
    const terminal: [number, Failure['kind'], string, Partial<Failure>?][] = [
      [24, 'response-error', '模型回复异常，已重试 5 次', { attempts: 5 }],
      [25, 'rate-limit', '模型服务限制了请求，已重试 5 次。最早可于 2026-11-16 16:00:01 UTC+08:00 重试', { attempts: 5, retryAt: now + 501 }],
      [26, 'rate-limit', '模型服务限制了请求，请稍后再试'],
      [27, 'overloaded', '模型服务繁忙，请稍后再试或切换模型'],
      [28, 'capacity', '模型容量暂不可用，请稍后再试或切换模型'],
      [29, 'balance', '模型服务余额不足，请检查账户余额'],
      [30, 'quota', '模型服务配额已用尽，请检查账户额度'],
      [31, 'authentication', '模型服务拒绝了凭据，请检查凭据配置'],
      [32, 'permission', '当前凭据无权使用该模型'],
      [33, 'invalid-request', '模型服务拒绝了请求，请检查请求参数'],
      [34, 'configuration', '模型配置无效，请检查模型配置'],
      [35, 'unknown', '模型请求未能完成，请重试'],
      [43, 'context-capacity', '当前模型容量不足，请切换模型后重新压缩'],
      [44, 'context-capacity', '当前模型容量不足，请切换模型后重新压缩'],
    ]
    const cases: Record<number, Case> = {
      1: {}, 2: { patch: { content: [oldText] } }, 3: { patch: { stopReason: 'toolUse', content: [toolCall] } },
      4: { patch: { content: [newText] } }, 5: { patch: { stopReason: 'toolUse', content: [toolCall] } },
      6: { status: 'completed', patch: { stopReason: 'stop', content: [newText] } },
      7: { status: 'completed', patch: { stopReason: 'length', content: [newText] }, text: '达到长度限制，回答可能不完整' },
      8: { patch: { stopReason: 'length', content: [toolCall] }, text: '达到长度限制，回答可能不完整' },
      9: { retry: { mode: 'connection', reason: 'connection', phase: 'waiting', retryAt: now + 5000 }, text: '等待连接模型服务 · 5 秒后再试' },
      22: { retry: limited('stream-ended', { phase: 'retrying', attempt: 2, retryAt: undefined, incomplete: true }),
        patch: { content: [oldText] }, text: '正在重试 · 第 2/5 次 · 上次回复未完成' },
      23: { retry: { mode: 'connection', reason: 'connection', phase: 'retrying' }, text: '正在重新连接模型服务' },
      36: { status: 'aborted', patch: { stopReason: 'aborted' }, text: '已停止 · 本轮已取消' },
      37: { status: 'interrupted', summary: '已中断' },
      38: { next: true },
      39: { retry: limited('stream-ended'), pageOffline: true },
      40: { retry: limited('stream-ended', { attempt: 3 }), text: '模型回复中断 · 1 秒后进行第 3/5 次重试' },
      41: { patch: { stopReason: 'error', errorCode: 'context_overflow' }, compacting: true },
      42: {},
    }
    for (const [id, kind, label, status] of waits) cases[id] = {
      retry: limited(kind, { status }), text: label + ' · 1 秒后进行第 1/5 次重试',
    }
    for (const [id, kind, label, extra] of terminal) cases[id] = {
      status: 'failed', patch: fails(kind, extra), text: '回复失败 · ' + label,
    }
    const component = await mount(<MessageList messages={[]} />)
    for (let id = 1; id <= 47; id++) await test.step(String(id).padStart(2, '0'), async () => {
      const { status = 'running', patch, retry, text, pageOffline, summary, compacting, next } = cases[id]
      const entry = patch ? [{ id: 'a', message: { ...assistant, ...patch } }] : []
      const records = [{ ...run, status, ...(status !== 'running' && { finishedAt: now }) }]
      const props = next
        ? { messages: [user, { id: 'a', message: { ...assistant, ...fails('unknown') } }, { ...user, id: 'new' }],
            runs: [{ ...run, status: 'failed' as const, finishedAt: now }, { ...run, id: 'new' }],
            running: { ...running, runId: 'new', assistantMessageId: 'b' } }
        : { messages: [user, ...entry], runs: records, showRetry: !pageOffline,
            running: status === 'running' ? { ...running, phase: compacting ? 'compaction' as const : 'model' as const, retry } : null }
      await component.update(<MessageList {...props} />)
      const row = component.locator('.message-item-assistant').last()
      await expect(row).toHaveAttribute('data-run-status', status)
      const detail = row.locator('[data-run-detail]')
      if (text) {
        await expect(detail).toHaveText(text)
        await expect(row.locator('.run-status-line + [data-run-detail]')).toHaveCount(1)
      } else await expect(detail).toHaveCount(0)
      if (summary) await expect(row.locator('.run-status')).toContainText(summary)
      if (next) await expect(component.locator('.message-item-assistant').first()).toHaveAttribute('data-run-status', 'failed')
    })
  })

  test('到零后等服务端确认，120 秒等待过 61 秒仍显示剩余 59 秒', async ({ mount, page }) => {
    const now = new Date('2026-11-16T08:00:00Z').getTime()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now)
    const messages: ConversationMessage[] = [{ id: 'u', message: { role: 'user', content: '问题', timestamp: now } }]
    const running = { kind: 'task' as const, runId: 'u', assistantMessageId: 'a', phase: 'model' as const, activeTools: [],
      retry: { mode: 'limited' as const, reason: 'rate-limit' as const, phase: 'waiting' as const, attempt: 1, maxAttempts: 5 as const, retryAt: now + 120_000 } }
    const component = await mount(<MessageList messages={messages} running={running} />)
    const detail = component.locator('[data-run-detail]')
    await page.clock.fastForward(61_000)
    await expect(detail).toHaveText('模型服务限制了请求 · 59 秒后进行第 1/5 次重试')
    await page.clock.fastForward(59_000)
    await expect(detail).toHaveText('模型服务限制了请求 · 0 秒后进行第 1/5 次重试')
    await component.update(<MessageList messages={messages} running={{ ...running, retry: { ...running.retry, phase: 'retrying', retryAt: undefined } }} />)
    await expect(detail).toHaveText('正在重试 · 第 1/5 次')
  })
})
