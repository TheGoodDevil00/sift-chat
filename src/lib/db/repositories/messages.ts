import { getDb } from '../client';
import type {
  Message,
  Citation,
  Source,
  MessageWithMeta,
  MessageRole,
  MessageStatus,
} from '@/types/chat';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export function insertMessage(
  data: {
    id?: string;
    conversation_id: string;
    role: MessageRole;
    content: string;
    created_at?: string;
    status?: MessageStatus;
    client_request_id?: string | null;
    model?: string | null;
    provider_response_id?: string | null;
    usage_json?: string | null;
  },
  dbInstance?: Database.Database
): { message: Message; isExisting: boolean } {
  const db = dbInstance || getDb();

  // Idempotency check: if client_request_id is provided, check if it already exists
  if (data.client_request_id) {
    const existing = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at, status,
               client_request_id, model, provider_response_id, usage_json
        FROM messages
        WHERE client_request_id = ?
      `)
      .get(data.client_request_id) as Message | undefined;

    if (existing) {
      return { message: existing, isExisting: true };
    }
  }

  const id = data.id || randomUUID();
  const created_at = data.created_at || new Date().toISOString();
  const status = data.status || 'complete';

  const message: Message = {
    id,
    conversation_id: data.conversation_id,
    role: data.role,
    content: data.content,
    created_at,
    status,
    client_request_id: data.client_request_id || null,
    model: data.model || null,
    provider_response_id: data.provider_response_id || null,
    usage_json: data.usage_json || null,
  };

  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, role, content, created_at, status,
      client_request_id, model, provider_response_id, usage_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.id,
    message.conversation_id,
    message.role,
    message.content,
    message.created_at,
    message.status,
    message.client_request_id,
    message.model,
    message.provider_response_id,
    message.usage_json
  );

  return { message, isExisting: false };
}

export function getMessage(
  id: string,
  dbInstance?: Database.Database
): Message | null {
  const db = dbInstance || getDb();
  const row = db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at, status,
             client_request_id, model, provider_response_id, usage_json
      FROM messages
      WHERE id = ?
    `)
    .get(id) as Message | undefined;

  return row || null;
}

export function updateMessage(
  id: string,
  updates: {
    content?: string;
    status?: MessageStatus;
    provider_response_id?: string | null;
    model?: string | null;
    usage_json?: string | null;
  },
  dbInstance?: Database.Database
): void {
  const db = dbInstance || getDb();
  const current = getMessage(id, db);
  if (!current) return;

  const content = updates.content !== undefined ? updates.content : current.content;
  const status = updates.status !== undefined ? updates.status : current.status;
  const provider_response_id =
    updates.provider_response_id !== undefined
      ? updates.provider_response_id
      : current.provider_response_id;
  const model = updates.model !== undefined ? updates.model : current.model;
  const usage_json =
    updates.usage_json !== undefined ? updates.usage_json : current.usage_json;

  db.prepare(`
    UPDATE messages
    SET content = ?, status = ?, provider_response_id = ?, model = ?, usage_json = ?
    WHERE id = ?
  `).run(content, status, provider_response_id, model, usage_json, id);
}

export function getRecentMessages(
  conversationId: string,
  limit = 12,
  dbInstance?: Database.Database
): Message[] {
  const db = dbInstance || getDb();
  // Fetch newest `limit` messages then order them chronologically
  const rows = db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at, status,
             client_request_id, model, provider_response_id, usage_json
      FROM messages
      WHERE conversation_id = ? AND status != 'failed'
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(conversationId, limit) as Message[];

  return rows.reverse();
}

