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

  it('retrieves the CRM shortlist under realistic load (25 noise messages on Monday followed by shortlist)', () => {
    const conv = createConversation({ title: 'Work Log Monday' }, db);

    // 25 unrelated messages on Monday (2026-11-02)
    for (let i = 1; i <= 25; i++) {
      const minute = i < 10 ? `0${i}` : `${i}`;
      insertMessage(
        {
          conversation_id: conv.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Unrelated Monday message #${i}: discussing random task details, lunch ordering, and bug fix ${i}.`,
          created_at: `2026-11-02T09:${minute}:00.000Z`,
        },
        db
      );
    }

    // Message #26: The actual CRM shortlist on Monday afternoon
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'shortlisted 5 CRM tools: HubSpot, Pipedrive, Close, Zoho, Freshsales for a 20-person sales team',
        created_at: '2026-11-02T16:30:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'Excellent shortlist for the 20-person sales team: HubSpot, Pipedrive, Close, Zoho, and Freshsales.',
        created_at: '2026-11-02T16:31:00.000Z',
      },
      db
    );

    // Query on Friday (2026-11-06) referencing Monday's event and asking what changed since
    const refDate = new Date('2026-11-06T12:00:00.000Z');
    const query = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';

    const history = retrieveRelevantHistory(
      query,
      'UTC',
      null,
      null,
      refDate,
      db
    );

    expect(history.hasMatch).toBe(true);
    expect(history.confidence).toBe('high');

    // Decisive assertion: SHORTLIST PRESENT must be TRUE!
    const hasShortlist = history.excerpts.some((e) =>
      e.content.includes('HubSpot, Pipedrive, Close, Zoho, Freshsales')
    );
    expect(hasShortlist).toBe(true);

    // Irrelevant noise messages must NOT crowd out the shortlist
    const noiseCount = history.excerpts.filter((e) => e.content.includes('lunch ordering')).length;
    expect(noiseCount).toBe(0);

    // Hard token budget must be respected
    expect(history.totalTokensUsed).toBeLessThanOrEqual(1200);
  });

  it('retrieves complete day history under normal 12-message load without truncation', () => {
    const conv = createConversation({ title: 'Nov 3 Routine Chat' }, db);

    // 8 morning filler messages
    for (let i = 1; i <= 8; i++) {
      const minute = i < 10 ? `0${i}` : `${i}`;
      insertMessage(
        {
          conversation_id: conv.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Morning filler turn #${i}: standup notes, ticket triage, and morning planning.`,
          created_at: `2026-11-03T09:${minute}:00.000Z`,
        },
        db
      );
    }

    // 4 afternoon Q&A messages with real substance
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'Which serverless vector databases offer generous free tiers?',
        created_at: '2026-11-03T15:30:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'Pinecone provides a free starter index. Qdrant Cloud offers a free 1GB cluster.',
        created_at: '2026-11-03T15:31:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'What about Turbopuffer search pricing?',
        created_at: '2026-11-03T15:35:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'Turbopuffer charges $0.05 per million vector operations with initial credits.',
        created_at: '2026-11-03T15:36:00.000Z',
      },
      db
    );

    const refDate = new Date('2026-11-10T12:00:00.000Z');
    const query = 'What did I ask you on 3 November? Is your answer still correct today?';

    const history = retrieveRelevantHistory(
      query,
      'UTC',
      conv.id,
      null,
      refDate,
      db
    );

    expect(history.hasMatch).toBe(true);
    expect(history.dayTruncated).toBe(false);
    expect(history.confidence).toBe('high');

    // All 12 messages fit within the 1200-token budget and 25-excerpt cap
    expect(history.excerpts.length).toBe(12);

    // Verify afternoon Q&A is fully present
    const hasVectorQ = history.excerpts.some((e) => e.content.includes('serverless vector databases'));
    const hasVectorA = history.excerpts.some((e) => e.content.includes('Pinecone provides a free starter index'));
    expect(hasVectorQ).toBe(true);
    expect(hasVectorA).toBe(true);

    expect(history.totalTokensUsed).toBeLessThanOrEqual(1200);
  });

  it('prioritizes recent exchanges and signals truncation under heavy day load (35 messages)', () => {
    const conv = createConversation({ title: 'Nov 3 Heavy Chat' }, db);

    // 25 morning filler messages
    for (let i = 1; i <= 25; i++) {
      const minute = i < 10 ? `0${i}` : `${i}`;
      insertMessage(
        {
          conversation_id: conv.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Early chatter #${i}: team discussion on miscellaneous topics and notes ${i}.`,
          created_at: `2026-11-03T08:${minute}:00.000Z`,
        },
        db
      );
    }

    // 10 afternoon messages including critical Q&A
    for (let i = 1; i <= 8; i++) {
      const minute = i < 10 ? `0${i}` : `${i}`;
      insertMessage(
        {
          conversation_id: conv.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Afternoon project discussion #${i} on design choices.`,
          created_at: `2026-11-03T14:${minute}:00.000Z`,
        },
        db
      );
    }

    insertMessage(
      {
        conversation_id: conv.id,
        role: 'user',
        content: 'What are the top 3 vector database options for high scale?',
        created_at: '2026-11-03T16:45:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: conv.id,
        role: 'assistant',
        content: 'At high scale, Pinecone Serverless, Milvus distributed, and Qdrant distributed lead.',
        created_at: '2026-11-03T16:46:00.000Z',
      },
      db
    );

    const refDate = new Date('2026-11-10T12:00:00.000Z');
    const query = 'What did I ask you on 3 November? Is your answer still correct today?';

    const history = retrieveRelevantHistory(
      query,
      'UTC',
      conv.id,
      null,
      refDate,
      db
    );

    expect(history.hasMatch).toBe(true);
    expect(history.dayTruncated).toBe(true);
    expect(history.confidence).toBe('low');
    expect(history.truncationNote).toBeDefined();
    expect(history.truncationNote).toContain('35 messages');

    // Due to intra-day recency ranking, the late afternoon question must be preserved!
    const hasLateQ = history.excerpts.some((e) => e.content.includes('top 3 vector database options'));
    expect(hasLateQ).toBe(true);

    expect(history.totalTokensUsed).toBeLessThanOrEqual(1200);
  });

  it('correctly retrieves full 3 November history even when archive contains a poison meta-word message like "That is correct."', () => {
    // Poison conversation: contains words like "correct", "still", "answer", "ask" on an unrelated date (Oct 5)
    const poisonConv = createConversation({ title: 'Unrelated October Chat' }, db);
    insertMessage(
      {
        conversation_id: poisonConv.id,
        role: 'user',
        content: 'Is Postgres ACID compliant?',
        created_at: '2026-10-05T10:00:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: poisonConv.id,
        role: 'assistant',
        content: 'That is correct. Let me know if you need anything else.',
        created_at: '2026-10-05T10:01:00.000Z',
      },
      db
    );

    // Target conversation: 12 messages on 3 November
    const targetConv = createConversation({ title: 'Nov 3 Vector Chat' }, db);
    for (let i = 1; i <= 8; i++) {
      const minute = i < 10 ? `0${i}` : `${i}`;
      insertMessage(
        {
          conversation_id: targetConv.id,
          role: i % 2 === 1 ? 'user' : 'assistant',
          content: `Morning standup notes #${i}: ticket triage and sprint progress.`,
          created_at: `2026-11-03T09:${minute}:00.000Z`,
        },
        db
      );
    }

    insertMessage(
      {
        conversation_id: targetConv.id,
        role: 'user',
        content: 'Which serverless vector databases offer generous free tiers?',
        created_at: '2026-11-03T15:30:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: targetConv.id,
        role: 'assistant',
        content: 'Pinecone provides a free starter index. Qdrant Cloud offers a free 1GB cluster.',
        created_at: '2026-11-03T15:31:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: targetConv.id,
        role: 'user',
        content: 'What about Turbopuffer search pricing?',
        created_at: '2026-11-03T15:35:00.000Z',
      },
      db
    );
    insertMessage(
      {
        conversation_id: targetConv.id,
        role: 'assistant',
        content: 'Turbopuffer charges $0.05 per million vector operations with initial credits.',
        created_at: '2026-11-03T15:36:00.000Z',
      },
      db
    );

    const refDate = new Date('2026-11-10T12:00:00.000Z');
    const query = 'What did I ask you on 3 November? Is your answer still correct today?';

    const history = retrieveRelevantHistory(
      query,
      'UTC',
      targetConv.id,
      null,
      refDate,
      db
    );

    expect(history.hasMatch).toBe(true);
    // Crucial assertion: the poison Oct 5 message "That is correct." must NOT poison the retrieval!
    const poisonFound = history.excerpts.some((e) => e.content.includes('That is correct.'));
    expect(poisonFound).toBe(false);

    // All 12 messages from 3 November must be preserved
    expect(history.excerpts.length).toBe(12);

    // Both the user question and assistant answer from 3 November must be present
    const hasVectorQ = history.excerpts.some((e) => e.content.includes('serverless vector databases'));
    const hasVectorA = history.excerpts.some((e) => e.content.includes('Pinecone provides a free starter index'));
    expect(hasVectorQ).toBe(true);
    expect(hasVectorA).toBe(true);

    expect(history.dayTruncated).toBe(false);
    expect(history.confidence).toBe('high');
  });
});

