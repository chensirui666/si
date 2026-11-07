import { expect, test } from '@playwright/experimental-ct-react';
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

test('执行过程逐步展示并独立展开，正文分段，结果按来源关联并随任务结束收起', async ({ mount }) => {
  const base = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash', timestamp: 1, stopReason: 'pending', content: [] } as const;
  const call = { type: 'toolCall', id: 'same', name: 'read', arguments: { path: 'note.txt' } } as const;
  const user: ConversationMessage = { id: 'u', message: { role: 'user', content: '读取文件', timestamp: 1 } };
  const first = { id: 'a', message: { ...base, content: [{ type: 'thinking', thinking: '先读' }, { type: 'toolCall', id: '', name: '', arguments: {} }] } } satisfies ConversationMessage;
  const running = { userMessageId: 'u', assistantMessageId: 'a', phase: 'model' as const, activeTools: [] };
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
  const running = { userMessageId: 'u', assistantMessageId: 'a2', phase: 'model' as const, activeTools: [] };
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
