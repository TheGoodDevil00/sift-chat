export type MessageRole = 'user' | 'assistant';

export type MessageStatus = 'complete' | 'interrupted' | 'failed';

export interface Conversation {
  id: string;
  title: string;
  timezone: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  status: MessageStatus;
  client_request_id?: string | null;
  model?: string | null;
  provider_response_id?: string | null;
  usage_json?: string | null;
}

export interface Citation {
  id: string;
  message_id: string;
  url: string;
  canonical_url: string;
  title?: string | null;
  start_index?: number | null;
  end_index?: number | null;
  retrieved_at: string;
  source_metadata_json?: string | null;
}

export interface Source {
  id: string;
  message_id: string;
  url: string;
  canonical_url: string;
  title?: string | null;
  retrieved_at: string;
  source_metadata_json?: string | null;
}

export interface MessageWithMeta extends Message {
  citations: Citation[];
  sources: Source[];
}

export interface ConversationDetail extends Conversation {
  messages: MessageWithMeta[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type SupportedProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'xai'
  | 'cohere'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'local';

export interface ClientProviderConfig {
  provider: SupportedProvider;
  model: string;
  apiKey?: string;
  customBaseUrl?: string;
}

export interface ChatRequest {
  conversationId: string | null;
  message: string;
  timezone: string;
  clientRequestId: string;
  providerConfig?: ClientProviderConfig;
}

export type ChatPhase = 'retrieving_history' | 'searching_web' | 'writing';

export type ChatEvent =
  | { type: 'start'; conversationId: string; userMessageId: string }
  | { type: 'status'; phase: ChatPhase }
  | { type: 'delta'; text: string }
  | {
      type: 'complete';
      assistantMessageId: string;
      citations: Citation[];
      sources: Source[];
      createdAt: string;
      timezoneUsed: string;
    }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export type UserIntent =
  | 'conversation_recall'
  | 'freshness_check'
  | 'change_monitoring'
  | 'current_research'
  | 'general_chat'
  | 'follow_up';

export interface TemporalResolution {
  hasDate: boolean;
  startDate: Date | null;
  endDate: Date | null;
  rawExpression: string | null;
  resolvedDisplay: string | null;
  confidence: 'exact' | 'approximate' | 'none';
  timezone: string;
}

export interface HistoryExcerpt {
  messageId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  matchReason: 'date' | 'entity' | 'fts' | 'recent';
}
