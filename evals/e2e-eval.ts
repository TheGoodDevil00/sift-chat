import { runAgent } from '../src/lib/agent/run';
import { buildAgentInput } from '../src/lib/agent/input-builder';
import { classifyIntent } from '../src/lib/agent/intent';
import { createProviderAdapter, type ProviderAdapter } from '../src/lib/agent/providers';
import { getConfig } from '../src/lib/config';

export interface E2EEvalCase {
  name: string;
  prompt: string;
  historicalContext?: string;
  userTimezone?: string;
  mustContain: string[];
  mustNotContain: string[];
  mustCiteSources: boolean;
  minConfidenceScore?: number;
}

export const E2E_CASES: E2EEvalCase[] = [
  {
    name: 'HubSpot pricing check',
    prompt: 'What is HubSpot Sales Hub Starter pricing right now?',
    mustContain: ['hubspot', '/month', '$'],
    mustNotContain: [],
    mustCiteSources: true,
    minConfidenceScore: 4,
  },
  {
    name: 'Supabase vs Neon Postgres comparison',
    prompt: 'Compare Supabase Pro and Neon compute pricing.',
    mustContain: ['supabase', 'neon', '$'],
    mustNotContain: [],
    mustCiteSources: true,
    minConfidenceScore: 4,
  },
  {
    name: 'Database Index vs Primary Key (Conceptual, No Unnecessary Search)',
    prompt: 'Explain the difference between a primary key and an index.',
    mustContain: ['primary key', 'index', 'unique'],
    mustNotContain: ['hubspot', 'pricing changelog'],
    mustCiteSources: false,
    minConfidenceScore: 4,
  },
  {
    name: 'Missing memory honesty acknowledgment',
    prompt: 'On Monday we shortlisted 5 warehouse management tools. Has any of them changed pricing since?',
    historicalContext: '',
    mustContain: ["couldn't find", 'saved conversations'],
    mustNotContain: ['LogiPro 5000', 'OmniWarehouse Enterprise'],
    mustCiteSources: false,
    minConfidenceScore: 5,
  },
];

