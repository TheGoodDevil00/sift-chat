import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreparedAgentMessages } from '@/lib/agent/input-builder';

const { streamMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
}));

vi.mock('@/lib/agent/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent/providers')>();
  return {
    ...actual,
    createProviderAdapter: () => ({ stream: streamMock }),
  };
});

import { runAgent } from '@/lib/agent/run';

function prepared(requiresSearch: boolean): PreparedAgentMessages {
  return {
    systemPromptAdditions: '',
    inputItems: [{ role: 'user', content: 'What is the current price?' }],
    requiresSearch,
  };
}

function textOnlyAdapter(text: string) {
  return async function* () {
    yield { type: 'delta' as const, text };
    yield { type: 'done' as const, finishReason: 'stop' };
  };
}

describe('Mandatory web search enforcement', () => {
  beforeEach(() => {
    streamMock.mockReset();
  });

  it('does not return a model-memory answer when search is required', async () => {
    streamMock.mockImplementation(textOnlyAdapter('The price is $20.'));

    let streamed = '';
    const result = await runAgent(
      prepared(true),
      'assistant-1',
      { onDelta: (text) => (streamed += text) },
      undefined,
      { provider: 'openai', model: 'gpt-test', apiKey: 'client-key' }
    );

    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.normalized?.finishReason).toBe('search_not_completed');
    expect(result.normalized?.text).toContain('could not complete a live web verification');
    expect(streamed).not.toContain('The price is $20.');
    expect(result.normalized?.citations).toEqual([]);
  });

  it('allows a direct answer when search is not required', async () => {
    streamMock.mockImplementation(textOnlyAdapter('A primary key uniquely identifies a row.'));

    const result = await runAgent(
      prepared(false),
      'assistant-2',
      undefined,
      undefined,
      { provider: 'openai', model: 'gpt-test', apiKey: 'client-key' }
    );

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(result.normalized?.text).toBe('A primary key uniquely identifies a row.');
  });
});
