'use client';

import React, { useEffect, useRef } from 'react';
import type { MessageWithMeta, ChatPhase } from '@/types/chat';
import { TextMessage } from './TextMessage';

interface MessageListProps {
  messages: MessageWithMeta[];
  streamingMessage?: {
    content: string;
    thinking?: string;
    phase: ChatPhase | null;
  } | null;
}

export function MessageList({ messages, streamingMessage }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingMessage?.content, streamingMessage?.thinking, streamingMessage?.phase]);

  return (
    <div
      ref={listRef}
      id="message-list"
      className="flex flex-col gap-4 max-w-4xl mx-auto w-full min-w-0 px-2 md:px-0 py-4"
    >
      {messages.map((m) => (
        <TextMessage
          key={m.id}
          id={m.id}
          role={m.role}
          content={m.content}
          thinking={m.thinking}
          createdAt={m.created_at}
          citations={m.citations}
          sources={m.sources}
        />
      ))}

      {streamingMessage && (
        <TextMessage
          role="assistant"
          content={streamingMessage.content}
          thinking={streamingMessage.thinking}
          isStreaming={true}
        />
      )}

      <div ref={bottomRef} className="h-2" />
    </div>
  );
}
