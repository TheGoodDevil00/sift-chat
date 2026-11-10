import type Database from 'better-sqlite3';
import { getDb } from '../db/client';

const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any',
  'are', 'arent', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'cant', 'cannot', 'could', 'couldnt', 'did',
  'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few',
  'for', 'from', 'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having',
  'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most',
  'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'shouldnt', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them',
  'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'wasnt', 'we', 'were', 'werent', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'wont', 'would', 'wouldnt',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'tell', 'check', 'asked', 'give',
  'please', 'show', 'know', 'think', 'today', 'yesterday', 'tomorrow', 'now', 'since'
]);

/**
 * Extracts clean search keywords from query.
 */
export function extractFtsQueryTerms(text: string): string[] {
  // Extract alphanumeric tokens
  const rawWords = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);

  const meaningful = rawWords.filter((w) => !STOP_WORDS.has(w));
  return Array.from(new Set(meaningful));
}

/**
 * Sanitizes and prepares an FTS5 MATCH expression.
 */
export function buildFts5Query(terms: string[]): string | null {
  if (terms.length === 0) return null;

  // Escape double quotes and wrap each token in quotes for literal matching
  const tokens = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  // Use OR to match any of the salient keywords, BM25 will rank documents with multiple terms higher
  return tokens.join(' OR ');
}

export interface FtsMatchResult {
  messageId: string;
  rank: number;
}

/**
 * Searches the messages_fts virtual table using BM25 ranking.
 */
export function searchMessagesFts(
  query: string,
  limit = 20,
  dbInstance?: Database.Database
): FtsMatchResult[] {
  const terms = extractFtsQueryTerms(query);
  const matchExpr = buildFts5Query(terms);
  if (!matchExpr) return [];

  const db = dbInstance || getDb();

  try {
    const rows = db
      .prepare(`
        SELECT message_id as messageId, bm25(messages_fts) as rank
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      .all(matchExpr, limit) as FtsMatchResult[];

    return rows;
  } catch (err) {
    console.warn('FTS search query failed:', err);
    return [];
  }
}
