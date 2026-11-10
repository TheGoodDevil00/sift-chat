import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { resolveTemporalReference, formatZonedDate } from './temporal';
import { searchMessagesFts, extractFtsQueryTerms } from './fts';
import type { HistoryExcerpt, TemporalResolution, Message } from '@/types/chat';

export interface HistoryRetrievalResult {
  temporal: TemporalResolution;
  excerpts: HistoryExcerpt[];
  hasMatch: boolean;
  searchSummary: string;
}

export function retrieveRelevantHistory(
  userQuery: string,
  userTimezone = 'UTC',
  currentConversationId?: string | null,
  excludeMessageId?: string | null,
  referenceDate = new Date(),
  dbInstance?: Database.Database
): HistoryRetrievalResult {
  const db = dbInstance || getDb();
  const temporal = resolveTemporalReference(userQuery, userTimezone, referenceDate);

  const matchedMessagesMap = new Map<string, { message: Message; reason: 'date' | 'entity' | 'fts' | 'recent'; score: number }>();

  // A. Date-based retrieval
  if (temporal.hasDate && temporal.startDate && temporal.endDate) {
    const startIso = temporal.startDate.toISOString();
    const endIso = temporal.endDate.toISOString();

    const dateRows = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
        FROM messages
        WHERE created_at >= ? AND created_at <= ? AND status != 'failed'
        ORDER BY created_at ASC
        LIMIT 20
      `)
      .all(startIso, endIso) as Message[];

    for (const msg of dateRows) {
      if (excludeMessageId && msg.id === excludeMessageId) continue;
      matchedMessagesMap.set(msg.id, {
        message: msg,
        reason: 'date',
        score: 1000, // Highest priority
      });
    }

    // Ensure we retrieve paired messages (if user question found, get assistant response; if assistant found, get user question)
    const convIdsWithDates = Array.from(new Set(dateRows.map((m) => m.conversation_id)));
    for (const cId of convIdsWithDates) {
      const convMessages = db
        .prepare(`
          SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
          FROM messages
          WHERE conversation_id = ? AND status != 'failed'
          ORDER BY created_at ASC
        `)
        .all(cId) as Message[];

      for (let i = 0; i < convMessages.length; i++) {
        const m = convMessages[i];
        if (matchedMessagesMap.has(m.id)) {
          // Include adjacent pair if available
          if (m.role === 'user' && i + 1 < convMessages.length) {
            const next = convMessages[i + 1];
            if (!matchedMessagesMap.has(next.id) && next.id !== excludeMessageId) {
              matchedMessagesMap.set(next.id, { message: next, reason: 'date', score: 950 });
            }
          } else if (m.role === 'assistant' && i - 1 >= 0) {
            const prev = convMessages[i - 1];
            if (!matchedMessagesMap.has(prev.id) && prev.id !== excludeMessageId) {
              matchedMessagesMap.set(prev.id, { message: prev, reason: 'date', score: 950 });
            }
          }
        }
      }
    }
  }

  // B. FTS retrieval
  const queryTerms = extractFtsQueryTerms(userQuery);
  if (queryTerms.length > 0) {
    const ftsMatches = searchMessagesFts(userQuery, 15, db);
    for (const match of ftsMatches) {
      if (excludeMessageId && match.messageId === excludeMessageId) continue;
      if (matchedMessagesMap.has(match.messageId)) continue;

      const msg = db
        .prepare(`
          SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
          FROM messages
          WHERE id = ? AND status != 'failed'
        `)
        .get(match.messageId) as Message | undefined;

      if (msg) {
        // BM25 rank is negative in sqlite (more negative = better match)
        const score = 500 - match.rank * 10;
        matchedMessagesMap.set(msg.id, {
          message: msg,
          reason: 'fts',
          score,
        });

        // Also fetch paired message
        const pair = db
          .prepare(`
            SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
            FROM messages
            WHERE conversation_id = ? AND status != 'failed' AND id != ?
            ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
            LIMIT 1
          `)
          .get(msg.conversation_id, msg.id, msg.created_at) as Message | undefined;

        if (pair && !matchedMessagesMap.has(pair.id) && pair.id !== excludeMessageId) {
          matchedMessagesMap.set(pair.id, {
            message: pair,
            reason: 'fts',
            score: score - 5,
          });
        }
      }
    }
  }

  // Sort matched entries by score DESC, then created_at ASC
  const sortedEntries = Array.from(matchedMessagesMap.values()).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return new Date(a.message.created_at).getTime() - new Date(b.message.created_at).getTime();
  });

  // Limit to 12 excerpts
  const limited = sortedEntries.slice(0, 12);

  // Convert to HistoryExcerpt
  const excerpts: HistoryExcerpt[] = limited.map((item) => ({
    messageId: item.message.id,
    conversationId: item.message.conversation_id,
    role: item.message.role,
    content: item.message.content,
    createdAt: item.message.created_at,
    matchReason: item.reason,
  }));

  // Re-sort chronologically for reading coherence
  excerpts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const hasMatch = excerpts.length > 0;
  let searchSummary = '';
  if (temporal.hasDate) {
    searchSummary = `Searched for date: ${temporal.resolvedDisplay}. Found ${excerpts.length} prior message records.`;
  } else if (hasMatch) {
    searchSummary = `Searched by topic keywords: [${queryTerms.join(', ')}]. Found ${excerpts.length} prior message records.`;
  } else {
    searchSummary = 'No matching historical conversation records found in saved database.';
  }

  return {
    temporal,
    excerpts,
    hasMatch,
    searchSummary,
  };
}
