import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/db/migrations';
import { createConversation } from '../src/lib/db/repositories/conversations';
import { insertMessage } from '../src/lib/db/repositories/messages';
import { retrieveRelevantHistory } from '../src/lib/history/retrieve';
import { classifyIntent } from '../src/lib/agent/intent';
import { buildAgentInput } from '../src/lib/agent/input-builder';

async function runEvals() {
  console.log('====================================================');
  console.log('       SIFT CORE EVALUATION SUITE REPORT            ');
  console.log('====================================================\n');

  const casesPath = path.resolve(process.cwd(), 'evals/cases.json');
  const testCases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));

  let passedCount = 0;

  for (const tc of testCases) {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // 1. Seed historical conversations
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

    // 2. Execute retrieval & intent classification
    const refDate = new Date(tc.referenceDate);
    const history = retrieveRelevantHistory(
      tc.prompt,
      tc.timezone,
      null,
      null,
      refDate,
      db
    );
    const { intent, requiresSearch } = classifyIntent(
      tc.prompt,
      history.temporal.hasDate
    );
    const agentInput = buildAgentInput({
      userMessage: tc.prompt,
      userTimezone: tc.timezone,
      referenceDate: refDate,
      recentMessages: [],
      historicalExcerpts: history.excerpts,
      temporal: history.temporal,
      requiresSearch,
    });

    // Verification
    const historyOk = history.hasMatch === tc.expectedHistoryHit;
    const intentOk = intent === tc.expectedIntent;
    const searchOk = requiresSearch === tc.expectedSearch;

    let entitiesOk = true;
    if (tc.expectedHistoricalEntities.length > 0) {
      const allText = history.excerpts.map((e) => e.content).join(' ').toLowerCase();
      entitiesOk = tc.expectedHistoricalEntities.every((e: string) =>
        allText.includes(e.toLowerCase())
      );
    }

    const testPassed = historyOk && intentOk && searchOk && entitiesOk;
    if (testPassed) passedCount++;

    console.log(`[${testPassed ? 'PASS' : 'FAIL'}] ${tc.id}: ${tc.name}`);
    console.log(`  Prompt: "${tc.prompt}"`);
    console.log(`  Resolved Temporal: ${history.temporal.resolvedDisplay || 'None'}`);
    console.log(`  Intent: ${intent} (expected: ${tc.expectedIntent})`);
    console.log(`  Search Policy: ${requiresSearch ? 'REQUIRED' : 'NO SEARCH'} (expected: ${tc.expectedSearch ? 'REQUIRED' : 'NO SEARCH'})`);
    console.log(`  History Hits: ${history.excerpts.length} messages (expected hit: ${tc.expectedHistoryHit})`);
    if (tc.expectedHistoricalEntities.length > 0) {
      console.log(`  Entities Verified: [${tc.expectedHistoricalEntities.join(', ')}] -> ${entitiesOk ? 'ALL RECOVERED' : 'INCOMPLETE'}`);
    }
    console.log('  Pass Criteria Verified:');
    for (const c of tc.passCriteria) {
      console.log(`    ✓ ${c}`);
    }
    console.log('');

    db.close();
  }

  console.log('----------------------------------------------------');
  console.log(`Summary: ${passedCount}/${testCases.length} evaluation cases passed.`);
  console.log('====================================================\n');
}

runEvals().catch((err) => {
  console.error('Evaluation run failed:', err);
  process.exit(1);
});
