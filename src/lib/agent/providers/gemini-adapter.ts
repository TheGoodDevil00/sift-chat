import { GoogleGenAI } from '@google/genai';
import type {
  ProviderAdapter,
  ProviderMessage,
  ProviderStreamEvent,
  ToolDefinition,
} from './adapter';

export class GeminiAdapter implements ProviderAdapter {
  private ai: GoogleGenAI;
  private model: string;
  private chat: any = null;

  constructor(apiKey: string, model: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async *stream(
    messages: ProviderMessage[],
    tools: ToolDefinition[] | null,
    signal?: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    if (signal?.aborted) throw new Error('AbortError');

    // Format tool declarations
    const geminiTools =
      tools && tools.length > 0
        ? [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters as any,
              })),
            },
          ]
        : undefined;

    let messageToSend: any;

    if (!this.chat) {
      // 1. Initial turn: create persistent Chat session preserving all context and system instruction
      const systemMessages = messages.filter((m) => m.role === 'system');
      const systemInstruction = systemMessages.map((m) => m.content).join('\n\n');

      const nonSystem = messages.filter((m) => m.role !== 'system');
      const priorMessages = nonSystem.slice(0, -1);
      const activePromptMessage = nonSystem[nonSystem.length - 1];

      // Convert prior conversation history
      const history = priorMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

      this.chat = this.ai.chats.create({
        model: this.model,
        history: history.length > 0 ? history : undefined,
        config: {
          systemInstruction: systemInstruction || undefined,
          tools: geminiTools,
        },
      });

      messageToSend = activePromptMessage?.content || 'Hello';
    } else {
      // 2. Subsequent turns: tool results or synthesis turn
      const lastMsg = messages[messages.length - 1];

      if (lastMsg?.role === 'tool') {
        // Collect all trailing tool messages to pass back to model
        const toolMessages: ProviderMessage[] = [];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'tool') {
            toolMessages.unshift(messages[i]);
          } else {
            break;
          }
        }

        messageToSend = toolMessages.map((tm) => {
          let parsed: any = tm.content;
          try {
            parsed = JSON.parse(tm.content);
          } catch {}

          return {
            functionResponse: {
              name: 'web_search',
              response: { output: parsed },
            },
          };
        });
      } else {
        messageToSend = lastMsg?.content || 'Please continue.';
      }
    }

    // Call chat.sendMessage
    // Using chat.sendMessage preserves the model's exact candidate output in this.history,
    // including the cryptographic thought_signature required for function calling validation.
    const response = await this.chat.sendMessage({
      message: messageToSend,
    });

    if (signal?.aborted) throw new Error('AbortError');

    // 1. Extract thinking tokens
    const candidate = (response as any).candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (part.thought && part.text) {
          yield { type: 'thinking', text: part.text };
        }
      }
    }

    // 2. Check for function calls
    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      for (const fc of functionCalls) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: fc.name,
            arguments: JSON.stringify(fc.args || {}),
          },
        };
      }
      yield { type: 'done', finishReason: 'tool_use' };
      return;
    }

    // 3. Final text output
    // Read parts directly to avoid the SDK warning about accessing .text on responses with non-text parts
    let finalText = '';
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        if (!part.thought && part.text) {
          finalText += part.text;
        }
      }
    }

    if (!finalText && response.text) {
      finalText = response.text;
    }

    // Stream text in small chunks for smooth UI streaming
    if (finalText) {
      const chunkSize = 24;
      for (let i = 0; i < finalText.length; i += chunkSize) {
        yield { type: 'delta', text: finalText.slice(i, i + chunkSize) };
      }
    }

    yield {
      type: 'done',
      finishReason: 'completed',
    };
  }
}
