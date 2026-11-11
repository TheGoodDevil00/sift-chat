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
  confidence: 'high' | 'medium' | 'low' | 'none';
  topicMatched: boolean;
  missingTopicExplanation?: string;
  totalTokensUsed: number;
  dayTruncated?: boolean;
  totalDayMessages?: number;
  packedDayMessages?: number;
  truncationNote?: string;
}

const CALENDAR_META_WORDS = new Set([
  'discuss', 'discussed', 'discussing', 'discussion', 'discussions',
  'chat', 'chats', 'talk', 'talked', 'talking', 'ask', 'asked', 'asking',
  'conversation', 'conversations', 'recall', 'say', 'said', 'tell', 'told',
  'happen', 'happened', 'session', 'sessions', 'notes', 'summary', 'summarize',
  'review', 'remember', 'question', 'questions', 'answer', 'answers',
  'decide', 'decided', 'decision', 'spoke', 'history', 'earlier', 'previously',
  // Greetings & conversational fillers
  'hello', 'hi', 'hey', 'howdy', 'greetings', 'sup', 'thanks', 'thank',
  'please', 'help', 'welcome', 'good', 'morning', 'afternoon', 'evening',
  'bye', 'goodbye', 'okay', 'ok', 'yes', 'no',
  // Weekdays & relative
  'mon', 'monday', 'tue', 'tuesday', 'wed', 'wednesday', 'thu', 'thursday',
  'fri', 'friday', 'sat', 'saturday', 'sun', 'sunday',
  'yesterday', 'today', 'tomorrow', 'day', 'days', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'last', 'past', 'next', 'since', 'ago',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty',
  // Months
  'january', 'jan', 'february', 'feb', 'march', 'mar', 'april', 'apr',
  'may', 'june', 'jun', 'july', 'jul', 'august', 'aug', 'september', 'sep',
  'october', 'oct', 'november', 'nov', 'december', 'dec',
  // Inquiry / Freshness meta words (not domain topics)
  'correct', 'true', 'accurate', 'valid', 'case', 'still',
  'changed', 'changes', 'changing', 'pricing', 'prices', 'price',
  'shipping', 'shipped', 'updates', 'update', 'updating', 'new', 'latest',
  'recent', 'current', 'difference', 'differs', 'different', 'status',
]);

