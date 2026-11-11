import { OpenAI } from 'openai';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderStreamEvent,
  ToolDefinition,
  ToolCallRecord,
} from './adapter';

export class OpenAIAdapter implements ProviderAdapter {
  private client: OpenAI;
  private model: string;
  private isOllama: boolean;
  private reasoningEffort?: 'low' | 'medium' | 'high';

  constructor(
    apiKey: string,
    model: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
    reasoningEffort?: 'low' | 'medium' | 'high'
  ) {
    this.isOllama = Boolean(
      baseURL?.includes('11434') || model.toLowerCase().includes('ollama')
    );
    this.client = new OpenAI({
      apiKey: apiKey || 'dummy-key',
      baseURL,
      timeout: 60000,
      defaultHeaders: defaultHeaders && Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });
    this.model = model;
    this.reasoningEffort = reasoningEffort || (process.env.OPENAI_REASONING_EFFORT as any) || 'medium';
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ToolDefinition[] | null,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const formattedMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id || 'call_default',
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls?.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user',
        content: m.content,
      };
    });

    const requestPayload: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: formattedMessages as any,
      tools: tools?.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      stream: true,
    };

    if (tools && tools.length > 0 && !this.isOllama) {
      requestPayload.tool_choice = 'auto';
    }

    // Pass reasoning_effort for reasoning models (e.g. o1, o3, o4)
    if (/^(o1|o3|o4)/i.test(this.model) && this.reasoningEffort) {
      (requestPayload as any).reasoning_effort = this.reasoningEffort;
    }

    const stream = await this.client.chat.completions.create(requestPayload, { signal });
    const toolCallsAcc: Record<number, ToolCallRecord> = {};
    let inThinkTag = false;
    let finishReasonEmitted = false;

    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('AbortError');
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      // 1. Tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsAcc[idx]) {
            toolCallsAcc[idx] = { id: '', name: '', arguments: '' };
          }
          if (tc.id) toolCallsAcc[idx].id = tc.id;
          if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCallsAcc[idx].arguments += tc.function.arguments;
        }
      }

      // 2. Dedicated reasoning tokens (DeepSeek, Groq, Ollama)
      const reasoningChunk =
        (choice.delta as any)?.reasoning || (choice.delta as any)?.reasoning_content || '';
      if (reasoningChunk) {
        yield { type: 'thinking', text: reasoningChunk };
      }

      // 3. Text content deltas (with <think>...</think> tag handling for models that stream reasoning in content)
      if (choice.delta?.content) {
        let contentChunk = choice.delta.content;

        if (contentChunk.includes('<think>')) {
          inThinkTag = true;
          const [before, after] = contentChunk.split('<think>');
          if (before) yield { type: 'delta', text: before };
          if (after && !after.includes('</think>')) {
            yield { type: 'thinking', text: after };
            continue;
          } else if (after && after.includes('</think>')) {
            const [inside, rest] = after.split('</think>');
            yield { type: 'thinking', text: inside };
            if (rest) yield { type: 'delta', text: rest };
            inThinkTag = false;
            continue;
          }
          continue;
        }

        if (inThinkTag) {
          if (contentChunk.includes('</think>')) {
            const [inside, after] = contentChunk.split('</think>');
            if (inside) yield { type: 'thinking', text: inside };
            inThinkTag = false;
            if (after) yield { type: 'delta', text: after };
          } else {
            yield { type: 'thinking', text: contentChunk };
          }
          continue;
        }

        yield { type: 'delta', text: contentChunk };
      }

      // 4. Finish reason
      if (choice.finish_reason) {
        for (const tc of Object.values(toolCallsAcc)) {
          if (tc.name) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: tc.name,
                arguments: tc.arguments,
              },
            };
          }
        }
        finishReasonEmitted = true;
        yield {
          type: 'done',
          finishReason: choice.finish_reason,
          responseId: chunk.id,
        };
      }
    }

    if (!finishReasonEmitted) {
      for (const tc of Object.values(toolCallsAcc)) {
        if (tc.name) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              name: tc.name,
              arguments: tc.arguments,
            },
          };
        }
      }
      yield { type: 'done', finishReason: 'completed' };
    }
  }
}