export function insertCitations(
  citations: Array<{
    message_id: string;
    url: string;
    canonical_url: string;
    title?: string | null;
    start_index?: number | null;
    end_index?: number | null;
    retrieved_at?: string;
    source_metadata_json?: string | null;
  }>,
  dbInstance?: Database.Database
): Citation[] {
  if (citations.length === 0) return [];
  const db = dbInstance || getDb();
  const now = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO message_citations (
      id, message_id, url, canonical_url, title,
      start_index, end_index, retrieved_at, source_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const created: Citation[] = [];

  const tx = db.transaction(() => {
    for (const c of citations) {
      const citation: Citation = {
        id: randomUUID(),
        message_id: c.message_id,
        url: c.url,
        canonical_url: c.canonical_url,
        title: c.title || null,
        start_index: c.start_index !== undefined ? c.start_index : null,
        end_index: c.end_index !== undefined ? c.end_index : null,
        retrieved_at: c.retrieved_at || now,
        source_metadata_json: c.source_metadata_json || null,
      };

      insertStmt.run(
        citation.id,
        citation.message_id,
        citation.url,
        citation.canonical_url,
        citation.title,
        citation.start_index,
        citation.end_index,
        citation.retrieved_at,
        citation.source_metadata_json
      );

      created.push(citation);
    }
  });

  tx();
  return created;
}

export function insertSources(
  sources: Array<{
    message_id: string;
    url: string;
    canonical_url: string;
    title?: string | null;
    retrieved_at?: string;
    source_metadata_json?: string | null;
  }>,
  dbInstance?: Database.Database
): Source[] {
  if (sources.length === 0) return [];
  const db = dbInstance || getDb();
  const now = new Date().toISOString();

  const insertStmt = db.prepare(`
    INSERT INTO message_sources (
      id, message_id, url, canonical_url, title, retrieved_at, source_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const created: Source[] = [];

  const tx = db.transaction(() => {
    for (const s of sources) {
      const source: Source = {
        id: randomUUID(),
        message_id: s.message_id,
        url: s.url,
        canonical_url: s.canonical_url,
        title: s.title || null,
        retrieved_at: s.retrieved_at || now,
        source_metadata_json: s.source_metadata_json || null,
      };

      insertStmt.run(
        source.id,
        source.message_id,
        source.url,
        source.canonical_url,
        source.title,
        source.retrieved_at,
        source.source_metadata_json
      );

      created.push(source);
    }
  });

  tx();
  return created;
}

export function getMessageCitations(
  messageId: string,
  dbInstance?: Database.Database
): Citation[] {
  const db = dbInstance || getDb();
  return db
    .prepare(`
      SELECT id, message_id, url, canonical_url, title, start_index, end_index, retrieved_at, source_metadata_json
      FROM message_citations
      WHERE message_id = ?
      ORDER BY start_index ASC, id ASC
    `)
    .all(messageId) as Citation[];
}

export function getMessageSources(
  messageId: string,
  dbInstance?: Database.Database
): Source[] {
  const db = dbInstance || getDb();
  return db
    .prepare(`
      SELECT id, message_id, url, canonical_url, title, retrieved_at, source_metadata_json
      FROM message_sources
      WHERE message_id = ?
      ORDER BY id ASC
    `)
    .all(messageId) as Source[];
}

export function getConversationMessagesWithMeta(
  conversationId: string,
  dbInstance?: Database.Database
): MessageWithMeta[] {
  const db = dbInstance || getDb();
  const messages = db
    .prepare(`
      SELECT id, conversation_id, role, content, created_at, status,
             client_request_id, model, provider_response_id, usage_json
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `)
    .all(conversationId) as Message[];

  if (messages.length === 0) return [];

  const citations = db
    .prepare(`
      SELECT c.id, c.message_id, c.url, c.canonical_url, c.title,
             c.start_index, c.end_index, c.retrieved_at, c.source_metadata_json
      FROM message_citations c
      JOIN messages m ON c.message_id = m.id
      WHERE m.conversation_id = ?
      ORDER BY c.start_index ASC, c.id ASC
    `)
    .all(conversationId) as Citation[];

  const sources = db
    .prepare(`
      SELECT s.id, s.message_id, s.url, s.canonical_url, s.title,
             s.retrieved_at, s.source_metadata_json
      FROM message_sources s
      JOIN messages m ON s.message_id = m.id
      WHERE m.conversation_id = ?
      ORDER BY s.id ASC
    `)
    .all(conversationId) as Source[];

  const citationsByMessage = new Map<string, Citation[]>();
  for (const c of citations) {
    if (!citationsByMessage.has(c.message_id)) {
      citationsByMessage.set(c.message_id, []);
    }
    citationsByMessage.get(c.message_id)!.push(c);
  }

  const sourcesByMessage = new Map<string, Source[]>();
  for (const s of sources) {
    if (!sourcesByMessage.has(s.message_id)) {
      sourcesByMessage.set(s.message_id, []);
    }
    sourcesByMessage.get(s.message_id)!.push(s);
  }

  return messages.map((m) => ({
    ...m,
    citations: citationsByMessage.get(m.id) || [],
    sources: sourcesByMessage.get(m.id) || [],
  }));
}
