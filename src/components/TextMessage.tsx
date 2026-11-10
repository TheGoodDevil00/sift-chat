'use client';

import React from 'react';
import markdownit from 'markdown-it';
import type { Citation, Source } from '@/types/chat';
import { SourcesList } from './SourcesList';

const md = markdownit({
  html: false, // Security: never render raw HTML
  linkify: true,
  breaks: true,
});

// Configure markdown-it to open external links safely
const defaultRender =
  md.renderer.rules.link_open ||
  function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultRender(tokens, idx, options, env, self);
};

interface TextMessageProps {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
  citations?: Citation[];
  sources?: Source[];
  isStreaming?: boolean;
}

export function TextMessage({
  role,
  content,
  createdAt,
  citations = [],
  sources = [],
  isStreaming,
}: TextMessageProps) {
  const isAssistant = role === 'assistant';

  let timeString = '';
  if (createdAt) {
    try {
      const d = new Date(createdAt);
      timeString = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      timeString = '';
    }
  }

  const renderedHtml = md.render(content || (isStreaming ? '...' : ''));

  return (
    <div
      className={`border rounded-lg p-4 transition-colors ${
        isAssistant
          ? 'bg-neutral-50 border-gray-200'
          : 'bg-white border-gray-300 ml-4 md:ml-12'
      }`}
    >
      <div className="flex items-center justify-between text-xs text-gray-500 mb-2 border-b border-gray-100 pb-1">
        <span className="font-bold uppercase tracking-wider text-xs">
          {isAssistant ? 'Sift Assistant' : 'You'}
        </span>
        {timeString && <span>{timeString}</span>}
      </div>

      <div
        className="prose max-w-none text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />

      {isStreaming && (
        <span className="inline-block w-2 h-4 ml-1 bg-orange-500 animate-pulse align-middle" />
      )}

      {/* Render Consulted Sources for Assistant messages */}
      {isAssistant && !isStreaming && (sources.length > 0 || citations.length > 0) && (
        <SourcesList sources={sources} citations={citations} />
      )}
    </div>
  );
}
