'use client';

import React, { useState, useCallback } from 'react';
import { Sidebar } from './Sidebar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { EmptyState } from './EmptyState';
import { StatusIndicator } from './StatusIndicator';
import {
  ProviderSettingsModal,
  ALL_SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
} from './ProviderSettingsModal';
import { useProviderConfig } from '@/hooks/useProviderConfig';
import { useConversations } from '@/hooks/useConversations';
import { useChatStream } from '@/hooks/useChatStream';

export function SiftChat() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Detect user's local IANA timezone
  const [timezone] = useState(() => {
    if (typeof window === 'undefined') return 'UTC';
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });

  // 1. Provider & Key Configuration Hook
  const {
    providerConfig,
    serverStatus,
    vaultStatuses,
    isSettingsOpen,
    setIsSettingsOpen,
    isProviderMenuOpen,
    setIsProviderMenuOpen,
    isSoftPrompt,
    setIsSoftPrompt,
    providerMenuRef,
    handleQuickSwitchProvider,
    handleSaveProviderConfig,
  } = useProviderConfig();

  // Callback for automatic stream reconnection when loading an active background task
  const connectToThreadStreamRef = React.useRef<((id: string, initialAccumulated?: string) => void) | null>(null);

  const handleConversationLoaded = useCallback((id: string, activeRun?: any) => {
    if (activeRun && activeRun.status === 'running') {
      connectToThreadStreamRef.current?.(id, activeRun.accumulatedText || '');
    }
  }, []);

  // 2. Conversations & Message History Hook
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    messages,
    setMessages,
    error: convError,
    setError: setConvError,
    fetchConversations,
    loadConversation: baseLoadConversation,
    handleNewChat: baseHandleNewChat,
    handleDeleteConversation: baseHandleDeleteConversation,
  } = useConversations(handleConversationLoaded);

  // 3. Chat Streaming & Multi-Thread Execution Hook
  const {
    streamingMessage,
    activePhase,
    isGenerating,
    streamError,
    setStreamError,
    lastFailedPrompt,
    lastFailedRequestId,
    activeRuns,
    connectToThreadStream,
    handleSendMessage: streamSendMessage,
    handleStopGenerating,
    abortStream,
  } = useChatStream({
    activeConversationId,
    setActiveConversationId,
    setMessages,
    fetchConversations,
    timezone,
  });

  React.useEffect(() => {
    connectToThreadStreamRef.current = connectToThreadStream;
  }, [connectToThreadStream]);

  const error = streamError || convError;

  const isLocalProvider =
    providerConfig.provider === 'ollama' || providerConfig.provider === 'local';
  const isActiveProviderConfigured = Boolean(
    isLocalProvider ||
      vaultStatuses[providerConfig.provider]?.isConfigured ||
      serverStatus?.providers[providerConfig.provider]
  );

  // Load conversation and reconnect to thread stream if active on server
  const loadConversation = useCallback(
    async (id: string) => {
      setStreamError(null);
      await baseLoadConversation(id);
      if (activeRuns[id] && activeRuns[id].status === 'running') {
        connectToThreadStream(id);
      }
    },
    [baseLoadConversation, setStreamError, activeRuns, connectToThreadStream]
  );

  const handleNewChat = useCallback(() => {
    baseHandleNewChat();
    setStreamError(null);
  }, [baseHandleNewChat, setStreamError]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      await baseHandleDeleteConversation(id, (convId) => {
        abortStream(convId);
      });
    },
    [baseHandleDeleteConversation, abortStream]
  );

  const handleSendMessage = useCallback(
    async (prompt: string, retryRequestId?: string) => {
      setConvError(null);
      await streamSendMessage(prompt, providerConfig, retryRequestId);
    },
    [streamSendMessage, providerConfig, setConvError]
  );

  const handleRetry = useCallback(() => {
    if (lastFailedPrompt) {
      setMessages((prev) => prev.slice(0, -1));
      handleSendMessage(lastFailedPrompt, lastFailedRequestId || undefined);
    }
  }, [lastFailedPrompt, lastFailedRequestId, handleSendMessage, setMessages]);

  const handleCloseModal = useCallback(() => {
    if (isSoftPrompt) {
      sessionStorage.setItem('sift_soft_prompt_dismissed', 'true');
    }
    setIsSettingsOpen(false);
    setIsSoftPrompt(false);
  }, [isSoftPrompt, setIsSettingsOpen, setIsSoftPrompt]);

  return (
    <div className="flex h-screen overflow-hidden bg-[#fbfbfb]">
      {/* Sidebar with conversation history and active background run badges */}
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        activeRuns={activeRuns}
        onSelectConversation={loadConversation}
        onNewChat={handleNewChat}
        onDeleteConversation={handleDeleteConversation}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
        {/* Header */}
        <header className="px-4 py-3 border-b border-gray-200 bg-white/90 backdrop-blur-sm flex items-center justify-between sticky top-0 z-10 shrink-0">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-1.5 text-gray-600 hover:text-black rounded md:hidden border border-gray-300"
              title="Toggle history sidebar"
            >
              ☰
            </button>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight uppercase flex items-center gap-2">
              <img
                src="/sift-favicon.png"
                alt="Sift Logo"
                className="w-6 h-6 rounded object-contain shrink-0"
              />
              <span>Sift</span>
              <span className="text-xs font-normal text-gray-500 normal-case hidden sm:inline border-l pl-2 border-gray-300">
                Temporal Web Research Agent
              </span>
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {isGenerating && (
              <button
                onClick={handleStopGenerating}
                className="px-2.5 py-1 text-xs border border-red-300 hover:bg-red-50 text-red-600 rounded font-mono font-medium cursor-pointer flex items-center gap-1 shadow-2xs"
                title="Stop current generation"
              >
                <span>⏹</span>
                <span>Stop</span>
              </button>
            )}

            {/* Model Provider Selector & Quick-Switch Dropdown */}
            <div className="relative" ref={providerMenuRef}>
              <button
                onClick={() => setIsProviderMenuOpen(!isProviderMenuOpen)}
                className="px-2.5 py-1 text-xs border border-gray-300 hover:border-orange-500 hover:bg-orange-50/50 rounded font-mono text-gray-700 flex items-center gap-1.5 cursor-pointer transition-colors shadow-2xs"
                title="Select Active Provider or Configure Keys"
              >
                <span className="w-1.5 h-1.5 bg-orange-500 rounded-full" />
                <span className="font-semibold uppercase">{providerConfig.provider}</span>
                <span className="text-gray-400 hidden lg:inline">
                  ({providerConfig.model || 'select model'})
                </span>
                <span className="text-gray-400 text-[10px]">▼</span>
              </button>

              {isProviderMenuOpen && (
                <div className="absolute right-0 mt-1 w-64 bg-white border-2 border-gray-300 rounded shadow-xl py-1 z-50 text-xs font-mono animate-pop-in">
                  <div className="px-3 py-1.5 border-b border-gray-100 flex items-center justify-between">
                    <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                      Provider & Model
                    </span>
                    <span
                      className="text-[10px] font-mono text-orange-600 font-semibold truncate max-w-[120px]"
                      title={providerConfig.model}
                    >
                      {providerConfig.model || 'none'}
                    </span>
                  </div>

                  <div className="max-h-60 overflow-y-auto py-1">
                    {ALL_SUPPORTED_PROVIDERS.map((prov) => {
                      const isLocal = prov === 'ollama' || prov === 'local';
                      const isConfigured = Boolean(
                        isLocal || vaultStatuses[prov]?.isConfigured || serverStatus?.providers[prov]
                      );
                      const isCurrent = providerConfig.provider === prov;
                      const fingerprint = isLocal ? 'localhost' : vaultStatuses[prov]?.fingerprint;

                      return (
                        <button
                          key={prov}
                          type="button"
                          onClick={() => handleQuickSwitchProvider(prov)}
                          className={`w-full px-3 py-2 text-left flex items-center justify-between hover:bg-orange-50 cursor-pointer ${
                            isCurrent
                              ? 'bg-orange-50/70 font-bold text-orange-900'
                              : 'text-gray-800'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full ${
                                isConfigured ? 'bg-emerald-500' : 'bg-gray-300'
                              }`}
                              title={isConfigured ? 'Key Configured' : 'Not Configured'}
                            />
                            <span>{PROVIDER_LABELS[prov]}</span>
                          </div>

                          <div className="flex items-center gap-1 text-[10px] text-gray-400 font-normal">
                            {isConfigured ? (
                              <span className="text-emerald-700 font-mono">
                                {fingerprint || 'ready'}
                              </span>
                            ) : (
                              <span>no key</span>
                            )}
                            {isCurrent && (
                              <span className="text-orange-600 font-bold ml-1">✓</span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="border-t border-gray-100 pt-1 mt-1 px-1">
                    <button
                      type="button"
                      onClick={() => {
                        setIsProviderMenuOpen(false);
                        setIsSoftPrompt(false);
                        setIsSettingsOpen(true);
                      }}
                      className="w-full text-left px-2.5 py-1.5 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded font-medium flex items-center justify-between cursor-pointer"
                    >
                      <span>⚙ Manage Providers & Keys...</span>
                      <span className="text-[10px] text-gray-400">AES-256</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <StatusIndicator
              phase={activePhase}
              error={error}
              configured={isActiveProviderConfigured}
            />
          </div>
        </header>

        {/* Scrollable Conversation Content */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-2 md:p-6 min-w-0">
          <div className="max-w-4xl mx-auto w-full min-w-0 pb-4">
            {messages.length === 0 && !streamingMessage ? (
              <EmptyState onSelectPrompt={handleSendMessage} />
            ) : (
              <MessageList messages={messages} streamingMessage={streamingMessage} />
            )}

            {/* Recoverable Error Banner */}
            {error && (
              <div className="my-3 p-3 bg-red-50 border border-red-300 rounded-md text-xs text-red-700 flex items-center justify-between shadow-2xs">
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
          </div>
        </main>

        {/* Composer Footer (Anchored, non-overlapping) */}
        <footer className="shrink-0 border-t border-gray-200 bg-white/95 backdrop-blur-sm px-2 md:px-6 py-3 z-10">
          <div className="max-w-4xl mx-auto w-full">
            <MessageInput
              onSendMessage={handleSendMessage}
              onNewChat={handleNewChat}
              disabled={isGenerating}
            />
          </div>
        </footer>
      </div>

      {/* Provider & Key Settings Modal / Soft Prompt */}
      <ProviderSettingsModal
        isOpen={isSettingsOpen}
        onClose={handleCloseModal}
        serverStatus={serverStatus}
        activeConfig={providerConfig}
        onSaveConfig={handleSaveProviderConfig}
        isSoftPrompt={isSoftPrompt}
      />
    </div>
  );
}
