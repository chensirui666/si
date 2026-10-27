import type { UserMessage } from '../types';

export function MessageList({ messages }: { messages: readonly UserMessage[] }) {
  return (
    <section className="message-list" role="region" aria-label="消息列表" tabIndex={0}>
      <ol className="message-items">
        {messages.map((message) => (
          <li className="message-item" key={message.id} data-message-id={message.id}>
            <div className="message-text">
              {message.text}
              {/* 保留末尾空行，避免浏览器原生复制漏掉最后的换行。 */}
              <br />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
