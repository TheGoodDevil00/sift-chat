import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  ChatPhase,
  ChatEvent,
  MessageWithMeta,
  ClientProviderConfig,
} from '@/types/chat';
import { getProviderKey } from '@/lib/crypto/vault';

export interface UseChatStreamOptions {
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<MessageWithMeta[]>>;
  fetchConversations: () => Promise<void>;
  timezone: string;
}

export function useChatStream({
  activeConversationId,
  setActiveConversationId,
  setMessages,
  fetchConversations,
  timezone,
}: UseChatStreamOptions) {
  const [streamingMessage, setStreamingMessage] = useState<{
    content: string;
    thinking?: string;
    phase: ChatPhase | null;
  } | null>(null);
  const [activePhase, setActivePhase] = useState<ChatPhase | null>(null);
  const [isInternalGenerating, setIsInternalGenerating] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [lastFailedRequestId, setLastFailedRequestId] = useState<string | null>(null);

  // Multi-thread concurrent active runs state
  const [activeRuns, setActiveRuns] = useState<
    Record<string, { phase: ChatPhase | null; status?: string }>
  >({});

  const activeStreamsRef = useRef<Map<string, AbortController>>(new Map());
  const activeConversationIdRef = useRef<string | null>(null);
  const activePhaseRef = useRef<ChatPhase | null>(null);

  // Thread-aware generation status: reflects whether the active conversation is currently generating.
  // Rendering must not read a ref; activeRuns is the render-visible source of truth and is
  // optimistically populated when a send starts, then confirmed by the server.
  const isGenerating = Boolean(
    activeConversationId
      ? activeRuns[activeConversationId]?.status === 'running'
      : isInternalGenerating
  );

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    activePhaseRef.current = activePhase;
  }, [activePhase]);

  // Poll server for active runs across all threads
  const pollActiveRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      if (res.ok) {
        const data = await res.json();
        const serverRuns = data.activeRuns || {};
        setActiveRuns((prev) => {
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
        let accumulatedThinking = '';

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

              if (event.type === 'start') {
                // A reconnecting client may already hold partial text. The server
                // replays the full accumulated answer from the start event, so
                // reset here rather than duplicating the prefix.
                accumulatedContent = '';
                accumulatedThinking = '';
                if (activeConversationIdRef.current === convId) {
                  setActivePhase('retrieving_history');
                  setStreamingMessage({ content: '', phase: 'retrieving_history' });
                }
              } else if (event.type === 'status') {
                setActiveRuns((prev) => ({
                  ...prev,
                  [convId]: { phase: event.phase, status: 'running' },
                }));

                if (activeConversationIdRef.current === convId) {
                  setActivePhase(event.phase);
                  setStreamingMessage((prev) =>
                    prev
                      ? { ...prev, phase: event.phase }
                      : { content: accumulatedContent, thinking: accumulatedThinking, phase: event.phase }
                  );
                }
              } else if (event.type === 'thinking') {
                accumulatedThinking += event.text;

                if (activeConversationIdRef.current === convId) {
                  setActivePhase('thinking');
                  setStreamingMessage({
                    content: accumulatedContent,
                    thinking: accumulatedThinking,
                    phase: 'thinking',
                  });
                }
              } else if (event.type === 'delta') {
                accumulatedContent += event.text;

                if (activeConversationIdRef.current === convId) {
                  setStreamingMessage({
                    content: accumulatedContent,
                    thinking: accumulatedThinking,
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
                    content: event.text || accumulatedContent,
                    thinking: event.thinking || accumulatedThinking || null,
                    created_at: event.createdAt,
                    status: 'complete',
                    citations: event.citations || [],
                    sources: event.sources || [],
                  };

                  setMessages((prev) => [...prev, finalAssistantMsg]);
                  setStreamingMessage(null);
                  setActivePhase(null);
                  setIsInternalGenerating(false);
                  setLastFailedRequestId(null);
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
                  setStreamError(event.message);
                  if (initialPrompt) setLastFailedPrompt(initialPrompt);
                  setStreamingMessage(null);
                  setActivePhase(null);
                  setIsInternalGenerating(false);
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
          setIsInternalGenerating(false);
        }
      }
    },
    [fetchConversations, setMessages]
  );

  // Send message
  const handleSendMessage = useCallback(
    async (prompt: string, providerConfig: ClientProviderConfig, retryRequestId?: string) => {
      const isThreadGenerating = activeConversationId
        ? Boolean(activeStreamsRef.current.has(activeConversationId) || activeRuns[activeConversationId]?.status === 'running')
        : isInternalGenerating;
      if (isThreadGenerating) return;

      setStreamError(null);
      setLastFailedPrompt(null);
      setLastFailedRequestId(null);
      setIsInternalGenerating(true);
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
      if (activeConversationId) {
        setActiveRuns((prev) => ({
          ...prev,
          [activeConversationId]: { phase: 'retrieving_history', status: 'running' },
        }));
      }

      // A retry reuses the original request id so the server can reuse the failed
      // assistant row instead of creating a duplicate user/assistant pair.
      const clientRequestId =
        retryRequestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      let effectiveConfig = providerConfig;
      if (!effectiveConfig.apiKey) {
        const decryptedKey = await getProviderKey(effectiveConfig.provider);
        if (decryptedKey) {
          effectiveConfig = { ...effectiveConfig, apiKey: decryptedKey };
        }
      }

      // Load search provider keys from vault if present
      const [exaKey, firecrawlKey, tavilyKey] = await Promise.all([
        getProviderKey('exa'),
        getProviderKey('firecrawl'),
        getProviderKey('tavily'),
      ]);

      effectiveConfig = {
        ...effectiveConfig,
        searchKeys: {
          exa: exaKey || effectiveConfig.searchKeys?.exa || undefined,
          firecrawl: firecrawlKey || effectiveConfig.searchKeys?.firecrawl || undefined,
          tavily: tavilyKey || effectiveConfig.searchKeys?.tavily || undefined,
        },
      };

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
        let accumulatedThinking = '';
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

            try {
              const event: ChatEvent = JSON.parse(trimmed.slice(6));

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
              } else if (event.type === 'thinking') {
                accumulatedThinking += event.text;
                if (activeConversationIdRef.current === currentConvId) {
                  setActivePhase('thinking');
                  setStreamingMessage({
                    content: accumulatedContent,
                    thinking: accumulatedThinking,
                    phase: 'thinking',
                  });
                }
              } else if (event.type === 'delta') {
                accumulatedContent += event.text;
                if (activeConversationIdRef.current === currentConvId) {
                  setStreamingMessage({
                    content: accumulatedContent,
                    thinking: accumulatedThinking,
                    phase: activePhaseRef.current || 'writing',
                  });
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
                    content: event.text || accumulatedContent,
                    thinking: event.thinking || accumulatedThinking || null,
                    created_at: event.createdAt,
                    status: 'complete',
                    citations: event.citations || [],
                    sources: event.sources || [],
                  };

                  setMessages((prev) => [...prev, finalAssistantMsg]);
                  setStreamingMessage(null);
                  setActivePhase(null);
                  setIsInternalGenerating(false);
                  setLastFailedRequestId(null);
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
                  setStreamError(event.message);
                  setLastFailedPrompt(prompt);
                  setLastFailedRequestId(clientRequestId);
                  setStreamingMessage(null);
                  setActivePhase(null);
                  setIsInternalGenerating(false);
                }
              }
            } catch (pErr) {
              console.warn('Failed to parse SSE line:', trimmed, pErr);
            }
          }
        }
      } catch (err: any) {
        console.error('Error during chat request:', err);
        setStreamError(err?.message || 'Failed to complete research response.');
        setLastFailedPrompt(prompt);
        setLastFailedRequestId(clientRequestId);
        setStreamingMessage(null);
        setActivePhase(null);
        setIsInternalGenerating(false);
        if (activeConversationId) {
          setActiveRuns((prev) => {
            const next = { ...prev };
            delete next[activeConversationId];
            return next;
          });
        }
      }
    },
    [activeConversationId, activeRuns, isInternalGenerating, timezone, setActiveConversationId, setMessages, fetchConversations]
  );

  // Stop / Cancel active generation
  const handleStopGenerating = useCallback(async () => {
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

    setIsInternalGenerating(false);
    setActivePhase(null);
    setStreamingMessage(null);
  }, [activeConversationId]);

  const abortStream = useCallback((id: string) => {
    if (activeStreamsRef.current.has(id)) {
      activeStreamsRef.current.get(id)?.abort();
      activeStreamsRef.current.delete(id);
    }
  }, []);

  return {
    streamingMessage,
    setStreamingMessage,
    activePhase,
    setActivePhase,
    isGenerating,
    setIsGenerating: setIsInternalGenerating,
    streamError,
    setStreamError,
    lastFailedPrompt,
    setLastFailedPrompt,
    lastFailedRequestId,
    setLastFailedRequestId,
    activeRuns,
    setActiveRuns,
    activeStreamsRef,
    connectToThreadStream,
    handleSendMessage,
    handleStopGenerating,
    abortStream,
  };
}