function isCalendarOrMetaToken(t: string): boolean {
  const lower = t.toLowerCase();
  if (CALENDAR_META_WORDS.has(lower)) return true;
  // Numeric tokens like "3", "2026", "3rd"
  if (/^\d+(?:st|nd|rd|th)?$/i.test(lower)) return true;
  return false;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  // 1. Analyze query terms: identify substantive domain keywords
  const allTerms = extractFtsQueryTerms(userQuery);
  const substantiveTerms = allTerms.filter((t) => !isCalendarOrMetaToken(t));
  const isTopicQuery = substantiveTerms.length > 0;

  // Candidate pool keyed by message ID
  interface Candidate {
    message: Message;
    ftsRank?: number;
    termMatches: number;
    isDateMatch: boolean;
    isPair: boolean;
    /** True for an out-of-window turn adjacent to an in-window message. */
    pairedWithDate: boolean;
    reason: 'fts' | 'date' | 'entity' | 'recent';
  }
  const candidateMap = new Map<string, Candidate>();

  // Helper to register or update a candidate
  const registerCandidate = (
    msg: Message,
    reason: 'fts' | 'date' | 'entity' | 'recent',
    isDateMatch: boolean,
    ftsRank?: number,
    isPair = false
  ) => {
    if (excludeMessageId && msg.id === excludeMessageId) return;

    const existing = candidateMap.get(msg.id);
    const contentLower = msg.content.toLowerCase();
    const termMatches = substantiveTerms.filter((t) => contentLower.includes(t.toLowerCase())).length;

    if (existing) {
      if (ftsRank !== undefined && (existing.ftsRank === undefined || ftsRank < existing.ftsRank)) {
        existing.ftsRank = ftsRank;
      }
      if (isDateMatch) existing.isDateMatch = true;
      existing.termMatches = Math.max(existing.termMatches, termMatches);
      // A message can be both a date/FTS candidate and the paired turn of
      // another candidate. Marking it as a pair must survive that merge:
      // otherwise the adjacent answer is dropped by the relevance floor.
      if (isPair) existing.isPair = true;
    } else {
      candidateMap.set(msg.id, {
        message: msg,
        ftsRank,
        termMatches,
        isDateMatch,
        isPair,
        pairedWithDate: false,
        reason,
      });
    }
  };

  // 2. Candidate Source A: FTS search across all messages using substantive topic terms ONLY
  // For pure recall queries with no substantive terms (e.g. "What did I ask you on 3 November?"),
  // DO NOT run FTS on meta/calendar words ("ask", "november", "answer", "still", "correct"),
  // as matching an unrelated message ("That is correct.") would poison the recall candidate pool.
  if (substantiveTerms.length > 0) {
    const ftsMatches = searchMessagesFts(substantiveTerms, 50, db);
    for (const match of ftsMatches) {
      if (excludeMessageId && match.messageId === excludeMessageId) continue;
      const msg = db
        .prepare(`
          SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
          FROM messages
          WHERE id = ? AND status != 'failed'
        `)
        .get(match.messageId) as Message | undefined;

      if (msg) {
        let isDate = false;
        if (temporal.hasDate && temporal.startDate && temporal.endDate) {
          const createdAtTime = new Date(msg.created_at).getTime();
          isDate = createdAtTime >= temporal.startDate.getTime() && createdAtTime <= temporal.endDate.getTime();
        }
        registerCandidate(msg, 'fts', isDate, match.rank, false);
      }
    }
  }

  // 3. Candidate Source B: Temporal date window query
  let totalDayCandidates = 0;
  if (temporal.hasDate && temporal.startDate && temporal.endDate) {
    const startIso = temporal.startDate.toISOString();
    const endIso = temporal.endDate.toISOString();

    const dateRows = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
        FROM messages
        WHERE created_at >= ? AND created_at <= ? AND status != 'failed'
        ORDER BY created_at ASC
        LIMIT 200
      `)
      .all(startIso, endIso) as Message[];

    for (const msg of dateRows) {
      if (excludeMessageId && msg.id === excludeMessageId) continue;
      totalDayCandidates++;
      registerCandidate(msg, 'date', true, undefined, false);
    }
  }

  // 4. Candidate Source C: Conversation pairs for high-signal candidates
  // Fetch adjacent conversational turns (e.g. user question for assistant answer, or vice-versa)
  const initialCandidates = Array.from(candidateMap.values());
  for (const cand of initialCandidates) {
    // Only pull pairs for candidates that have topical signal. Date-only
    // candidates already bring the whole window when nothing matches, so
    // they need no extra neighbour lookup.
    if (isTopicQuery && cand.termMatches === 0 && cand.ftsRank === undefined) continue;

    const pair = db
      .prepare(`
        SELECT id, conversation_id, role, content, created_at, status, client_request_id, model, provider_response_id, usage_json
        FROM messages
        WHERE conversation_id = ? AND status != 'failed' AND id != ?
        ORDER BY ABS(strftime('%s', created_at) - strftime('%s', ?)) ASC
        LIMIT 1
      `)
      .get(cand.message.conversation_id, cand.message.id, cand.message.created_at) as Message | undefined;

    if (pair) {
      let isPairDate = false;
      if (temporal.hasDate && temporal.startDate && temporal.endDate) {
        const t = new Date(pair.created_at).getTime();
        isPairDate = t >= temporal.startDate.getTime() && t <= temporal.endDate.getTime();
      }
      // Register even when the neighbour is already a candidate (for example
      // inside a date window) so it is flagged as paired context and survives
      // the relevance floor.
      registerCandidate(pair, cand.reason, isPairDate, undefined, true);
      if (cand.isDateMatch) {
        const registered = candidateMap.get(pair.id);
        if (registered) registered.pairedWithDate = true;
      }
    }
  }

  // 5. Score Candidates with Relevance-First Ranking and Relevance Floor
  interface ScoredCandidate {
    candidate: Candidate;
    score: number;
    lexicalScore: number;
    temporalScore: number;
  }

  const scoredList: ScoredCandidate[] = [];

  // Scope the relevance floor to the resolved date window. A query whose
  // subject words appear only in an unrelated month must not delete the day the
  // user actually named: date is the primary signal there, topic only ranks.
  const dateWindowCandidates = Array.from(candidateMap.values()).filter((c) => c.isDateMatch);
  const hasDateWindow = temporal.hasDate && dateWindowCandidates.length > 0;
  const hasInWindowTopicHits = dateWindowCandidates.some(
    (c) => c.ftsRank !== undefined || c.termMatches > 0
  );

  // Topic hits anywhere in the archive. Only consulted when no date window
  // resolved, where it is the only relevance signal available.
  const hasAnyTopicHits =
    substantiveTerms.length > 0 &&
    Array.from(candidateMap.values()).some((c) => {
      return c.ftsRank !== undefined || c.termMatches > 0;
    });

  for (const cand of candidateMap.values()) {
    // A. Lexical Relevance
    // BM25 rank in SQLite is negative where more negative = better match
    let lexicalScore = 0;
    if (cand.ftsRank !== undefined) {
      lexicalScore += Math.max(0, -cand.ftsRank * 10);
    }
    if (substantiveTerms.length > 0) {
      const matchRatio = cand.termMatches / substantiveTerms.length;
      lexicalScore += matchRatio * 100;
    }

    // B. Temporal Alignment
    let temporalScore = 0;
    if (cand.isDateMatch) {
      // Synergy: if both date AND topic match, award high temporal bonus
      temporalScore = lexicalScore > 0 ? 100 : 50;

      // 1. Current conversation bonus: strongest signal for "what did I ask you"
      if (currentConversationId && cand.message.conversation_id === currentConversationId) {
        temporalScore += 40;
      }

      // 2. Intra-day recency bonus: within the day window, later messages score up to +40 higher
      if (temporal.startDate && temporal.endDate) {
        const startMs = temporal.startDate.getTime();
        const endMs = temporal.endDate.getTime();
        const msgMs = new Date(cand.message.created_at).getTime();
        if (endMs > startMs) {
          const recencyFraction = Math.max(0, Math.min(1, (msgMs - startMs) / (endMs - startMs)));
          temporalScore += recencyFraction * 40;
        }
      }

      // 3. User question slight nudge (+2) within the same timestamp turn
      if (cand.message.role === 'user') {
        temporalScore += 2;
      }
    }

    // C. Relevance Floor Check
    if (hasDateWindow) {
      // A resolved date scopes the answer. Matches from outside the window are
      // not evidence about that date, unless the turn is adjacent context for
      // a message inside the window (conversation starting just before midnight).
      if (!cand.isDateMatch && !cand.pairedWithDate) {
        continue;
      }

      // Inside the window, drop unrelated chatter only when the window also
      // contains a topical anchor. If the day has no lexical overlap at all
      // (the user's words differ from the transcript), keep the whole day
      // rather than returning a different conversation.
      if (cand.isDateMatch && hasInWindowTopicHits && lexicalScore <= 0 && !cand.isPair) {
        continue;
      }
    } else if (hasAnyTopicHits && lexicalScore <= 0) {
      // No date window: retain paired context for topical candidates, drop the rest.
      if (cand.isPair) {
        lexicalScore = 20;
      } else {
        continue;
      }
    }

    let finalScore = lexicalScore + temporalScore;
    if (cand.isPair && !cand.isDateMatch) {
      finalScore *= 0.85; // slightly discount paired context only for out-of-date FTS matches
    }

    scoredList.push({
      candidate: cand,
      score: finalScore,
      lexicalScore,
      temporalScore,
    });
  }

  // 6. Sort by Score DESC, then recency DESC (newest turns prioritized under truncation)
  scoredList.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.001) {
      return b.score - a.score;
    }
    return new Date(b.candidate.message.created_at).getTime() - new Date(a.candidate.message.created_at).getTime();
  });

  // 7. Token Budget Packing & Deduplication
  // Budget: 1,200 tokens (~4,800 characters) max for historical context
  // Cap individual excerpt length to 800 characters (~200 tokens)
  // Cap count raised to 25 so token budget (1,200 tokens) governs packing rather than an arbitrary count cap
  const MAX_HISTORY_TOKENS = 1200;
  const MAX_EXCERPT_CHARS = 800;
  const MAX_EXCERPTS_COUNT = 25;

  const selectedExcerpts: HistoryExcerpt[] = [];
  const seenContentHashes = new Set<string>();
  let totalTokensUsed = 0;
  let hitBudgetLimit = false;

  for (const item of scoredList) {
    if (selectedExcerpts.length >= MAX_EXCERPTS_COUNT) {
      hitBudgetLimit = true;
      break;
    }

    const rawContent = item.candidate.message.content.trim();
    // Content-based deduplication: normalize whitespace
    const contentKey = rawContent.replace(/\s+/g, ' ').slice(0, 100);
    if (seenContentHashes.has(contentKey)) continue;

    // Truncate long individual excerpts
    let excerptContent = rawContent;
    if (excerptContent.length > MAX_EXCERPT_CHARS) {
      excerptContent = `${excerptContent.slice(0, MAX_EXCERPT_CHARS)}\n[... content truncated for context budget ...]`;
    }

    const itemTokens = estimateTokens(excerptContent);
    if (totalTokensUsed + itemTokens > MAX_HISTORY_TOKENS && selectedExcerpts.length > 0) {
      hitBudgetLimit = true;
      break;
    }

    seenContentHashes.add(contentKey);
    totalTokensUsed += itemTokens;

    selectedExcerpts.push({
      messageId: item.candidate.message.id,
      conversationId: item.candidate.message.conversation_id,
      role: item.candidate.message.role,
      content: excerptContent,
      createdAt: item.candidate.message.created_at,
      matchReason: item.candidate.reason,
    });
  }

  // 8. Re-sort chronologically for reading coherence
  selectedExcerpts.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  // 9. Determine Confidence, Grounding Status, and Truncation Signals
  const hasMatch = selectedExcerpts.length > 0;
  const totalScoredDayMessages = scoredList.filter((s) => s.candidate.isDateMatch).length;
  const selectedDayExcerptsCount = selectedExcerpts.filter((e) => {
    const t = new Date(e.createdAt).getTime();
    return (
      temporal.startDate &&
      temporal.endDate &&
      t >= temporal.startDate.getTime() &&
      t <= temporal.endDate.getTime()
    );
  }).length;

  const dayTruncated = Boolean(
    temporal.hasDate && hitBudgetLimit && selectedDayExcerptsCount < totalScoredDayMessages
  );
  const totalDayMessages = totalDayCandidates;
  const packedDayMessages = selectedDayExcerptsCount;
  let truncationNote: string | undefined;

  if (dayTruncated) {
    truncationNote = `Historical conversation on ${temporal.resolvedDisplay} contained ${totalDayMessages} messages. Context limits allowed displaying the ${packedDayMessages} most recent turns; earlier exchanges on that date were omitted.`;
  }

  let confidence: 'high' | 'medium' | 'low' | 'none' = 'none';
  let topicMatched = false;
  let missingTopicExplanation: string | undefined;

  if (hasMatch) {
    if (isTopicQuery) {
      if (hasDateWindow) {
        // The date is exact, so evidence inside it is trustworthy. Topic word
        // overlap upgrades that from "the day you asked about" to a matched topic.
        if (hasInWindowTopicHits) {
          confidence = 'high';
          topicMatched = true;
        } else {
          confidence = 'medium';
          topicMatched = false;
        }
      } else {
        const topHit = scoredList[0];
        if (topHit && topHit.temporalScore > 0 && topHit.lexicalScore > 0) {
          confidence = 'high';
          topicMatched = true;
        } else if (topHit && topHit.lexicalScore > 0) {
          confidence = 'medium';
          topicMatched = true;
        } else {
          confidence = 'low';
        }
      }
    } else {
      // Pure recall / topic-less query
      if (dayTruncated) {
        // The day held more messages than fit in context budget
        confidence = 'low';
        topicMatched = false;
      } else {
        // Complete day history fits within context budget
        confidence = 'high';
        topicMatched = true;
      }
    }
  } else {
    confidence = 'none';
    if (isTopicQuery) {
      const topicsStr = substantiveTerms.slice(0, 4).join(', ');
      missingTopicExplanation = `No prior conversation records discussing "${topicsStr}" were found in saved history${
        temporal.hasDate ? ` for ${temporal.resolvedDisplay}` : ''
      }.`;
    }
  }

  let searchSummary = '';
  if (temporal.hasDate) {
    if (hasMatch) {
      searchSummary = `Searched for date: ${temporal.resolvedDisplay}. Found ${selectedExcerpts.length} prior message records (confidence: ${confidence}${dayTruncated ? ', truncated' : ''}).`;
    } else {
      searchSummary = `Searched for date: ${temporal.resolvedDisplay}. No matching records found.`;
    }
  } else if (hasMatch) {
    searchSummary = `Searched by topic keywords: [${substantiveTerms.join(', ')}]. Found ${selectedExcerpts.length} prior message records.`;
  } else {
    searchSummary = 'No matching historical conversation records found in saved database.';
  }

  return {
    temporal,
    excerpts: selectedExcerpts,
    hasMatch,
    searchSummary,
    confidence,
    topicMatched,
    missingTopicExplanation,
    totalTokensUsed,
    dayTruncated,
    totalDayMessages,
    packedDayMessages,
    truncationNote,
  };
}
