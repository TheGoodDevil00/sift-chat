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
      confidence: history.confidence,
      missingTopicExplanation: history.missingTopicExplanation,
    });

    // 3. Verification checks
    const historyOk = history.hasMatch === tc.expectedHistoryHit;
    const intentOk = intent === tc.expectedIntent;
    const searchOk = requiresSearch === tc.expectedSearch;
    const budgetOk = history.totalTokensUsed <= 1200;

    let entitiesOk = true;
    if (tc.expectedHistoricalEntities && tc.expectedHistoricalEntities.length > 0) {
      const allText = history.excerpts.map((e) => e.content).join(' ').toLowerCase();
      entitiesOk = tc.expectedHistoricalEntities.every((e: string) =>
        allText.includes(e.toLowerCase())
      );
    }

    let honestyOk = true;
    if (!tc.expectedHistoryHit && history.temporal.hasDate) {
      const promptText = agentInput.inputItems.map((i) => i.content).join(' ');
      honestyOk = promptText.includes('could not find') || promptText.includes('No historical conversation');
    }

    const testPassed = historyOk && intentOk && searchOk && entitiesOk && budgetOk && honestyOk;
    if (testPassed) passedCount++;

    console.log(`[${testPassed ? 'PASS' : 'FAIL'}] ${tc.id}: ${tc.name}`);
    console.log(`  Prompt: "${tc.prompt}"`);
    console.log(`  Resolved Temporal: ${history.temporal.resolvedDisplay || 'None'}`);
    console.log(`  Intent: ${intent} (expected: ${tc.expectedIntent}) -> ${intentOk ? 'VERIFIED' : 'FAILED'}`);
    console.log(`  Search Policy: ${requiresSearch ? 'REQUIRED' : 'NO SEARCH'} (expected: ${tc.expectedSearch ? 'REQUIRED' : 'NO SEARCH'}) -> ${searchOk ? 'VERIFIED' : 'FAILED'}`);
    console.log(`  History Hits: ${history.excerpts.length} messages (expected hit: ${tc.expectedHistoryHit}) -> ${historyOk ? 'VERIFIED' : 'FAILED'}`);
    console.log(`  Context Budget: ${history.totalTokensUsed} tokens (budget: <=1200) -> ${budgetOk ? 'VERIFIED' : 'OVERFLOW'}`);
    if (tc.expectedHistoricalEntities && tc.expectedHistoricalEntities.length > 0) {
      console.log(`  Entities Verified: [${tc.expectedHistoricalEntities.join(', ')}] -> ${entitiesOk ? 'ALL RECOVERED' : 'INCOMPLETE'}`);
    }
    if (!tc.expectedHistoryHit && history.temporal.hasDate) {
      console.log(`  Honest Fallback Prompt Injection -> ${honestyOk ? 'VERIFIED' : 'MISSING'}`);
    }
    console.log('  Assertions:');
    console.log(`    ${historyOk ? '✓' : '✗'} History match status matches expectation`);
    console.log(`    ${entitiesOk ? '✓' : '✗'} Target historical entity recovery`);
    console.log(`    ${intentOk ? '✓' : '✗'} Deterministic intent classification`);
    console.log(`    ${searchOk ? '✓' : '✗'} Volatility/freshness search requirement`);
    console.log(`    ${budgetOk ? '✓' : '✗'} Token budget bounding (<=1200 tokens)`);
    console.log('');

    db.close();
  }

  // 4. Test Flagship Load Scenario: 25 noise messages on Monday followed by CRM shortlist
  const loadDb = new Database(':memory:');
  loadDb.pragma('foreign_keys = ON');
  runMigrations(loadDb);

  const loadConv = createConversation({ title: 'Monday Heavy Load Chat' }, loadDb);
  for (let i = 1; i <= 25; i++) {
    const minute = i < 10 ? `0${i}` : `${i}`;
    insertMessage(
      {
        conversation_id: loadConv.id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Unrelated chatter #${i}: lunch plans, css layout tweak, weather notes ${i}.`,
        created_at: `2026-11-02T09:${minute}:00.000Z`,
      },
      loadDb
    );
  }
  insertMessage(
    {
      conversation_id: loadConv.id,
      role: 'user',
      content: 'shortlisted 5 CRM tools: HubSpot, Pipedrive, Close, Zoho, Freshsales for a 20-person sales team',
      created_at: '2026-11-02T16:30:00.000Z',
    },
    loadDb
  );
  insertMessage(
    {
      conversation_id: loadConv.id,
      role: 'assistant',
      content: 'Here is the shortlist for the 20-person sales team: HubSpot, Pipedrive, Close, Zoho, Freshsales.',
      created_at: '2026-11-02T16:31:00.000Z',
    },
    loadDb
  );

  const flagshipPrompt = 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?';
  const flagshipRefDate = new Date('2026-11-06T12:00:00.000Z');
  const flagshipHistory = retrieveRelevantHistory(
    flagshipPrompt,
    'UTC',
    null,
    null,
    flagshipRefDate,
    loadDb
  );

  const hasShortlist = flagshipHistory.excerpts.some((e) =>
    e.content.includes('HubSpot, Pipedrive, Close, Zoho, Freshsales')
  );
  const noiseExcerpts = flagshipHistory.excerpts.filter((e) =>
    e.content.includes('lunch plans')
  ).length;
  const flagshipBudgetOk = flagshipHistory.totalTokensUsed <= 1200;
  const flagshipPassed = hasShortlist && noiseExcerpts === 0 && flagshipBudgetOk && flagshipHistory.confidence === 'high';

  if (flagshipPassed) passedCount++;

  console.log(`[${flagshipPassed ? 'PASS' : 'FAIL'}] eval-flagship-load: Realistic Load Under 25 Noise Messages`);
  console.log(`  Prompt: "${flagshipPrompt}"`);
  console.log(`  Shortlist Recovered: ${hasShortlist ? 'YES (SHORTLIST PRESENT: true)' : 'NO (SHORTLIST PRESENT: false)'}`);
  console.log(`  Noise Messages Injected: ${noiseExcerpts} (expected: 0 noise)`);
  console.log(`  Confidence: ${flagshipHistory.confidence} (expected: high)`);
  console.log(`  Context Budget: ${flagshipHistory.totalTokensUsed} tokens (expected: <=1200)`);
  console.log('  Assertions:');
  console.log(`    ${hasShortlist ? '✓' : '✗'} Shortlist present despite 25 prior Monday messages`);
  console.log(`    ${noiseExcerpts === 0 ? '✓' : '✗'} Relevance floor filtered out noise chatter`);
  console.log(`    ${flagshipBudgetOk ? '✓' : '✗'} Token budget strictly bounded`);
  console.log('');

  loadDb.close();

  const totalCases = testCases.length + 1;
  console.log('----------------------------------------------------');
  console.log(`Summary: ${passedCount}/${totalCases} evaluation cases passed.`);
  console.log('====================================================\n');

  if (passedCount < totalCases) {
    process.exit(1);
  }
}

runEvals().catch((err) => {
  console.error('Evaluation run failed:', err);
  process.exit(1);
});
