'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  ALL_SUPPORTED_PROVIDERS,
  PROVIDER_LABELS,
} from './ProviderSettingsModal';
import {
  getProviderKey,
  getVaultStatuses,
  migrateLegacyPlaintextKeys,
  type ProviderKeyStatus,
} from '@/lib/crypto/vault';

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

  // Multi-thread concurrent active runs state (conversationId -> run status)
  const [activeRuns, setActiveRuns] = useState<
    Record<string, { phase: ChatPhase | null; status?: string }>
  >({});

  // Active HTTP stream readers map (conversationId -> AbortController)
  const activeStreamsRef = useRef<Map<string, AbortController>>(new Map());

  // Refs for access inside asynchronous stream loops
  const activeConversationIdRef = useRef<string | null>(null);
  const activePhaseRef = useRef<ChatPhase | null>(null);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activePhaseRef.current = activePhase;
  }, [activePhase]);

  // Multi-provider configuration state
  const [serverStatus, setServerStatus] = useState<ProviderServerStatus | null>(null);
  const [vaultStatuses, setVaultStatuses] = useState<
    Record<SupportedProvider, ProviderKeyStatus>
  >({} as Record<SupportedProvider, ProviderKeyStatus>);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const [isSoftPrompt, setIsSoftPrompt] = useState(false);
  const [providerConfig, setProviderConfig] = useState<ClientProviderConfig>({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  });
  const providerMenuRef = useRef<HTMLDivElement>(null);

  // Close provider menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        providerMenuRef.current &&
        !providerMenuRef.current.contains(event.target as Node)
      ) {
        setIsProviderMenuOpen(false);
      }
    }
    if (isProviderMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isProviderMenuOpen]);

  // Detect user's local IANA timezone
  const [timezone] = useState(() => {
    if (typeof window === 'undefined') return 'UTC';
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  });

  // Fetch server provider & env status on page load, migrate legacy keys, and initialize encrypted vault
  useEffect(() => {
    async function initConfig() {
      try {
        await migrateLegacyPlaintextKeys();
        const initialVaultStatuses = await getVaultStatuses();
        setVaultStatuses(initialVaultStatuses);

        const res = await fetch('/api/config');
        if (res.ok) {
          const data: ProviderServerStatus = await res.json();
          setServerStatus(data);

          // Restore stored preferences from browser localStorage
          const savedProvider =
            (localStorage.getItem('sift_active_provider') as SupportedProvider) ||
            data.defaultProvider ||
            'groq';
          const savedModel =
            localStorage.getItem(`sift_model_${savedProvider}`) ||
            data.defaultModels?.[savedProvider] ||
            '';
          const savedKey = await getProviderKey(savedProvider);

          const restoredConfig: ClientProviderConfig = {
            provider: savedProvider,
            model: savedModel,
            apiKey: savedKey || undefined,
          };
          setProviderConfig(restoredConfig);

          // Soft prompt check: if server has NO keys set up AND client has NO key saved, trigger soft prompt
          const hasAnyVaultKey = Object.values(initialVaultStatuses).some(
            (v) => v.isConfigured
          );
          const hasDismissed = sessionStorage.getItem('sift_soft_prompt_dismissed') === 'true';

          if (!data.hasAnyKey && !hasAnyVaultKey && !hasDismissed) {
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

  const handleQuickSwitchProvider = async (newProv: SupportedProvider) => {
    try {
      localStorage.setItem('sift_active_provider', newProv);
    } catch {}

    const key = await getProviderKey(newProv);
    const model =
      localStorage.getItem(`sift_model_${newProv}`) ||
      serverStatus?.defaultModels?.[newProv] ||
      '';

    setProviderConfig({
      provider: newProv,
      model,
      apiKey: key || undefined,
    });
    setIsProviderMenuOpen(false);
  };

  const handleSaveProviderConfig = async (newConfig: ClientProviderConfig) => {
    setProviderConfig(newConfig);
    try {
      const refreshedStatuses = await getVaultStatuses();
      setVaultStatuses(refreshedStatuses);
    } catch (err) {
      console.warn('Failed to refresh vault statuses after save:', err);
    }
  };

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

  // Poll server for active runs across all threads
  const pollActiveRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      if (res.ok) {
        const data = await res.json();
        const serverRuns = data.activeRuns || {};
        setActiveRuns((prev) => {
          // Merge server runs with local active streams
          const merged: Record<string, { phase: ChatPhase | null; status?: string }> = {};
          for (const [id, r] of Object.entries(serverRuns) as [string, any][]) {
            merged[id] = { phase: r.phase, status: r.status };
          }
          for (const [id] of activeStreamsRef.current.entries()) {
            if (!merged[id]) {
              merged[id] = prev[id] || { phase: 'writing', status: 'running' };
            }
          }
          return merged;
        });
      }
    } catch (err) {
      console.warn('Could not poll active runs:', err);
    }
  }, []);

  useEffect(() => {
    pollActiveRuns();
    const interval = setInterval(pollActiveRuns, 3500);
    return () => clearInterval(interval);
  }, [pollActiveRuns]);

  // Connect to an ongoing background SSE stream for a thread
  const connectToThreadStream = useCallback(
    async (convId: string, initialAccumulated = '', initialPrompt?: string) => {
      // Avoid duplicate readers for the same conversation
      if (activeStreamsRef.current.has(convId)) return;

      const controller = new AbortController();
      activeStreamsRef.current.set(convId, controller);

      setActiveRuns((prev) => ({
        ...prev,
        [convId]: { phase: 'retrieving_history', status: 'running' },
      }));

      try {
        const res = await fetch(`/api/chat/stream?conversationId=${convId}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          activeStreamsRef.current.delete(convId);
          setActiveRuns((prev) => {
            const next = { ...prev };
            delete next[convId];
            return next;
          });
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';
        let accumulatedContent = initialAccumulated;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            try {
              const event: ChatEvent = JSON.parse(trimmed.slice(6));

              if (event.type === 'status') {
                setActiveRuns((prev) => ({
                  ...prev,
                  [convId]: { phase: event.phase, status: 'running' },
                }));

                if (activeConversationIdRef.current === convId) {
                  setActivePhase(event.phase);
                  setStreamingMessage((prev) =>
                    prev
                      ? { ...prev, phase: event.phase }
                      : { content: accumulatedContent, phase: event.phase }
                  );
                }
              } else if (event.type === 'delta') {
                accumulatedContent += event.text;

                if (activeConversationIdRef.current === convId) {
                  setStreamingMessage({
                    content: accumulatedContent,
                    phase: activePhaseRef.current || 'writing',
                  });
                }
              } else if (event.type === 'complete') {
                activeStreamsRef.current.delete(convId);
                setActiveRuns((prev) => {
                  const next = { ...prev };
                  delete next[convId];
                  return next;
                });

                if (activeConversationIdRef.current === convId) {
                  const finalAssistantMsg: MessageWithMeta = {
                    id: event.assistantMessageId,
                    conversation_id: convId,
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
                  setIsGenerating(false);
                }
                fetchConversations();
              } else if (event.type === 'error') {
                activeStreamsRef.current.delete(convId);
                setActiveRuns((prev) => {
                  const next = { ...prev };
                  delete next[convId];
                  return next;
                });

                if (activeConversationIdRef.current === convId) {
                  setError(event.message);
                  if (initialPrompt) setLastFailedPrompt(initialPrompt);
                  setStreamingMessage(null);
                  setActivePhase(null);
                  setIsGenerating(false);
                }
              }
            } catch (pErr) {
              console.warn('Failed to parse SSE line:', trimmed, pErr);
            }
          }
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error('Stream connection error for thread:', convId, err);
        }
      } finally {
        activeStreamsRef.current.delete(convId);
        setActiveRuns((prev) => {
          const next = { ...prev };
          delete next[convId];
          return next;
        });
        if (activeConversationIdRef.current === convId) {
          setIsGenerating(false);
        }
      }
    },
    [fetchConversations]
  );

  // Load a conversation's messages and reconnect to its active task if running
  const loadConversation = useCallback(
    async (id: string) => {
      try {
        localStorage.setItem('sift_active_conversation_id', id);
        setActiveConversationId(id);
        setError(null);

        const res = await fetch(`/api/conversations/${id}`);
        if (res.ok) {
          const data = await res.json();
          setMessages(data.conversation.messages || []);

          if (data.activeRun) {
            // Thread is actively generating on the server! Reconnect smoothly.
            setIsGenerating(true);
            setActivePhase(data.activeRun.phase);
            setStreamingMessage({
              content: data.activeRun.accumulatedText || '',
              phase: data.activeRun.phase,
            });

            if (!activeStreamsRef.current.has(id)) {
              connectToThreadStream(id, data.activeRun.accumulatedText || '');
            }
          } else {
            // Not running on server
            if (!activeStreamsRef.current.has(id)) {
              setIsGenerating(false);
              setActivePhase(null);
              setStreamingMessage(null);
            }
          }
        } else {
          setError('Could not load historical conversation.');
        }
      } catch (err) {
        console.error('Failed to load conversation details:', err);
        setError('Network error loading conversation.');
      }
    },
    [connectToThreadStream]
  );

  // Restore previous active conversation on page mount/reload
  useEffect(() => {
    const savedId = localStorage.getItem('sift_active_conversation_id');
    if (savedId && !activeConversationId) {
      loadConversation(savedId);
    }
  }, [loadConversation, activeConversationId]);

  // Start new chat
  const handleNewChat = useCallback(() => {
    try {
      localStorage.removeItem('sift_active_conversation_id');
    } catch {}
    setActiveConversationId(null);
    setMessages([]);
    setStreamingMessage(null);
    setActivePhase(null);
    setError(null);
    setLastFailedPrompt(null);
    setIsGenerating(false);
  }, []);

  // Delete conversation
  const handleDeleteConversation = useCallback(
    async (id: string) => {
      try {
        // Abort active stream if any
        if (activeStreamsRef.current.has(id)) {
          activeStreamsRef.current.get(id)?.abort();
          activeStreamsRef.current.delete(id);
        }

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

    // Ensure active provider key is loaded from the encrypted vault if available
    let effectiveConfig = providerConfig;
    if (!effectiveConfig.apiKey) {
      const decryptedKey = await getProviderKey(effectiveConfig.provider);
      if (decryptedKey) {
        effectiveConfig = { ...effectiveConfig, apiKey: decryptedKey };
        setProviderConfig(effectiveConfig);
      }
    }

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
          providerConfig: effectiveConfig,
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
      let currentConvId = activeConversationId;

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
              currentConvId = event.conversationId;
              localStorage.setItem('sift_active_conversation_id', event.conversationId);
              setActiveConversationId(event.conversationId);
              setActiveRuns((prev) => ({
                ...prev,
                [event.conversationId]: { phase: 'retrieving_history', status: 'running' },
              }));
            } else if (event.type === 'status') {
              if (currentConvId) {
                setActiveRuns((prev) => ({
                  ...prev,
                  [currentConvId!]: { phase: event.phase, status: 'running' },
                }));
              }
              if (activeConversationIdRef.current === currentConvId) {
                setActivePhase(event.phase);
                setStreamingMessage((prev) =>
                  prev ? { ...prev, phase: event.phase } : null
                );
              }
            } else if (event.type === 'delta') {
              accumulatedContent += event.text;
              if (activeConversationIdRef.current === currentConvId) {
                setStreamingMessage((prev) =>
                  prev ? { ...prev, content: accumulatedContent } : null
                );
              }
            } else if (event.type === 'complete') {
              if (currentConvId) {
                setActiveRuns((prev) => {
                  const next = { ...prev };
                  delete next[currentConvId!];
                  return next;
                });
              }

              if (activeConversationIdRef.current === currentConvId) {
                const finalAssistantMsg: MessageWithMeta = {
                  id: event.assistantMessageId,
                  conversation_id: currentConvId || '',
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
                setIsGenerating(false);
              }
              fetchConversations();
            } else if (event.type === 'error') {
              if (currentConvId) {
                setActiveRuns((prev) => {
                  const next = { ...prev };
                  delete next[currentConvId!];
                  return next;
                });
              }
              if (activeConversationIdRef.current === currentConvId) {
                setError(event.message);
                setLastFailedPrompt(prompt);
                setStreamingMessage(null);
                setActivePhase(null);
                setIsGenerating(false);
              }
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
      setIsGenerating(false);
    }
  };

  // Stop / Cancel active generation
  const handleStopGenerating = async () => {
    if (!activeConversationId) return;

    try {
      await fetch('/api/chat/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConversationId }),
      });
    } catch (err) {
      console.warn('Failed to cancel run:', err);
    }

    if (activeStreamsRef.current.has(activeConversationId)) {
      activeStreamsRef.current.get(activeConversationId)?.abort();
      activeStreamsRef.current.delete(activeConversationId);
    }

    setActiveRuns((prev) => {
      const next = { ...prev };
      delete next[activeConversationId];
      return next;
    });

    setIsGenerating(false);
    setActivePhase(null);
    setStreamingMessage(null);
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
                  <div className="px-3 py-1.5 border-b border-gray-100 text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                    Select Active Provider
                  </div>

                  <div className="max-h-60 overflow-y-auto py-1">
                    {ALL_SUPPORTED_PROVIDERS.map((prov) => {
                      const isConfigured = Boolean(
                        vaultStatuses[prov]?.isConfigured || serverStatus?.providers[prov]
                      );
                      const isCurrent = providerConfig.provider === prov;
                      const fingerprint = vaultStatuses[prov]?.fingerprint;

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
        onSaveConfig={handleSaveProviderConfig}
        isSoftPrompt={isSoftPrompt}
      />
    </div>
  );
}
