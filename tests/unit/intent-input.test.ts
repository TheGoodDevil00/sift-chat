import { describe, it, expect } from 'vitest';
import { classifyIntent } from '@/lib/agent/intent';
import { buildAgentInput } from '@/lib/agent/input-builder';
import type { HistoryExcerpt, TemporalResolution } from '@/types/chat';

describe('Intent Classification and Input Builder', () => {
  it('classifies change monitoring queries as requiring search', () => {
    const q1 = 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?';
    const res1 = classifyIntent(q1, true);
    expect(res1.intent).toBe('change_monitoring');
    expect(res1.requiresSearch).toBe(true);

    const q2 = 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since?';
    const res2 = classifyIntent(q2, true);
    expect(res2.intent).toBe('change_monitoring');
    expect(res2.requiresSearch).toBe(true);
  });

  it('classifies freshness check queries as requiring search', () => {
    const q = 'What did I ask you on 3 November? Is your answer still correct today?';
    const res = classifyIntent(q, true);
    expect(res.intent).toBe('freshness_check');
    expect(res.requiresSearch).toBe(true);
  });

  it('classifies recall-only queries without freshness check as no-search', () => {
    const q = 'What did I ask you on 3 November?';
    const res = classifyIntent(q, true);
    expect(res.intent).toBe('conversation_recall');
    expect(res.requiresSearch).toBe(false);
  });

  it('classifies stable fundamental explanations and greetings as general_chat with no-search', () => {
    const greeting = 'Hello Sift';
    expect(classifyIntent(greeting, false).requiresSearch).toBe(false);

    const concept = 'Explain the difference between a primary key and an index.';
    const conceptRes = classifyIntent(concept, false);
    expect(conceptRes.intent).toBe('general_chat');
    expect(conceptRes.requiresSearch).toBe(false);
  });

  it('builds agent input with clear untrusted historical data boundaries and context metadata', () => {
    const excerpts: HistoryExcerpt[] = [
      {
        messageId: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'Shortlist 5 CRMs: Salesforce, HubSpot, Close, Pipedrive, Zoho',
        createdAt: '2026-11-02T10:00:00Z',
        matchReason: 'date',
      },
      {
        messageId: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        content: 'Here are the 5 CRMs with their baseline plans.',
        createdAt: '2026-11-02T10:01:00Z',
        matchReason: 'date',
      },
    ];

    const temporal: TemporalResolution = {
      hasDate: true,
      startDate: new Date('2026-11-02T00:00:00Z'),
      endDate: new Date('2026-11-02T23:59:59Z'),
      rawExpression: 'Monday',
      resolvedDisplay: 'Monday, 2 November 2026',
      confidence: 'exact',
      timezone: 'Asia/Kolkata',
    };

    const input = buildAgentInput({
      userMessage: 'Has any of them changed pricing since?',
      userTimezone: 'Asia/Kolkata',
      referenceDate: new Date('2026-11-10T12:00:00Z'),
      recentMessages: [],
      historicalExcerpts: excerpts,
      temporal,
      requiresSearch: true,
    });

    expect(input.systemPromptAdditions).toContain('Asia/Kolkata');
    expect(input.systemPromptAdditions).toContain('Monday, 2 November 2026');
    expect(input.systemPromptAdditions).toContain('Search Policy: This turn requires verifying');

    const lastMsg = input.inputItems[input.inputItems.length - 1];
    expect(lastMsg.content).toContain('UNTRUSTED QUOTED DATA');
    expect(lastMsg.content).toContain('Shortlist 5 CRMs');
    expect(lastMsg.content).toContain('Has any of them changed pricing since?');
  });

  it('does not inject honest fallback or missing topic note for simple greetings or non-historical queries', () => {
    const temporal: TemporalResolution = {
      hasDate: false,
      startDate: null,
      endDate: null,
      rawExpression: null,
      resolvedDisplay: null,
      confidence: 'none',
      timezone: 'UTC',
    };

    const input = buildAgentInput({
      userMessage: 'Hello Sift!',
      userTimezone: 'UTC',
      referenceDate: new Date('2026-11-10T12:00:00Z'),
      recentMessages: [],
      historicalExcerpts: [],
      temporal,
      requiresSearch: false,
      intent: 'general_chat',
    });

    const userTurn = input.inputItems[input.inputItems.length - 1].content;
    expect(userTurn).not.toContain('No prior conversation records discussing');
    expect(userTurn).not.toContain('No historical conversation was found');
    expect(userTurn).toBe('User prompt: Hello Sift!');
  });
});
