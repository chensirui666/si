import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMessage } from '../types';
import { ChatPage } from './ChatPage';

const children = vi.hoisted(() => ({
  onSend: undefined as ((text: string) => boolean) | undefined,
  messages: [] as readonly UserMessage[],
}));

vi.mock('../components/MessageInput', () => ({
  MessageInput: ({ onSend }: { onSend: (text: string) => boolean }) => {
    children.onSend = onSend;
    return null;
  },
}));

vi.mock('../components/MessageList', () => ({
  MessageList: ({ messages }: { messages: readonly UserMessage[] }) => {
    children.messages = messages;
    return null;
  },
}));

beforeEach(() => {
  children.onSend = undefined;
  children.messages = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ChatPage', () => {
  it('接收契约与连续追加', () => {
    const createId = vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
    const view = render(<StrictMode><ChatPage /></StrictMode>);
    expect(children.messages).toEqual([]);
    const onSend = children.onSend!;

    act(() => {
      expect(onSend(' \n ')).toBe(false);
    });
    expect(children.messages).toEqual([]);
    expect(createId).not.toHaveBeenCalled();

    act(() => {
      expect(onSend('  你好\n世界  ')).toBe(true);
      expect(onSend('重复')).toBe(true);
      expect(onSend('重复')).toBe(true);
    });

    expect(children.messages).toEqual([
      { id: '00000000-0000-4000-8000-000000000001', role: 'user', text: '  你好\n世界  ' },
      { id: '00000000-0000-4000-8000-000000000002', role: 'user', text: '重复' },
      { id: '00000000-0000-4000-8000-000000000003', role: 'user', text: '重复' },
    ]);
    expect(createId).toHaveBeenCalledTimes(3);

    const accepted = children.messages;
    view.rerender(<StrictMode><ChatPage /></StrictMode>);
    expect(children.messages).toEqual(accepted);
    expect(createId).toHaveBeenCalledTimes(3);
  });

  it('编号创建失败时不会安排追加消息', () => {
    const error = new Error('编号不可用');
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw error; });
    const view = render(<ChatPage />);

    expect(() => children.onSend!('保留草稿')).toThrow(error);
    view.rerender(<ChatPage />);
    expect(children.messages).toEqual([]);
  });
});
