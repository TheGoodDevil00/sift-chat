'use client';

import React, { useState, useRef, useEffect } from 'react';

interface MessageInputProps {
  onSendMessage: (text: string) => Promise<void>;
  onNewChat: () => void;
  disabled?: boolean;
}

export function MessageInput({
  onSendMessage,
  onNewChat,
  disabled = false,
}: MessageInputProps) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus();
    }
  }, [disabled]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || disabled) return;

    setInput('');
    await onSendMessage(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-4xl mx-auto w-full px-2 md:px-0 my-4 flex flex-row gap-2 sticky bottom-4 bg-[#fbfbfb]/90 backdrop-blur-sm pt-2"
    >
      <input
        ref={inputRef}
        type="text"
        disabled={disabled}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder={
          disabled
            ? 'Sift is researching...'
            : 'Ask a question or check what has changed...'
        }
        className="flex-grow border-2 border-gray-400 focus:border-orange-500 focus:outline-none p-3 w-full rounded-md font-mono text-sm disabled:bg-gray-100 disabled:cursor-not-allowed shadow-sm transition-colors"
      />
      <button
        type="submit"
        disabled={disabled || !input.trim()}
        className="px-5 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold rounded-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm shadow-sm"
      >
        Submit
      </button>
      <button
        type="button"
        onClick={onNewChat}
        disabled={disabled}
        className="px-4 py-3 rounded-md border border-gray-400 hover:bg-gray-100 text-gray-700 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium whitespace-nowrap"
      >
        New Chat
      </button>
    </form>
  );
}
