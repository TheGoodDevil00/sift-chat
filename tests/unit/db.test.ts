import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import {
  createConversation,
  getConversation,
  listConversations,
  touchConversation,
  deleteConversation,
} from '@/lib/db/repositories/conversations';
import {
  insertMessage,
  getMessage,
  getRecentMessages,
  insertCitations,
  insertSources,
  getConversationMessagesWithMeta,
} from '@/lib/db/repositories/messages';

describe('Database layer & migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves a conversation', () => {
    const conv = createConversation(
      { title: 'CRM Shortlist Discussion', timezone: 'America/New_York' },
      db
    );
    expect(conv.id).toBeDefined();
    expect(conv.title).toBe('CRM Shortlist Discussion');

    const fetched = getConversation(conv.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('CRM Shortlist Discussion');
    expect(fetched?.timezone).toBe('America/New_York');
  });

  it('lists conversations newest updated first', () => {
    const c1 = createConversation({ title: 'First' }, db);
    const c2 = createConversation({ title: 'Second' }, db);

    touchConversation(c1.id, undefined, db);

    const list = listConversations(10, 0, db);
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(c1.id);
  });

  it('handles soft deletion of conversations', () => {
    const conv = createConversation({ title: 'To Delete' }, db);
    const deleted = deleteConversation(conv.id, false, db);
    expect(deleted).toBe(true);

    const fetched = getConversation(conv.id, db);
    expect(fetched).toBeNull();
  });

  it('inserts and retrieves messages, enforcing idempotency on client_request_id', () => {
    const conv = createConversation({ title: 'Chat' }, db);

    const res1 = insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'Tell me about Postgres hosting',
        client_request_id: 'req-1234',
      },
      db
    );
    expect(res1.isExisting).toBe(false);

    // Second call with same client_request_id should return existing message
    const res2 = insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'Tell me about Postgres hosting (retry)',
        client_request_id: 'req-1234',
      },
      db
    );
    expect(res2.isExisting).toBe(true);
    expect(res2.message.id).toBe(res1.message.id);
    expect(res2.message.content).toBe('Tell me about Postgres hosting');
  });

  it('indexes messages automatically into FTS5 via triggers', () => {
    const conv = createConversation({ title: 'FTS Test' }, db);
    const userMsg = insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'We shortlisted HubSpot, Salesforce, Pipedrive, Zoho, and Close CRM.',
      },
      db
    );

    const rows = db
      .prepare('SELECT message_id, content FROM messages_fts WHERE messages_fts MATCH ?')
      .all('HubSpot') as any[];

    expect(rows.length).toBe(1);
    expect(rows[0].message_id).toBe(userMsg.message.id);
  });

  it('stores and retrieves citations and sources with messages', () => {
    const conv = createConversation({ title: 'Sources Test' }, db);
    const assistantMsg = insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'Supabase changed pricing according to their pricing page [1].',
      },
      db
    );

    insertCitations(
      [
        {
          message_id: assistantMsg.message.id,
          url: 'https://supabase.com/pricing',
          canonical_url: 'https://supabase.com/pricing',
          title: 'Supabase Pricing',
          start_index: 45,
          end_index: 48,
        },
      ],
      db
    );

    insertSources(
      [
        {
          message_id: assistantMsg.message.id,
          url: 'https://supabase.com/pricing',
          canonical_url: 'https://supabase.com/pricing',
          title: 'Supabase Pricing',
        },
        {
          message_id: assistantMsg.message.id,
          url: 'https://supabase.com/blog',
          canonical_url: 'https://supabase.com/blog',
          title: 'Supabase Blog',
        },
      ],
      db
    );

    const msgs = getConversationMessagesWithMeta(conv.id, db);
    expect(msgs.length).toBe(1);
    expect(msgs[0].citations.length).toBe(1);
    expect(msgs[0].citations[0].url).toBe('https://supabase.com/pricing');
    expect(msgs[0].sources.length).toBe(2);
  });
});
