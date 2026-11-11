'use client';

import React from 'react';
import type { ConversationSummary } from '@/types/chat';

interface SidebarProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeRuns?: Record<string, { phase: string | null }>;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onDeleteConversation: (id: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

export function Sidebar({
  conversations,
  activeConversationId,
  activeRuns,
  onSelectConversation,
  onNewChat,
  onDeleteConversation,
  isOpen,
  onToggle,
}: SidebarProps) {
  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          onClick={onToggle}
          className="fixed inset-0 bg-black/20 z-40 md:hidden"
        />
      )}

      <aside
        className={`fixed md:static top-0 bottom-0 left-0 z-50 w-72 bg-white border-r border-gray-200 flex flex-col shrink-0 transition-transform duration-200 ease-in-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0 md:w-72'
        }`}
      >
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 bg-orange-500 rounded-sm" />
            <h2 className="font-bold text-base tracking-wide uppercase">Sift Research</h2>
          </div>
          <button
            onClick={onToggle}
            className="md:hidden text-gray-500 hover:text-gray-800 p-1"
          >
            ✕
          </button>
        </div>

        <div className="p-3">
          <button
            onClick={() => {
              onNewChat();
              if (window.innerWidth < 768) onToggle();
            }}
            className="w-full py-2.5 px-3 bg-gray-900 hover:bg-black text-white text-xs font-semibold rounded-md shadow-sm transition-colors flex items-center justify-center gap-2 cursor-pointer uppercase tracking-wider"
          >
            <span>+</span>
            <span>New Research Chat</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
          <div className="px-2 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
            Prior Conversations ({conversations.length})
          </div>

          {conversations.length === 0 ? (
            <div className="px-3 py-6 text-xs text-gray-400 text-center italic">
              No saved research sessions yet.
            </div>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              const isRunning = Boolean(activeRuns && activeRuns[conv.id]);
              const runPhase = activeRuns?.[conv.id]?.phase;

              let dateStr = '';
              try {
                const d = new Date(conv.updatedAt || conv.createdAt);
                dateStr = d.toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                });
              } catch {
                dateStr = '';
              }

              return (
                <div
                  key={conv.id}
                  className={`group flex items-center justify-between p-2 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-orange-50 text-orange-950 font-semibold border-l-2 border-orange-500'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                  onClick={() => {
                    onSelectConversation(conv.id);
                    if (window.innerWidth < 768) onToggle();
                  }}
                >
                  <div className="flex-1 truncate pr-2">
                    <div className="truncate">{conv.title || 'Untitled Session'}</div>
                    {isRunning ? (
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                        <span className="text-[10px] text-orange-600 font-semibold tracking-wide uppercase">
                          {runPhase ? runPhase.replace('_', ' ') : 'generating'}...
                        </span>
                      </div>
                    ) : (
                      dateStr && (
                        <div className="text-[10px] text-gray-400 font-normal">
                          {dateStr}
                        </div>
                      )
                    )}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteConversation(conv.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 p-1 transition-opacity text-xs"
                    title="Delete conversation"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 border-t border-gray-100 text-[11px] text-gray-400 text-center">
          Sift v1.0 • Web Search & Memory
        </div>
      </aside>
    </>
  );
}
