'use client';

import React, { useState } from 'react';
import type { Source, Citation } from '@/types/chat';

interface SourcesListProps {
  sources: Source[];
  citations?: Citation[];
}

export function SourcesList({ sources, citations }: SourcesListProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Combine sources and citations, deduplicating by canonical_url
  const allSourcesMap = new Map<string, { url: string; title: string | null }>();

  for (const s of sources) {
    if (s.url && !allSourcesMap.has(s.canonical_url)) {
      allSourcesMap.set(s.canonical_url, { url: s.url, title: s.title || null });
    }
  }

  if (citations) {
    for (const c of citations) {
      if (c.url && !allSourcesMap.has(c.canonical_url)) {
        allSourcesMap.set(c.canonical_url, { url: c.url, title: c.title || null });
      }
    }
  }

  const combined = Array.from(allSourcesMap.values());
  if (combined.length === 0) return null;

  return (
    <div className="mt-3 pt-2 border-t border-gray-200 text-xs">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 font-semibold text-gray-600 hover:text-orange-600 cursor-pointer py-1"
      >
        <span>{isOpen ? '▼' : '▶'}</span>
        <span>Sources consulted ({combined.length})</span>
      </button>

      {isOpen && (
        <ul className="mt-2 space-y-1 pl-4 list-disc text-gray-700">
          {combined.map((src, idx) => {
            let domain = src.url;
            try {
              domain = new URL(src.url).hostname.replace(/^www\./, '');
            } catch {
              // fallback
            }

            return (
              <li key={idx} className="break-all">
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-orange-600 hover:underline hover:text-orange-700 font-mono"
                >
                  {src.title ? `${src.title} (${domain})` : src.url}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
