import { Anthropic } from '@anthropic-ai/sdk';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderStreamEvent,
  ToolDefinition,
  ToolCallRecord,
} from './adapter';

export class AnthropicAdapter implements ProviderAdapter {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({
      apiKey,
      timeout: 60000,
    });
    this.model = model;
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ToolDefinition[] | null,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    // 1. Separate system message
    const systemMessages = messages.filter((m) => m.role === 'system');
    const systemPrompt = systemMessages.map((m) => m.content).join('\n\n');

    // 2. Convert conversation messages to Anthropic format
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    const anthropicMessages: Anthropic.MessageParam[] = [];

    for (const m of nonSystemMessages) {
      if (m.role === 'assistant') {
        const contentBlocks: any[] = [];
        if (m.content) {
          contentBlocks.push({ type: 'text', text: m.content });
        }
        if (m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(tc.arguments || '{}');
            } catch {}
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: parsedArgs,
            });
          }
        }
        anthropicMessages.push({
          role: 'assistant',
          content: contentBlocks.length === 1 && contentBlocks[0].type === 'text'
            ? contentBlocks[0].text
            : contentBlocks,
        });
      } else if (m.role === 'tool') {
        const toolResultBlock = {
          type: 'tool_result' as const,
          tool_use_id: m.tool_call_id || 'call_default',
          content: m.content,
        };

        // If the last message is already a user message, append to its content array
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as any[]).push(toolResultBlock);
        } else {
          anthropicMessages.push({
            role: 'user',
            content: [toolResultBlock],
          });
        }
      } else {
        // user role
        anthropicMessages.push({
          role: 'user',
          content: m.content,
        });
      }
    }

    // 3. Format tools
    const anthropicTools: Anthropic.Tool[] | undefined = tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: (t.parameters as any)?.properties || {},
        required: (t.parameters as any)?.required || [],
      },
    }));

    // 4. Stream response using messages.stream()
    const stream = this.client.messages.stream(
      {
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt || undefined,
        messages: anthropicMessages,
        tools: anthropicTools,
      },
      { signal }
    );

    const activeToolCalls: Record<number, { id: string; name: string; partialJson: string }> = {};
    let currentBlockIndex = 0;
    let finishReason = 'completed';

    for await (const event of stream) {
      if (signal?.aborted) throw new Error('AbortError');

      if (event.type === 'content_block_start') {
        currentBlockIndex = event.index;
        if (event.content_block.type === 'tool_use') {
          activeToolCalls[currentBlockIndex] = {
            id: event.content_block.id,
            name: event.content_block.name,
            partialJson: '',
          };
        }
      } else if (event.type === 'content_block_delta') {
        const delta: any = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'delta', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          if (activeToolCalls[event.index]) {
            activeToolCalls[event.index].partialJson += delta.partial_json;
          }
        } else if (delta.type === 'thinking_delta') {
          yield { type: 'thinking', text: delta.thinking || '' };
        }
      } else if (event.type === 'message_delta') {
        if (event.delta.stop_reason) {
          finishReason = event.delta.stop_reason;
        }
      }
    }

    // Flush any completed tool calls
    for (const tc of Object.values(activeToolCalls)) {
      if (tc.name) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: tc.id,
            name: tc.name,
            arguments: tc.partialJson || '{}',
          },
        };
      }
    }

    yield {
      type: 'done',
      finishReason,
    };
  }
}
