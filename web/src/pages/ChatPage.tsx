import { useState } from 'react';
import { MessageInput } from '../components/MessageInput';
import { MessageList } from '../components/MessageList';
import type { UserMessage } from '../types';

export function ChatPage() {
  const [messages, setMessages] = useState<UserMessage[]>([]);

  function handleSend(text: string): boolean {
    if (!text.trim()) return false;
    const message: UserMessage = { id: crypto.randomUUID(), role: 'user', text };
    setMessages((current) => [...current, message]);
    return true;
  }

  return (
    <div className="chat-page">
      <header className="chat-header">
        <h1>聊天</h1>
      </header>
      <main className="chat-main">
        <MessageList messages={messages} />
        <MessageInput onSend={handleSend} />
      </main>
    </div>
  );
}
