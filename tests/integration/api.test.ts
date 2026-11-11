import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import { setDbForTesting } from '@/lib/db/client';
import { createConversation, getConversation } from '@/lib/db/repositories/conversations';
import { insertMessage } from '@/lib/db/repositories/messages';
import { POST as chatHandler } from '@/app/api/chat/route';
import { GET as getConversationsHandler } from '@/app/api/conversations/route';
import {
  GET as getConversationDetailHandler,
  DELETE as deleteConversationHandler,
} from '@/app/api/conversations/[id]/route';
import { POST as modelsHandler } from '@/app/api/models/route';
import { GET as getRunsHandler } from '@/app/api/runs/route';
import { GET as getStreamHandler } from '@/app/api/chat/stream/route';
import { POST as cancelChatHandler } from '@/app/api/chat/cancel/route';
import { runManager } from '@/lib/agent/run-manager';
import { NextRequest } from 'next/server';

describe('API Routes Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    setDbForTesting(db);
  });

  afterEach(() => {
    setDbForTesting(null);
    db.close();
  });

  it('rejects invalid chat requests with 400 INVALID_REQUEST', async () => {
    const req = new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        message: '   ', // empty after trim
        clientRequestId: 'req-1',
      }),
    });

    const res = await chatHandler(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('INVALID_REQUEST');
  });

  it('rejects unknown conversationId with 404 CONVERSATION_NOT_FOUND', async () => {
    const req = new NextRequest('http://localhost:3000/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        conversationId: '00000000-0000-0000-0000-000000000000',
        message: 'Hello Sift',
        clientRequestId: 'req-2',
      }),
    });

    const res = await chatHandler(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('lists conversations via GET /api/conversations', async () => {
    const req = new NextRequest('http://localhost:3000/api/conversations');
    const res = await getConversationsHandler(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.conversations)).toBe(true);
  });

  it('rejects POST /api/models when no key is provided and none in env', async () => {
    const req = new NextRequest('http://localhost:3000/api/models', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'groq',
        apiKey: '',
      }),
    });
    const res = await modelsHandler(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('No API key found for groq');
  });

  it('fetches models via POST /api/models with valid payload', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'llama-3.1-70b-versatile', active: true },
            { id: 'llama-3.3-70b-specdec', active: true },
          ],
        }),
      } as any);

    try {
      const req = new NextRequest('http://localhost:3000/api/models', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'groq',
          apiKey: 'gsk_test123',
        }),
      });
      const res = await modelsHandler(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.provider).toBe('groq');
      expect(data.models.length).toBe(2);
      expect(data.models[0].id).toBe('llama-3.1-70b-versatile');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects custom base URLs that target private or metadata addresses', async () => {
    const req = new NextRequest('http://localhost:3000/api/models', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'groq',
        apiKey: 'gsk_test123',
        customBaseUrl: 'http://169.254.169.254/latest/meta-data',
      }),
    });
    const res = await modelsHandler(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('private, link-local, or metadata');
  });

  it('requires a client-supplied key for a custom remote endpoint', async () => {
    const req = new NextRequest('http://localhost:3000/api/models', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'groq',
        customBaseUrl: 'https://example.com/v1',
      }),
    });
    const res = await modelsHandler(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('requires your own API key');
  });

  it('lists active runs via GET /api/runs', async () => {
    const res = await getRunsHandler();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.activeRuns).toBeDefined();
  });

  it('handles stream reconnection via GET /api/chat/stream for inactive run', async () => {
    const req = new NextRequest('http://localhost:3000/api/chat/stream?conversationId=non-existent');
    const res = await getStreamHandler(req);
    expect(res.status).toBe(404);
  });

  it('cancels active chat task via POST /api/chat/cancel and returns 404 for inactive run', async () => {
    // 1. Register an active running task
    const abortController = new AbortController();
    runManager.registerActiveRunForTesting({
      runId: 'test-run-1',
      conversationId: 'test-cancel-id',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      status: 'running',
      phase: 'searching_web',
      timezone: 'UTC',
      accumulatedText: 'partial',
      accumulatedThinking: '',
      startedAt: new Date().toISOString(),
      abortController,
      listeners: new Set(),
    });

    const cancelReq = new NextRequest('http://localhost:3000/api/chat/cancel', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'test-cancel-id' }),
    });
    const cancelRes = await cancelChatHandler(cancelReq);
    expect(cancelRes.status).toBe(200);
    const cancelData = await cancelRes.json();
    expect(cancelData.success).toBe(true);
    expect(cancelData.cancelled).toBe(true);

    // 2. When run no longer exists or conversation is inactive
    const missingReq = new NextRequest('http://localhost:3000/api/chat/cancel', {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'test-cancel-id' }),
    });
    const missingRes = await cancelChatHandler(missingReq);
    expect(missingRes.status).toBe(404);
    const missingData = await missingRes.json();
    expect(missingData.cancelled).toBe(false);
  });
});
