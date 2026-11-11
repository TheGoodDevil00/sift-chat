import { CohereClientV2 } from 'cohere-ai';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderStreamEvent,
  ToolDefinition,
} from './adapter';

export class CohereAdapter implements ProviderAdapter {
  private client: CohereClientV2;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new CohereClientV2({ token: apiKey });
    this.model = model;
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ToolDefinition[] | null,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const formattedMessages: any[] = messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          content: m.content,
          toolCallId: m.tool_call_id,
        };
      }
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content || '',
          toolCalls: m.tool_calls?.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        };
      }
      return {
        role: m.role,
        content: m.content,
      };
    });

    const cohereTools = tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const stream = await this.client.chatStream({
      model: this.model,
      messages: formattedMessages,
      tools: cohereTools,
    });

    const toolCalls: any[] = [];

    for await (const chunk of stream) {
      if (signal?.aborted) throw new Error('AbortError');

      if ((chunk as any).type === 'content-delta') {
        const text = (chunk as any).delta?.message?.content?.text || '';
        if (text) yield { type: 'delta', text };
      } else if ((chunk as any).type === 'tool-call-delta') {
        // Collect tool calls
        const delta = (chunk as any).delta?.message?.tool_calls;
        if (delta) {
          toolCalls.push(delta);
        }
      } else if ((chunk as any).type === 'tool-call-start') {
        const tc = (chunk as any).delta?.message?.tool_calls;
        if (tc) {
          toolCalls.push(tc);
        }
      } else if ((chunk as any).type === 'message-end') {
        const message = (chunk as any).delta?.message;
        if (message?.tool_calls) {
          for (const tc of message.tool_calls) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id || `call_${Date.now()}`,
                name: tc.function?.name || 'web_search',
                arguments: tc.function?.arguments || '{}',
              },
            };
          }
        }
        yield {
          type: 'done',
          finishReason: (chunk as any).delta?.finish_reason || 'completed',
        };
      }
    }
  }
}
