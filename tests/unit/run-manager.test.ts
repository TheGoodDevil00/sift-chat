import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runManager } from '@/lib/agent/run-manager';
import type { PreparedAgentMessages } from '@/lib/agent/input-builder';

// Mock runAgent so we control execution timing and events
vi.mock('@/lib/agent/run', () => ({
  runAgent: vi.fn(async (prepared, assistantMessageId, callbacks, signal) => {
    callbacks?.onStatus?.('searching_web');
    callbacks?.onDelta?.('First search result. ');
    callbacks?.onDelta?.('Second finding.');
    return {
      success: true,
      normalized: {
        text: 'First search result. Second finding.',
        citations: [],
        sources: [],
      },
    };
  }),
}));

vi.mock('@/lib/db/repositories/messages', () => ({
  insertMessage: vi.fn(),
  updateMessage: vi.fn(),
  insertCitations: vi.fn(() => []),
  insertSources: vi.fn(() => []),
}));

vi.mock('@/lib/db/repositories/conversations', () => ({
  touchConversation: vi.fn(),
}));

describe('RunManager', () => {
  const dummyPrepared: PreparedAgentMessages = {
    systemPromptAdditions: '',
    inputItems: [{ role: 'user', content: 'hello' }],
  };

  it('starts a run, broadcasts deltas, and reaches completed status', async () => {
    const events: any[] = [];
    const convId = 'conv-test-1';

    let run: any;
    const runPromise = new Promise<void>((resolve) => {
      run = runManager.startRun({
        conversationId: convId,
        userMessageId: 'user-msg-1',
        assistantMessageId: 'asst-msg-1',
        preparedInput: dummyPrepared,
        timezone: 'UTC',
        initialSubscriber: (ev) => {
          events.push(ev);
          if (ev.type === 'complete') resolve();
        },
      });
    });

    await runPromise;

    expect(run.status).toBe('completed');
    expect(run.accumulatedText).toBe('First search result. Second finding.');
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('tracks multiple concurrent runs across different conversations', async () => {
    const run1 = runManager.startRun({
      conversationId: 'conv-a',
      userMessageId: 'user-a',
      assistantMessageId: 'asst-a',
      preparedInput: dummyPrepared,
      timezone: 'UTC',
    });

    const run2 = runManager.startRun({
      conversationId: 'conv-b',
      userMessageId: 'user-b',
      assistantMessageId: 'asst-b',
      preparedInput: dummyPrepared,
      timezone: 'UTC',
    });

    expect(runManager.getRun('conv-a')).toBeDefined();
    expect(runManager.getRun('conv-b')).toBeDefined();
    expect(runManager.getRun('conv-a')?.runId).not.toBe(runManager.getRun('conv-b')?.runId);
  });

  it('cancels an active run upon request', async () => {
    const convId = 'conv-cancel-test';
    const run = runManager.startRun({
      conversationId: convId,
      userMessageId: 'user-c',
      assistantMessageId: 'asst-c',
      preparedInput: dummyPrepared,
      timezone: 'UTC',
    });

    const cancelled = runManager.cancelRun(convId);
    expect(cancelled).toBe(true);
    expect(run.status).toBe('aborted');
  });
});
