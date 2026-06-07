import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../lib/chatApi';

interface Props {
  messages: ChatMessage[];
  isLoading: boolean;
}

export default function MessageThread({ messages, isLoading }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isLoading]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center px-8 text-center">
        <p className="text-sm text-gray-400 max-w-xs">
          Ask anything about your restaurant — revenue, top items, trends, what to cut.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
        >
          <div
            className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-indigo-600 text-white rounded-br-sm'
                : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm'
            }`}
          >
            {msg.content}
          </div>
          {msg.role === 'assistant' &&
            (msg.context_meta.summaries_count || msg.context_meta.menu_items_count) ? (
            <p className="mt-1 text-[11px] text-gray-400 px-1">
              Based on:{' '}
              {[
                msg.context_meta.summaries_count
                  ? `${msg.context_meta.summaries_count} days of data`
                  : null,
                msg.context_meta.menu_items_count
                  ? `${msg.context_meta.menu_items_count} menu items`
                  : null,
              ]
                .filter(Boolean)
                .join(', ')}
            </p>
          ) : null}
        </div>
      ))}
      {isLoading && (
        <div className="flex items-start">
          <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
            <div className="flex gap-1 items-center h-4">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