describe('Temporal interval resolution', () => {
  const refDate = new Date('2026-11-10T12:00:00Z'); // Tuesday

  it('resolves "last week" as the previous Monday-Sunday calendar week', () => {
    const result = resolveTemporalReference('What did we decide last week?', 'UTC', refDate);

    expect(result.hasDate).toBe(true);
    expect(result.isInterval).toBe(true);
    expect(result.startDate?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-11-08T23:59:59.999Z');
    expect(result.resolvedDisplay).toContain('2 November 2026');
    expect(result.resolvedDisplay).toContain('8 November 2026');
  });

  it('resolves "last week" using the user timezone day boundaries', () => {
    const result = resolveTemporalReference('What did we decide last week?', 'Asia/Kolkata', refDate);

    expect(result.startDate?.toISOString()).toBe('2026-11-01T18:30:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-11-08T18:29:59.999Z');
  });

  it('resolves "in the last two weeks" as a rolling 14-day window, not a single day', () => {
    const result = resolveTemporalReference('What changed in the last two weeks?', 'UTC', refDate);

    expect(result.hasDate).toBe(true);
    expect(result.isInterval).toBe(true);
    expect(result.startDate?.toISOString()).toBe('2026-10-27T12:00:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
  });

  it('resolves numeric rolling windows and word counts', () => {
    const threeDays = resolveTemporalReference('Show me the last 3 days.', 'UTC', refDate);
    expect(threeDays.startDate?.toISOString()).toBe('2026-11-07T12:00:00.000Z');

    const twoWeeks = resolveTemporalReference('What did we discuss over the past two weeks?', 'UTC', refDate);
    expect(twoWeeks.startDate?.toISOString()).toBe('2026-10-27T12:00:00.000Z');
  });

  it('resolves calendar months distinctly from rolling windows', () => {
    const lastMonth = resolveTemporalReference('What did we decide last month?', 'UTC', refDate);
    expect(lastMonth.startDate?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(lastMonth.endDate?.toISOString()).toBe('2026-10-31T23:59:59.999Z');

    const rollingMonth = resolveTemporalReference('What changed in the past month?', 'UTC', refDate);
    expect(rollingMonth.startDate?.toISOString()).toBe('2026-10-10T00:00:00.000Z');
    expect(rollingMonth.endDate?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
  });

  it('resolves "this week" from Monday to now', () => {
    const result = resolveTemporalReference('What have we done this week?', 'UTC', refDate);
    expect(result.startDate?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(result.endDate?.toISOString()).toBe('2026-11-10T12:00:00.000Z');
  });

  it('bounds vague "earlier" recall to a recent window and marks it approximate', () => {
    const result = resolveTemporalReference('What did I ask you earlier?', 'UTC', refDate);
    expect(result.hasDate).toBe(true);
    expect(result.startDate?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
    expect(result.confidence).toBe('approximate');
  });

  it('does not let the vague-recent fallback override an explicit date', () => {
    const result = resolveTemporalReference('Earlier, on 3 November, I asked about Postgres.', 'UTC', refDate);
    expect(result.startDate?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(result.confidence).toBe('exact');
  });

  it('retrieves every message in a "last week" interval', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    try {
      const conv = createConversation({ title: 'Last week' }, db);
      insertMessage(
        {
          conversation_id: conv.id,
          role: 'user',
          content: 'We compared Neon and Supabase for Postgres hosting.',
          created_at: '2026-11-02T10:00:00.000Z',
        },
        db
      );
      insertMessage(
        {
          conversation_id: conv.id,
          role: 'user',
          content: 'We also discussed connection pooling limits.',
          created_at: '2026-11-05T10:00:00.000Z',
        },
        db
      );
      insertMessage(
        {
          conversation_id: conv.id,
          role: 'user',
          content: 'This message is outside the window.',
          created_at: '2026-10-28T10:00:00.000Z',
        },
        db
      );

      const history = retrieveRelevantHistory(
        'What did we discuss last week?',
        'UTC',
        null,
        null,
        refDate,
        db
      );

      expect(history.hasMatch).toBe(true);
      const contents = history.excerpts.map((e) => e.content).join(' ');
      expect(contents).toContain('Neon and Supabase');
      expect(contents).toContain('connection pooling');
      expect(contents).not.toContain('outside the window');
    } finally {
      db.close();
    }
  });
});

describe('Relevance floor is scoped to the resolved date window', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  const seed = (conversationTitle: string, role: 'user' | 'assistant', content: string, createdAt: string) => {
    // Reuse one conversation per title so turns stay paired.
    const existing = db
      .prepare('SELECT id FROM conversations WHERE title = ? LIMIT 1')
      .get(conversationTitle) as { id: string } | undefined;
    const conversationId = existing
      ? existing.id
      : createConversation({ title: conversationTitle }, db).id;
    insertMessage({ conversation_id: conversationId, role, content, created_at: createdAt }, db);
  };

  it('keeps the answer on the named day when only the question matches the query', () => {
    seed('Tuesday DB talk', 'user', 'Compare Neon and Supabase Pro for Postgres hosting for our 20-person team.', '2026-11-03T15:30:00.000Z');
    seed('Tuesday DB talk', 'assistant', 'Supabase Pro starts at $25/month. Neon compute starts around $0.10/CU-hour.', '2026-11-03T15:31:00.000Z');

    const history = retrieveRelevantHistory(
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?',
      'UTC',
      null,
      null,
      new Date('2026-11-10T12:00:00.000Z'),
      db
    );

    const contents = history.excerpts.map((e) => e.content).join('\n');
    expect(history.confidence).toBe('high');
    expect(contents).toContain('Compare Neon and Supabase Pro');
    expect(contents).toContain('Supabase Pro starts at $25/month');
  });

  it('keeps the named day when its wording differs and the query words occur only in another month', () => {
    seed('Tuesday DB choice', 'user', 'Compare Neon and Supabase Pro for our 20-person backend team.', '2026-11-03T15:30:00.000Z');
    seed('Tuesday DB choice', 'assistant', 'Supabase Pro is $25/month; Neon compute is usage-based.', '2026-11-03T15:31:00.000Z');
    seed('September ACID chat', 'user', 'Is Postgres ACID compliant?', '2026-09-10T10:00:00.000Z');
    seed('September ACID chat', 'assistant', 'Yes, Postgres is fully ACID compliant.', '2026-09-10T10:01:00.000Z');

    const history = retrieveRelevantHistory(
      'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?',
      'UTC',
      null,
      null,
      new Date('2026-11-10T12:00:00.000Z'),
      db
    );

    const contents = history.excerpts.map((e) => e.content).join('\n');
    expect(contents).toContain('Compare Neon and Supabase Pro');
    expect(contents).toContain('Neon compute is usage-based');
    // The unrelated September discussion must not replace the named day.
    expect(contents).not.toContain('ACID compliant');
    // Date evidence is exact, but there is no lexical topic match to overclaim.
    expect(history.confidence).toBe('medium');
    expect(history.topicMatched).toBe(false);
  });

  it('does not let an unrelated Postgres message elsewhere veto a topic query about 3 November', () => {
    seed('Nov 3 Vector Chat', 'user', 'Which serverless vector databases offer generous free tiers?', '2026-11-03T15:30:00.000Z');
    seed('Nov 3 Vector Chat', 'assistant', 'Pinecone provides a free starter index. Qdrant Cloud offers a free 1GB cluster.', '2026-11-03T15:31:00.000Z');
    seed('Unrelated Postgres Chat', 'user', 'Is Postgres ACID compliant?', '2026-10-05T10:00:00.000Z');
    seed('Unrelated Postgres Chat', 'assistant', 'That is correct.', '2026-10-05T10:01:00.000Z');

    const history = retrieveRelevantHistory(
      'What did I ask you about Postgres on 3 November?',
      'UTC',
      null,
      null,
      new Date('2026-11-10T12:00:00.000Z'),
      db
    );

    const contents = history.excerpts.map((e) => e.content).join('\n');
    expect(contents).toContain('serverless vector databases');
    expect(contents).toContain('Pinecone provides a free starter index');
    expect(contents).not.toContain('Postgres ACID compliant');
    expect(contents).not.toContain('That is correct.');
  });

  it('recovers the shortlist whichever CRM vendor occupies the last slot', () => {
    for (const vendor of ['Freshsales', 'Attio', 'Copper']) {
      const fresh = new Database(':memory:');
      fresh.pragma('foreign_keys = ON');
      runMigrations(fresh);
      const conv = createConversation({ title: `Monday ${vendor}` }, fresh);
      for (let i = 1; i <= 25; i++) {
        const minute = i < 10 ? `0${i}` : `${i}`;
        insertMessage(
          {
            conversation_id: conv.id,
            role: i % 2 === 1 ? 'user' : 'assistant',
            content: `Unrelated Monday message #${i}: lunch ordering and bug fix ${i}.`,
            created_at: `2026-11-02T09:${minute}:00.000Z`,
          },
          fresh
        );
      }
      insertMessage(
        {
          conversation_id: conv.id,
          role: 'user',
          content: `shortlisted 5 CRM tools: HubSpot, Pipedrive, Close, Zoho, ${vendor} for a 20-person sales team`,
          created_at: '2026-11-02T16:30:00.000Z',
        },
        fresh
      );
      insertMessage(
        {
          conversation_id: conv.id,
          role: 'assistant',
          content: `Shortlist: HubSpot, Pipedrive, Close, Zoho, ${vendor}.`,
          created_at: '2026-11-02T16:31:00.000Z',
        },
        fresh
      );

      const history = retrieveRelevantHistory(
        'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
        'UTC',
        null,
        null,
        new Date('2026-11-06T12:00:00.000Z'),
        fresh
      );

      const contents = history.excerpts.map((e) => e.content).join('\n');
      expect(contents, vendor).toContain(vendor);
      expect(contents, vendor).not.toContain('lunch ordering');
      expect(history.totalTokensUsed, vendor).toBeLessThanOrEqual(1200);
      fresh.close();
    }
  });
});
