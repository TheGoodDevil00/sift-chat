import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/migrations';
import { createConversation } from '@/lib/db/repositories/conversations';
import { insertMessage } from '@/lib/db/repositories/messages';
import { retrieveRelevantHistory } from '@/lib/history/retrieve';
import { classifyIntent } from '@/lib/agent/intent';
import { buildAgentInput } from '@/lib/agent/input-builder';
import fs from 'fs';
import path from 'path';

interface EvalCase {
  id: string;
  name: string;
  timezone: string;
  referenceDate: string;
  historySeed: Array<{
    conversationTitle: string;
    role: 'user' | 'assistant';
    createdAt: string;
    content: string;
  }>;
  prompt: string;
  expectedIntent: string;
  expectedSearch: boolean;
  expectedHistoryHit: boolean;
  expectedHistoricalEntities: string[];
}

describe('Evaluation Cases Pipeline Verification', () => {
  let db: Database.Database;
  const cases: EvalCase[] = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'evals/cases.json'), 'utf8')
  );

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  for (const tc of cases) {
    it(`evaluates ${tc.id}: ${tc.name}`, () => {
      // 1. Seed history if present
      const convMap = new Map<string, string>();
      for (const seed of tc.historySeed) {
        if (!convMap.has(seed.conversationTitle)) {
          const conv = createConversation(
            { title: seed.conversationTitle, timezone: tc.timezone },
            db
          );
          convMap.set(seed.conversationTitle, conv.id);
        }
        const conversationId = convMap.get(seed.conversationTitle)!;
        insertMessage(
          {
            conversation_id: conversationId,
            role: seed.role,
            content: seed.content,
            created_at: seed.createdAt,
          },
          db
        );
      }

      // 2. Run retrieval
      const refDate = new Date(tc.referenceDate);
      const history = retrieveRelevantHistory(
        tc.prompt,
        tc.timezone,
        null,
        null,
        refDate,
        db
      );

      expect(history.hasMatch).toBe(tc.expectedHistoryHit);

      // Verify entities if expected
      if (tc.expectedHistoricalEntities.length > 0) {
        const aggregatedHistory = history.excerpts.map((e) => e.content).join(' ');
        for (const entity of tc.expectedHistoricalEntities) {
          expect(aggregatedHistory.toLowerCase()).toContain(entity.toLowerCase());
        }
      }

      // 3. Classify intent & search policy
      const { intent, requiresSearch } = classifyIntent(
        tc.prompt,
        history.temporal.hasDate
      );
      expect(intent).toBe(tc.expectedIntent);
      expect(requiresSearch).toBe(tc.expectedSearch);

      // 4. Verify agent input construction
      const agentInput = buildAgentInput({
        userMessage: tc.prompt,
        userTimezone: tc.timezone,
        referenceDate: refDate,
        recentMessages: [],
        historicalExcerpts: history.excerpts,
        temporal: history.temporal,
        requiresSearch,
      });

      if (tc.expectedSearch) {
        expect(agentInput.systemPromptAdditions).toContain('Search Policy: This turn requires verifying');
      }
      if (!tc.expectedHistoryHit && history.temporal.hasDate) {
        expect(agentInput.inputItems[0].content).toContain(
          'honestly inform the user that you could not find that prior discussion'
        );
      }
    });
  }
});
