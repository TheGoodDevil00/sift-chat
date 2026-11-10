'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type {
  ConversationSummary,
  MessageWithMeta,
  ChatPhase,
  ChatEvent,
  SupportedProvider,
  ClientProviderConfig,
} from '@/types/chat';
import { Sidebar } from './Sidebar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { EmptyState } from './EmptyState';
import { StatusIndicator } from './StatusIndicator';
import {
  ProviderSettingsModal,
  type ProviderServerStatus,
} from './ProviderSettingsModal';

export function SiftChat() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<{
    content: string;
    phase: ChatPhase | null;
  } | null>(null);
  const [activePhase, setActivePhase] = useState<ChatPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Multi-provider configuration state
  const [serverStatus, setServerStatus] = useState<ProviderServerStatus | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSoftPrompt, setIsSoftPrompt] = useState(false);
  const [providerConfig, setProviderConfig] = useState<ClientProviderConfig>({
    provider: 'openai',
    model: 'gpt-6-astra',
  });

  // Detect user's local IANA timezone
  const [timezone, setTimezone] = useState('UTC');
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) setTimezone(tz);
    } catch {
      setTimezone('UTC');
    }
  }, []);

  // Fetch server provider & env status on page load
  useEffect(() => {
    async function initConfig() {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          const data: ProviderServerStatus = await res.json();
          setServerStatus(data);

          // Restore stored preferences from browser localStorage
          const savedProvider = (localStorage.getItem('sift_active_provider') as SupportedProvider) || data.defaultProvider || 'openai';
          const savedModel = localStorage.getItem(`sift_model_${savedProvider}`) || data.availableModels[savedProvider]?.[0]?.id || 'gpt-6-astra';
          const savedKey = localStorage.getItem(`sift_key_${savedProvider}`) || '';

          const restoredConfig: ClientProviderConfig = {
            provider: savedProvider,
            model: savedModel,
            apiKey: savedKey || undefined,
          };
          setProviderConfig(restoredConfig);

          // Soft prompt check: if server has NO keys set up AND client has NO key saved, trigger soft prompt
          const hasAnyClientKey = Boolean(savedKey);
          const hasDismissed = sessionStorage.getItem('sift_soft_prompt_dismissed') === 'true';

          if (!data.hasAnyKey && !hasAnyClientKey && !hasDismissed) {
            setIsSoftPrompt(true);
            setIsSettingsOpen(true);
          }
        }
      } catch (err) {
        console.warn('Failed to load server config status:', err);
      }
    }
    initConfig();
  }, []);

  // Fetch conversations list
  const fetchConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations');
      if (res.ok) {
        const data = await res.json();
        setConversations(data.conversations || []);
      }
    } catch (err) {
      console.error('Failed to load conversations:', err);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Load a conversation's messages
  const loadConversation = useCallback(async (id: string) => {
    try {
      setError(null);
      const res = await fetch(`/api/conversations/${id}`);
      if (res.ok) {
        const data = await res.json();
        setActiveConversationId(id);
        setMessages(data.conversation.messages || []);
      } else {
        setError('Could not load historical conversation.');
      }
    } catch (err) {
      console.error('Failed to load conversation details:', err);
      setError('Network error loading conversation.');
    }
  }, []);

  // Start new chat
  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    setMessages([]);
    setStreamingMessage(null);
    setActivePhase(null);
    setError(null);
    setLastFailedPrompt(null);
  }, []);

  // Delete conversation
  const handleDeleteConversation = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
        if (res.ok) {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (activeConversationId === id) {
            handleNewChat();
          }
        }
      } catch (err) {
        console.error('Failed to delete conversation:', err);
      }
    },
    [activeConversationId, handleNewChat]
  );

  // Send message
  const handleSendMessage = async (prompt: string) => {
    if (isGenerating) return;

    setError(null);
    setLastFailedPrompt(null);
    setIsGenerating(true);
    setActivePhase('retrieving_history');

    const tempUserId = `user-${Date.now()}`;
    const userMsg: MessageWithMeta = {
      id: tempUserId,
      conversation_id: activeConversationId || 'pending',
      role: 'user',
      content: prompt,
      created_at: new Date().toISOString(),
      status: 'complete',
      citations: [],
      sources: [],
    };

    setMessages((prev) => [...prev, userMsg]);
    setStreamingMessage({ content: '', phase: 'retrieving_history' });

    const clientRequestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          conversationId: activeConversationId,
          message: prompt,
          timezone,
          clientRequestId,
          providerConfig,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Server responded with ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Readable stream not supported by browser.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const jsonStr = trimmed.slice(6);
          try {
            const event: ChatEvent = JSON.parse(jsonStr);

            if (event.type === 'start') {
              setActiveConversationId(event.conversationId);
            } else if (event.type === 'status') {
              setActivePhase(event.phase);
              setStreamingMessage((prev) =>
                prev ? { ...prev, phase: event.phase } : null
              );
            } else if (event.type === 'delta') {
              accumulatedContent += event.text;
              setStreamingMessage((prev) =>
                prev ? { ...prev, content: accumulatedContent } : null
              );
            } else if (event.type === 'complete') {
              const finalAssistantMsg: MessageWithMeta = {
                id: event.assistantMessageId,
                conversation_id: activeConversationId || '',
                role: 'assistant',
                content: accumulatedContent,
                created_at: event.createdAt,
                status: 'complete',
                citations: event.citations || [],
                sources: event.sources || [],
              };

              setMessages((prev) => [...prev, finalAssistantMsg]);
              setStreamingMessage(null);
              setActivePhase(null);
              fetchConversations();
            } else if (event.type === 'error') {
              setError(event.message);
              setLastFailedPrompt(prompt);
              setStreamingMessage(null);
              setActivePhase(null);
            }
          } catch (pErr) {
            console.warn('Failed to parse SSE line:', trimmed, pErr);
          }
        }
      }
    } catch (err: any) {
      console.error('Error during chat request:', err);
      setError(err?.message || 'Failed to complete research response.');
      setLastFailedPrompt(prompt);
      setStreamingMessage(null);
      setActivePhase(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRetry = () => {
    if (lastFailedPrompt) {
      setMessages((prev) => prev.slice(0, -1));
      handleSendMessage(lastFailedPrompt);
    }
  };

  const handleCloseModal = () => {
    if (isSoftPrompt) {
      sessionStorage.setItem('sift_soft_prompt_dismissed', 'true');
    }
    setIsSettingsOpen(false);
    setIsSoftPrompt(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#fbfbfb]">
      {/* Sidebar with conversation history */}
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelectConversation={loadConversation}
        onNewChat={handleNewChat}
        onDeleteConversation={handleDeleteConversation}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="px-4 py-3 border-b border-gray-200 bg-white/90 backdrop-blur-sm flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 text-gray-600 hover:text-black rounded md:hidden border border-gray-300"
              title="Toggle history sidebar"
            >
              ☰
            </button>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight uppercase flex items-center gap-2">
              <span>Sift</span>
              <span className="text-xs font-normal text-gray-500 normal-case hidden sm:inline border-l pl-2 border-gray-300">
                Temporal Web Research Agent
              </span>
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Model Provider Selector Button */}
            <button
              onClick={() => {
                setIsSoftPrompt(false);
                setIsSettingsOpen(true);
              }}
              className="px-2.5 py-1 text-xs border border-gray-300 hover:border-orange-500 hover:bg-orange-50/50 rounded font-mono text-gray-700 flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
              title="Configure Model Provider & API Key"
            >
              <span className="w-1.5 h-1.5 bg-orange-500 rounded-full" />
              <span className="font-semibold uppercase">{providerConfig.provider}</span>
              <span className="text-gray-400 hidden lg:inline">({providerConfig.model})</span>
              <span className="text-gray-400 text-[10px]">⚙</span>
            </button>

            <StatusIndicator phase={activePhase} error={error} />
          </div>
        </header>

        {/* Scrollable Conversation Content */}
        <main className="flex-1 overflow-y-auto p-2 md:p-6 flex flex-col justify-between">
          {messages.length === 0 && !streamingMessage ? (
            <EmptyState onSelectPrompt={handleSendMessage} />
          ) : (
            <MessageList messages={messages} streamingMessage={streamingMessage} />
          )}

          {/* Recoverable Error Banner */}
          {error && (
            <div className="max-w-4xl mx-auto w-full my-3 p-3 bg-red-50 border border-red-300 rounded-md text-xs text-red-700 flex items-center justify-between">
              <span>{error}</span>
              <div className="flex items-center gap-2 ml-3">
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="px-2.5 py-1 border border-red-400 hover:bg-red-100 text-red-800 font-medium rounded cursor-pointer"
                >
                  Configure Key
                </button>
                {lastFailedPrompt && (
                  <button
                    onClick={handleRetry}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white font-semibold rounded cursor-pointer"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Composer */}
          <MessageInput
            onSendMessage={handleSendMessage}
            onNewChat={handleNewChat}
            disabled={isGenerating}
          />
        </main>
      </div>

      {/* Provider & Key Settings Modal / Soft Prompt */}
      <ProviderSettingsModal
        isOpen={isSettingsOpen}
        onClose={handleCloseModal}
        serverStatus={serverStatus}
        activeConfig={providerConfig}
        onSaveConfig={(newConfig) => setProviderConfig(newConfig)}
        isSoftPrompt={isSoftPrompt}
      />
    </div>
  );
}
