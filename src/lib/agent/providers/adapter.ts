export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
}

export interface ProviderStreamEvent {
  type: 'delta' | 'thinking' | 'tool_call' | 'done';
  text?: string;
  toolCall?: ToolCallRecord;
  finishReason?: string;
  responseId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderAdapter {
  /**
   * Stream a completion with optional tool definitions.
   * Yields events as they arrive: delta, thinking, tool_call, done.
   */
  stream(
    messages: ProviderMessage[],
    tools: ToolDefinition[] | null,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;
}
