'use client';

import React from 'react';
import type { ChatPhase } from '@/types/chat';

interface StatusIndicatorProps {
  phase: ChatPhase | null;
  error?: string | null;
  /** False when the active provider has no key and is not a local endpoint. */
  configured?: boolean;
}

export function StatusIndicator({ phase, error, configured = true }: StatusIndicatorProps) {
  if (error) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded">
        <span className="font-semibold">Error: {error}</span>
      </div>
    );
  }

  if (phase === 'retrieving_history') {
    return (
      <div className="flex items-center gap-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded animate-pulse">
        <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
        <span>Searching conversation history...</span>
      </div>
    );
  }

  if (phase === 'searching_web') {
    return (
      <div className="flex items-center gap-2 text-xs text-orange-700 bg-orange-50 border border-orange-200 px-2.5 py-1 rounded animate-pulse">
        <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
        <span className="font-bold">Searching live web...</span>
      </div>
    );
  }

  if (phase === 'thinking') {
    return (
      <div className="flex items-center gap-2 text-xs text-purple-700 bg-purple-50 border border-purple-200 px-2.5 py-1 rounded animate-pulse">
        <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
        <span className="font-semibold">Working through the evidence...</span>
      </div>
    );
  }

  if (phase === 'writing') {
    return (
      <div className="flex items-center gap-2 text-xs text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded">
        <span className="w-2 h-2 rounded-full bg-green-500" />
        <span>Synthesizing answer...</span>
      </div>
    );
  }

  if (!configured) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-700">
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        <span>No provider configured</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-500">
      <span className="w-2 h-2 rounded-full bg-emerald-500" />
      <span>Ready</span>
    </div>
  );
}
