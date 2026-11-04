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
