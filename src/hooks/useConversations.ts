import { useState, useEffect, useCallback } from 'react';
import type { ConversationSummary, MessageWithMeta } from '@/types/chat';

export function useConversations(onConversationLoaded?: (id: string, activeRun?: any) => void) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  // Load a conversation's messages and status
  const loadConversation = useCallback(
    async (id: string) => {
      try {
        localStorage.setItem('sift_active_conversation_id', id);
        setActiveConversationId(id);
        setError(null);

        const res = await fetch(`/api/conversations/${id}`);
        if (res.ok) {
          const data = await res.json();
          // A run writes an empty placeholder row before the first token. Hide it
          // while it is streaming; the live streaming bubble represents it.
          const loadedMessages: MessageWithMeta[] = (data.conversation?.messages || []).filter(
            (m: MessageWithMeta) =>
              !(m.role === 'assistant' && !m.content.trim() && m.status !== 'complete')
          );
          setMessages(loadedMessages);
          onConversationLoaded?.(id, data.activeRun);
        } else {
          setError('Could not load historical conversation.');
        }
      } catch (err) {
        console.error('Failed to load conversation details:', err);
        setError('Network error loading conversation.');
      }
    },
    [onConversationLoaded]
  );

  // Start new chat
  const handleNewChat = useCallback(() => {
    try {
      localStorage.removeItem('sift_active_conversation_id');
    } catch {}
    setActiveConversationId(null);
    setMessages([]);
    setError(null);
  }, []);

  // Delete conversation
  const handleDeleteConversation = useCallback(
    async (id: string, onBeforeDelete?: (id: string) => void) => {
      try {
        onBeforeDelete?.(id);
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

  // Restore previous active conversation on mount
  useEffect(() => {
    const savedId = localStorage.getItem('sift_active_conversation_id');
    if (savedId && !activeConversationId) {
      loadConversation(savedId);
    }
  }, [loadConversation, activeConversationId]);

  return {
    conversations,
    setConversations,
    activeConversationId,
    setActiveConversationId,
    messages,
    setMessages,
    error,
    setError,
    fetchConversations,
    loadConversation,
    handleNewChat,
    handleDeleteConversation,
  };
}
