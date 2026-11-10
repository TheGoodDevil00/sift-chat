import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import { createConversation, getConversation } from '@/lib/db/repositories/conversations';
import { insertMessage } from '@/lib/db/repositories/messages';
import { POST as chatHandler } from '@/app/api/chat/route';
import { GET as getConversationsHandler } from '@/app/api/conversations/route';
import {
  GET as getConversationDetailHandler,
  DELETE as deleteConversationHandler,
} from '@/app/api/conversations/[id]/route';
import { NextRequest } from 'next/server';

describe('API Routes Integration', () => {
  beforeEach(() => {
    // In-memory or temporary db setup
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
});
