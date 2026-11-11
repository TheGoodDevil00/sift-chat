import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/migrations';
import { setDbForTesting } from '@/lib/db/client';
import { getRecentMessages } from '@/lib/db/repositories/messages';
import { runAgent } from '@/lib/agent/run';
import { POST as chatHandler } from '@/app/api/chat/route';

vi.mock('@/lib/agent/run', () => ({
  runAgent: vi.fn(async (_prepared: any, _id: string, callbacks: any) => {
    callbacks?.onStatus?.('writing');
    callbacks?.onDelta?.('Verified answer with [source](https://example.com/pricing).');
    return {
      success: true,
      normalized: {
        text: 'Verified answer with [source](https://example.com/pricing).',
        citations: [],
        sources: [],
        model: 'test-model',
        responseId: 'resp-test',
        finishReason: 'completed',
      },
    };
  }),
}));

function chatRequest(clientRequestId: string, message: string, conversationId?: string) {
  return new NextRequest('http://localhost:3000/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: conversationId || null,
      message,
      timezone: 'UTC',
      clientRequestId,
    }),
  });
}

function parseSse(text: string): any[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

describe('Idempotent chat requests', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    setDbForTesting(db);
    vi.mocked(runAgent).mockClear();
  });

  afterEach(() => {
    setDbForTesting(null);
    db.close();
  });

  it('replays the saved reply for a repeated clientRequestId without a second model call', async () => {
    const message = 'What is the current price?';
    const clientRequestId = 'idem-request-1';

    const first = await chatHandler(chatRequest(clientRequestId, message));
    expect(first.status).toBe(200);
    const firstEvents = parseSse(await first.text());

    const start = firstEvents.find((e) => e.type === 'start');
    const firstComplete = firstEvents.find((e) => e.type === 'complete');
    expect(start).toBeDefined();
    expect(firstComplete?.text).toContain('Verified answer');

    const conversationId = start.conversationId;
    expect(runAgent).toHaveBeenCalledTimes(1);

    const second = await chatHandler(chatRequest(clientRequestId, message, conversationId));
    expect(second.status).toBe(200);
    const secondEvents = parseSse(await second.text());

    const secondComplete = secondEvents.find((e) => e.type === 'complete');
    expect(secondComplete?.text).toContain('Verified answer');
    expect(secondComplete?.assistantMessageId).toBe(firstComplete.assistantMessageId);
    expect(runAgent).toHaveBeenCalledTimes(1);

    const messages = getRecentMessages(conversationId, 10, db);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('retries a failed request by reusing its assistant row, not duplicating the turn', async () => {
    vi.mocked(runAgent).mockImplementationOnce(async () => ({
      success: false,
      errorCode: 'MODEL_REQUEST_FAILED',
      errorMessage: 'temporary provider failure',
      retryable: true,
    }));

    const message = 'Retryable pricing question';
    const clientRequestId = 'idem-request-retry';

    const first = await chatHandler(chatRequest(clientRequestId, message));
    const firstEvents = parseSse(await first.text());
    const conversationId = firstEvents.find((e) => e.type === 'start').conversationId;
    expect(firstEvents.some((e) => e.type === 'error')).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(1);

    const retry = await chatHandler(chatRequest(clientRequestId, message, conversationId));
    const retryEvents = parseSse(await retry.text());
    expect(retryEvents.some((e) => e.type === 'complete')).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(2);

    const messages = getRecentMessages(conversationId, 10, db);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(messages.find((m) => m.role === 'assistant')?.status).toBe('complete');
  });

  it('rejects reuse of a clientRequestId with different message text', async () => {
    const first = await chatHandler(chatRequest('idem-request-2', 'First message'));
    const events = parseSse(await first.text());
    const conversationId = events.find((e) => e.type === 'start').conversationId;

    const conflict = await chatHandler(
      chatRequest('idem-request-2', 'Different message', conversationId)
    );
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.code).toBe('REQUEST_ID_CONFLICT');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
