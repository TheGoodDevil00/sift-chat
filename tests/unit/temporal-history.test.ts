import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import { createConversation } from '@/lib/db/repositories/conversations';
import { insertMessage } from '@/lib/db/repositories/messages';
import { resolveTemporalReference, getUtcDateFromZoned } from '@/lib/history/temporal';
import { retrieveRelevantHistory } from '@/lib/history/retrieve';

describe('Temporal Resolution and History Retrieval', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('correctly resolves 3 November relative to reference date in user timezone', () => {
    // Reference date: Tuesday, 10 November 2026 12:00 UTC
    const refDate = new Date('2026-11-10T12:00:00Z');
    const result = resolveTemporalReference('What did I ask you on 3 November?', 'Asia/Kolkata', refDate);

    expect(result.hasDate).toBe(true);
    expect(result.startDate).not.toBeNull();
    expect(result.endDate).not.toBeNull();
    // 3 Nov 2026 in Asia/Kolkata start is 2026-11-02T18:30:00.000Z
    expect(result.startDate?.toISOString()).toBe('2026-11-02T18:30:00.000Z');
    expect(result.resolvedDisplay).toContain('3 November 2026');
  });

  it('correctly resolves "last Tuesday" relative to a Tuesday reference date', () => {
    // Reference date: Tuesday, 10 November 2026
    const refDate = new Date('2026-11-10T12:00:00Z');
    const result = resolveTemporalReference(
      'Last Tuesday I asked about Postgres hosting. Has any pricing changed?',
      'UTC',
      refDate
    );

    expect(result.hasDate).toBe(true);
    // Last Tuesday from Nov 10 is Nov 3
    expect(result.startDate?.toISOString().startsWith('2026-11-03')).toBe(true);
  });

  it('correctly retrieves historical messages for a specific date', () => {
    const conv = createConversation({ title: 'Nov 3 chat' }, db);
    // Insert message on 3 Nov 2026 10:00 UTC
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'Which vector database is best for Node.js?',
        created_at: '2026-11-03T10:00:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'Pinecone, Qdrant, and pgvector are top options.',
        created_at: '2026-11-03T10:01:00.000Z',
      },
      db
    );

    // Another message on Nov 5 (should not match Nov 3)
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'Tell me a joke.',
        created_at: '2026-11-05T10:00:00.000Z',
      },
      db
    );

    const refDate = new Date('2026-11-10T12:00:00Z');
    const history = retrieveRelevantHistory(
      'What did I ask you on 3 November?',
      'UTC',
      null,
      null,
      refDate,
      db
    );

    expect(history.hasMatch).toBe(true);
    expect(history.excerpts.length).toBe(2);
    expect(history.excerpts[0].content).toContain('Which vector database is best');
    expect(history.excerpts[1].content).toContain('Pinecone, Qdrant, and pgvector');
  });

  it('retrieves topic matches across conversations via FTS when date is not specified', () => {
    const conv1 = createConversation({ title: 'Old CRM' }, db);
    insertMessage(
      {
        conversation_id: conv1.id,
        role: 'user',
        content: 'We shortlisted five CRM tools for a 20-person sales team: HubSpot, Salesforce, Pipedrive, Close, and Zoho.',
        created_at: '2026-11-02T10:00:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv1.id,
        role: 'assistant',
        content: 'Here is the comparison of HubSpot, Salesforce, Pipedrive, Close, and Zoho for a 20-person team.',
        created_at: '2026-11-02T10:01:00.000Z',
      },
      db
    );

    const history = retrieveRelevantHistory(
      'What was the CRM shortlist we discussed earlier?',
      'UTC',
      null,
      null,
      new Date('2026-11-10T12:00:00Z'),
      db
    );

    expect(history.hasMatch).toBe(true);
    expect(history.excerpts.some((e) => e.content.includes('HubSpot, Salesforce'))).toBe(true);
  });

  it('honestly returns hasMatch=false when no history exists', () => {
    const history = retrieveRelevantHistory(
      'What did we decide about Kubernetes on 15 August 2025?',
      'UTC',
      null,
      null,
      new Date('2026-11-10T12:00:00Z'),
      db
    );

    expect(history.hasMatch).toBe(false);
    expect(history.excerpts.length).toBe(0);
  });
});
