import { describe, it, expect } from 'vitest';
import { listProviderModels } from '@/lib/agent/providers/list-models';
import { runAgent } from '@/lib/agent/run';
import { buildAgentInput } from '@/lib/agent/input-builder';
import { randomUUID } from 'crypto';

describe.skipIf(process.env.OLLAMA_LIVE !== '1')('Live Ollama Integration', () => {
  it('discovers live models from local Ollama instance including custom model', async () => {
    const result = await listProviderModels('ollama', 'ollama', 'http://localhost:11434/v1');
    expect(result.provider).toBe('ollama');
    expect(result.live).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('runs an agent turn with an installed Ollama model', async () => {
    const discovery = await listProviderModels('ollama', 'ollama', 'http://localhost:11434/v1');
    const model =
      discovery.models.find((m) => m.id === 'my-custom-model:latest')?.id ||
      discovery.models[0]?.id;
    expect(model).toBeDefined();

    const userMessage = 'Calculate 42 * 2 and return the number.';
    const preparedInput = buildAgentInput({
      userMessage,
      userTimezone: 'UTC',
      referenceDate: new Date(),
      recentMessages: [],
      historicalExcerpts: [],
      temporal: {
        hasDate: false,
        startDate: null,
        endDate: null,
        rawExpression: null,
        resolvedDisplay: null,
        confidence: 'none',
        timezone: 'UTC',
      },
      requiresSearch: false,
    });

    const assistantMessageId = randomUUID();
    let receivedDelta = '';
    let receivedThinking = '';

    const result = await runAgent(
      preparedInput,
      assistantMessageId,
      {
        onDelta: (text) => {
          receivedDelta += text;
        },
        onThinking: (text) => {
          receivedThinking += text;
        },
      },
      undefined,
      {
        provider: 'ollama',
        model: model!,
        apiKey: 'ollama',
        customBaseUrl: 'http://localhost:11434/v1',
      }
    );

    expect(result.success).toBe(true);
    expect(result.normalized).toBeDefined();
    expect(result.normalized?.text).toContain('84');
    // Hidden reasoning must not leak into the product surface.
    expect(receivedThinking).toBe('');
    expect(result.normalized?.thinking).toBeUndefined();
    expect(receivedDelta).toContain('84');
  }, 30000); // 30s timeout for local model inference
});
