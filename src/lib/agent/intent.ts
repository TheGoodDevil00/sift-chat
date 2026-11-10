import type { UserIntent } from '@/types/chat';

export function classifyIntent(
  message: string,
  hasHistoricalTemporalDate: boolean
): { intent: UserIntent; requiresSearch: boolean } {
  const lower = message.toLowerCase();

  // Freshness check: asking if a prior answer or recommendation is still true/correct today
  const isFreshnessCheck =
    /(still|remains?)\s+(correct|accurate|true|valid|current|the case|relevant|recommended)/i.test(lower) ||
    /is (your|that|the) answer still/i.test(lower) ||
    /still current/i.test(lower) ||
    /has anything changed since/i.test(lower);

  // Change monitoring: checking if prices, features, releases changed since a past point
  const isChangeMonitoring =
    /\b(changed?|shipping|shipped|updates?|releases?|new features?|pricing changes?)\s+(since|after)\b/i.test(lower) ||
    /\bhas\s+(any|anyone|either|any of them|pricing|anything)\s+changed\b/i.test(lower) ||
    /\b(any|what)\s+(changes|updates|new releases)\s+(since|after)\b/i.test(lower);

  // Conversation recall only: asking what was asked, said, decided, shortlisted in the past without asking for current check
  const isRecallOnly =
    hasHistoricalTemporalDate &&
    (/\bwhat\s+did\s+(i|we)\s+(ask|discuss|shortlist|decide|talk about)\b/i.test(lower) ||
     /\bwhat\s+was\s+(the|our|my)\s+(shortlist|question|discussion|decision)\b/i.test(lower) ||
     /\brecall\b/i.test(lower) ||
     /\bwhat did you (say|tell me|recommend)\b/i.test(lower)) &&
    !isFreshnessCheck &&
    !isChangeMonitoring;

  // Current research: questions asking for current status, prices, releases, today
  const isCurrentResearch =
    /\b(today|currently|current|latest|recent|now|pricing|plans?|costs?|how much is|release status|shipped)\b/i.test(lower) ||
    /\b(what are the best|compare|top|pricing for)\b/i.test(lower);

  // Greetings & basic chit-chat
  const isGreeting =
    /^(hi|hello|hey|good\s+(morning|afternoon|evening)|greetings|howdy|sup)\b[!.?]*$/i.test(lower.trim());

  // Stable conceptual questions
  const isStableConcept =
    /^(explain|how does|what is the difference between|why do we use|what is|how do i write|write a)\b/i.test(lower) &&
    !/\b(today|current|latest|price|pricing|cost|2025|2026|new|recent)\b/i.test(lower);

  if (isFreshnessCheck) {
    return { intent: 'freshness_check', requiresSearch: true };
  }

  if (isChangeMonitoring) {
    return { intent: 'change_monitoring', requiresSearch: true };
  }

  if (isRecallOnly) {
    return { intent: 'conversation_recall', requiresSearch: false };
  }

  if (isGreeting || isStableConcept) {
    return { intent: 'general_chat', requiresSearch: false };
  }

  if (isCurrentResearch) {
    return { intent: 'current_research', requiresSearch: true };
  }

  // Default follow-up: if user mentions pricing/limits/plans/freshness, search; otherwise false
  const mentionsVolatileInfo = /\b(price|pricing|tier|cost|plan|limit|feature|release|update|version)\b/i.test(lower);
  return {
    intent: 'follow_up',
    requiresSearch: mentionsVolatileInfo,
  };
}