export async function judgeResponse(
  question: string,
  agentAnswer: string,
  adapter: ProviderAdapter
): Promise<{ scores: { accuracy: number; completeness: number; citations: number; honesty: number }; reasoning: string }> {
  const judgePrompt = `You are evaluating a research agent's answer.

Question: ${question}

Agent's Answer:
${agentAnswer}

Score the answer from 1-5 on each criterion:
1. Factual accuracy (are claims supported by cited sources?)
2. Completeness (did it address every part of the question?)
3. Citation quality (are sources present, clickable, and relevant?)
4. Honesty about uncertainty (does it flag unverifiable claims?)

Return JSON: { "scores": { "accuracy": N, "completeness": N, "citations": N, "honesty": N }, "reasoning": "..." }`;

  let text = '';
  for await (const event of adapter.stream(
    [{ role: 'user', content: judgePrompt }],
    null
  )) {
    if (event.type === 'delta' && event.text) text += event.text;
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const candidates = [
    fenced?.[1]?.trim(),
    firstBrace !== -1 && lastBrace > firstBrace
      ? trimmed.slice(firstBrace, lastBrace + 1)
      : undefined,
    trimmed,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const scores = parsed?.scores;
      if (
        scores &&
        ['accuracy', 'completeness', 'citations', 'honesty'].every(
          (k) => typeof scores[k] === 'number' && scores[k] >= 1 && scores[k] <= 5
        )
      ) {
        return {
          scores: {
            accuracy: scores.accuracy,
            completeness: scores.completeness,
            citations: scores.citations,
            honesty: scores.honesty,
          },
          reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
        };
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Judge did not return a valid score JSON object.');
}

export async function runE2EEvals() {
  const config = getConfig();
  if (!config.openaiApiKey) {
    console.log('Skipping live E2E evals: OPENAI_API_KEY is not set.');
    console.log('The deterministic suite (npm run eval) does not need a model key.');
    return;
  }

  const providerConfig = {
    provider: 'openai' as const,
    model: config.openaiModel || 'gpt-4o',
    apiKey: config.openaiApiKey,
  };

  console.log('====================================================');
  console.log('       SIFT END-TO-END AGENT OUTPUT EVALS           ');
  console.log('====================================================\n');

  let passedCases = 0;
  const judgeAdapter = createProviderAdapter(
    providerConfig.provider,
    providerConfig.apiKey,
    providerConfig.model
  );

  for (const tc of E2E_CASES) {
    const timezone = tc.userTimezone || 'UTC';
    const referenceDate = new Date();

    const prepared = buildAgentInput({
      userMessage: tc.prompt,
      userTimezone: timezone,
      referenceDate,
      recentMessages: [],
      historicalExcerpts: tc.historicalContext
        ? [
            {
              messageId: 'seed-1',
              conversationId: 'conv-eval-1',
              role: 'assistant',
              content: tc.historicalContext,
              createdAt: new Date(Date.now() - 86400000).toISOString(),
              matchReason: 'entity',
            },
          ]
        : [],
      temporal: {
        hasDate: false,
        startDate: null,
        endDate: null,
        rawExpression: null,
        resolvedDisplay: null,
        confidence: 'none',
        timezone,
      },
      requiresSearch: classifyIntent(tc.prompt, Boolean(tc.historicalContext)).requiresSearch,
    });

    console.log(`Running: [${tc.name}] ...`);
    let result;
    try {
      result = await runAgent(
        prepared,
        `eval-msg-${Date.now()}`,
        undefined,
        undefined,
        providerConfig
      );
    } catch (runErr: any) {
      console.error(`  FAIL [${tc.name}]: Agent execution threw: ${runErr.message}`);
      continue;
    }

    if (!result.success || !result.normalized) {
      console.error(`  FAIL [${tc.name}]: Agent returned error code: ${result.errorCode || 'UNKNOWN'} (${result.errorMessage})`);
      continue;
    }

    const text = result.normalized.text.toLowerCase();
    let hasFailures = false;

    // Check mustContain
    for (const required of tc.mustContain) {
      if (!text.includes(required.toLowerCase())) {
        console.error(`  FAIL [${tc.name}]: Missing required phrase: "${required}"`);
        hasFailures = true;
      }
    }

    // Check mustNotContain
    for (const forbidden of tc.mustNotContain) {
      if (text.includes(forbidden.toLowerCase())) {
        console.error(`  FAIL [${tc.name}]: Contains forbidden/hallucinated phrase: "${forbidden}"`);
        hasFailures = true;
      }
    }

    // Check mustCiteSources
    if (tc.mustCiteSources) {
      const hasCitations =
        /\[.*?\]\(https?:\/\/.*?\)/.test(result.normalized.text) ||
        (result.normalized.citations && result.normalized.citations.length > 0) ||
        (result.normalized.sources && result.normalized.sources.length > 0);
      if (!hasCitations) {
        console.error(`  FAIL [${tc.name}]: Expected citations but none were present in the output`);
        hasFailures = true;
      }
    }

    if (!hasFailures) {
      try {
        const judged = await judgeResponse(tc.prompt, result.normalized.text, judgeAdapter);
        const minimum = tc.minConfidenceScore ?? 4;
        for (const [criterion, score] of Object.entries(judged.scores)) {
          if (score < minimum) {
            console.error(
              `  FAIL [${tc.name}]: Judge scored ${criterion} ${score}/5 (minimum ${minimum})`
            );
            hasFailures = true;
          }
        }
        console.log(`    Judge: ${JSON.stringify(judged.scores)} — ${judged.reasoning}`);
      } catch (judgeErr: any) {
        console.error(`  FAIL [${tc.name}]: Judge failed: ${judgeErr.message}`);
        hasFailures = true;
      }
    }

    if (!hasFailures) {
      passedCases++;
      console.log(`  PASS [${tc.name}]`);
      console.log(`    Answer snippet: "${result.normalized.text.slice(0, 140)}..."`);
      console.log(`    Citations: ${result.normalized.citations.length} | Sources: ${result.normalized.sources.length}\n`);
    } else {
      console.log('');
    }
  }

  console.log('----------------------------------------------------');
  console.log(`Summary: ${passedCases}/${E2E_CASES.length} E2E cases passed.`);
  console.log('====================================================\n');

  if (passedCases < E2E_CASES.length) {
    process.exitCode = 1;
  }
}

// Allow direct CLI invocation
if (process.argv[1]?.endsWith('e2e-eval.ts')) {
  runE2EEvals().catch((err) => {
    console.error('E2E eval run failed:', err);
    process.exit(1);
  });
}
