import { getDb } from '../client';
import type { Conversation, ConversationSummary } from '@/types/chat';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export function createConversation(
  data: { id?: string; title: string; timezone?: string },
  dbInstance?: Database.Database
): Conversation {
  const db = dbInstance || getDb();
  const id = data.id || randomUUID();
  const now = new Date().toISOString();

  const conv: Conversation = {
    id,
    title: data.title,
    timezone: data.timezone || 'UTC',
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };

  db.prepare(`
    INSERT INTO conversations (id, title, timezone, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(conv.id, conv.title, conv.timezone, conv.created_at, conv.updated_at);

  return conv;
}

export function getConversation(
  id: string,
  dbInstance?: Database.Database
): Conversation | null {
  const db = dbInstance || getDb();
  const row = db
    .prepare(`
      SELECT id, title, timezone, created_at, updated_at, deleted_at
      FROM conversations
      WHERE id = ? AND deleted_at IS NULL
    `)
    .get(id) as Conversation | undefined;

  return row || null;
}

export function listConversations(
  limit = 50,
  offset = 0,
  dbInstance?: Database.Database
): ConversationSummary[] {
  const db = dbInstance || getDb();
  const rows = db
    .prepare(`
      SELECT id, title, created_at as createdAt, updated_at as updatedAt
      FROM conversations
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset) as ConversationSummary[];

  return rows;
}

export function touchConversation(
  id: string,
  updates?: { title?: string; timezone?: string },
  dbInstance?: Database.Database
): void {
  const db = dbInstance || getDb();
  const now = new Date().toISOString();

  if (updates?.title && updates?.timezone) {
    db.prepare(`
      UPDATE conversations
      SET title = ?, timezone = ?, updated_at = ?
      WHERE id = ?
    `).run(updates.title, updates.timezone, now, id);
  } else if (updates?.title) {
    db.prepare(`
      UPDATE conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(updates.title, now, id);
  } else if (updates?.timezone) {
    db.prepare(`
      UPDATE conversations
      SET timezone = ?, updated_at = ?
      WHERE id = ?
    `).run(updates.timezone, now, id);
  } else {
    db.prepare(`
      UPDATE conversations
      SET updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }
}

export function deleteConversation(
  id: string,
  hard = false,
  dbInstance?: Database.Database
): boolean {
  const db = dbInstance || getDb();
  if (hard) {
    const res = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.changes > 0;
  }
  const now = new Date().toISOString();
  const res = db
    .prepare('UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now, id);
  return res.changes > 0;
}
