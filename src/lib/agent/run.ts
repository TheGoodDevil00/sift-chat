import { getConfig } from '../config';
import { SIFT_SYSTEM_PROMPT } from './system-prompt';
import type { PreparedAgentMessages } from './input-builder';
import type { NormalizedAgentResponse } from './response-normalizer';
import {
  internalWebSearchTool,
  webSearchToolSchema,
  type SearchEvidence,
} from './tools/web-search';
import { deepScrapeUrl } from './tools/deep-scrape';
import { listProviderModels } from './providers/list-models';
import {
  createProviderAdapter,
  type ProviderAdapter,
  type ProviderMessage,
  type ToolDefinition,
  type ToolCallRecord,
} from './providers';
import {
  normalizeSources,
  extractCitationsFromText,
} from '../citations/normalize';
import { scrubSensitiveStrings } from '../crypto/scrub';
import { validateCustomBaseUrl } from '../security/endpoint';
import { parseVerificationReport, formatVerificationTable } from './verification';
import type { ChatPhase, ClientProviderConfig, SupportedProvider } from '@/types/chat';

export interface AgentRunCallbacks {
  onStatus?: (phase: ChatPhase) => void;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
}

export interface AgentRunResult {
  success: boolean;
  normalized?: NormalizedAgentResponse;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

async function synthesizeFromEvidence(
  adapter: ProviderAdapter,
  messages: ProviderMessage[],
  callbacks: AgentRunCallbacks | undefined,
  signal: AbortSignal | undefined
): Promise<string> {
  messages.push({
    role: 'user',
    content:
      'You have already retrieved the web evidence above. Write the final answer now, using that evidence. Do not call any tools. If the evidence is insufficient, say exactly what could not be verified.',
  });

  let synthesis = '';
  callbacks?.onStatus?.('writing');
  for await (const event of adapter.stream(messages, null, signal)) {
    if (signal?.aborted) throw new Error('AbortError');
    if (event.type === 'delta' && event.text) {
      synthesis += event.text;
      callbacks?.onDelta?.(event.text);
    } else if (event.type === 'thinking' && event.text) {
      callbacks?.onStatus?.('thinking');
    }
  }

  return synthesis.trim();
}

function fallbackFromEvidence(evidence: SearchEvidence[]): string {
  if (evidence.length === 0) {
    return 'Based on the retrieved web sources, I was unable to verify definitive details for your query.';
  }

  const lines = evidence.slice(0, 6).map((item, index) => {
    const title = item.title?.trim() || item.url;
    const snippet = item.snippet?.trim().replace(/\s+/g, ' ').slice(0, 220);
    return `${index + 1}. [${title}](${item.url})${snippet ? ` — ${snippet}` : ''}`;
  });

  return `I found the sources below, but I could not produce a reliable synthesis from them. These are the pages that were retrieved; please check them directly or retry.\n\n${lines.join('\n')}`;
}

function ensureSourceList(finalText: string, evidence: SearchEvidence[]): string {
  if (evidence.length === 0) return finalText;
  // If the model already cited a URL, keep its citations. If it omitted all
  // links, append a deterministic list so an answer built on live evidence is
  // never presented without provenance.
  if (/https?:\/\//i.test(finalText)) return finalText;

  const lines = evidence.slice(0, 6).map((item, index) => {
    const title = (item.title?.trim() || item.url).replace(/[\[\]]/g, '');
    return `${index + 1}. [${title}](${item.url})`;
  });

  return `${finalText}\n\nSources consulted:\n${lines.join('\n')}`;
}

function evidenceToSources(evidence: SearchEvidence[]): Array<{
  url: string;
  title?: string | null;
  source_metadata_json?: string | null;
}> {
  return evidence.map((e) => ({
    url: e.url,
    title: e.title,
    source_metadata_json: JSON.stringify({
      retrievedAt: e.retrievedAt,
      publishedAt: e.publishedAt,
    }),
  }));
}

/**
 * Universal agent runner implementing a single unified tool execution loop
 * across all LLM providers via the ProviderAdapter interface.
 */
export async function runAgent(
  prepared: PreparedAgentMessages,
  assistantMessageId: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal,
  providerConfig?: ClientProviderConfig
): Promise<AgentRunResult> {
  const config = getConfig();
  const provider: SupportedProvider = providerConfig?.provider || 'openai';

  // 1. Validate a client-supplied endpoint before any credential is resolved.
  // A custom base URL must never receive a server-side API key: the caller has to
  // bring its own key. This closes the credential-exfiltration path.
  let safeCustomBaseUrl: string | undefined;
  if (providerConfig?.customBaseUrl) {
    const isLocalProvider = provider === 'ollama' || provider === 'local';
    const endpoint = validateCustomBaseUrl(providerConfig.customBaseUrl, provider, {
      allowLoopback: isLocalProvider || process.env.NODE_ENV !== 'production',
    });
    if (!endpoint.ok) {
      return {
        success: false,
        errorCode: 'INVALID_CUSTOM_BASE_URL',
        errorMessage: endpoint.reason,
        retryable: false,
      };
    }

    if (!isLocalProvider && !providerConfig.apiKey?.trim()) {
      return {
        success: false,
        errorCode: 'CUSTOM_ENDPOINT_REQUIRES_CLIENT_KEY',
        errorMessage:
          'A custom base URL requires your own API key for that endpoint. Server-side keys are never sent to a custom URL.',
        retryable: false,
      };
    }

    safeCustomBaseUrl = endpoint.url;
  }

  // 2. Resolve API key
  let apiKey = providerConfig?.apiKey?.trim();
  if (!apiKey) {
    if (provider === 'openai') apiKey = config.openaiApiKey;
    else if (provider === 'anthropic') apiKey = config.anthropicApiKey;
    else if (provider === 'gemini') apiKey = config.geminiApiKey;
    else if (provider === 'deepseek') apiKey = config.deepseekApiKey;
    else if (provider === 'xai') apiKey = config.xaiApiKey;
    else if (provider === 'cohere') apiKey = config.cohereApiKey;
    else if (provider === 'openrouter') apiKey = config.openrouterApiKey;
    else if (provider === 'groq') apiKey = config.groqApiKey;
    else if (provider === 'ollama') apiKey = 'ollama';
    else if (provider === 'local') apiKey = 'local';
  }

  if (!apiKey && (provider === 'ollama' || provider === 'local')) {
    apiKey = provider;
  }

  if (!apiKey) {
    return {
      success: false,
      errorCode: 'MISSING_API_KEY',
      errorMessage: `No API key provided for ${provider.toUpperCase()}. Please configure it in provider settings or set it in your .env file.`,
      retryable: false,
    };
  }

  // 3. Resolve Model
  let model = providerConfig?.model?.trim();
  if (!model) {
    if (provider === 'openai') model = config.openaiModel;
    else if (provider === 'anthropic') model = config.anthropicModel;
    else if (provider === 'gemini') model = config.geminiModel;
    else if (provider === 'deepseek') model = config.deepseekModel;
    else if (provider === 'xai') model = config.xaiModel;
    else if (provider === 'cohere') model = config.cohereModel;
    else if (provider === 'openrouter') model = config.openrouterModel || 'anthropic/claude-3.5-sonnet';
    else if (provider === 'groq') model = config.groqModel;
    else if (provider === 'ollama') model = 'llama3.2';
    else if (provider === 'local') model = 'local-model';
  }

  if (!model) {
    try {
      const liveData = await listProviderModels(provider, apiKey, safeCustomBaseUrl);
      if (liveData.models && liveData.models.length > 0) {
        model = liveData.models[0].id;
      }
    } catch (listErr: any) {
      console.warn(`Could not auto-fetch models for ${provider}:`, listErr.message);
    }
  }

  if (!model) {
    return {
      success: false,
      errorCode: 'MISSING_MODEL',
      errorMessage: `No model specified for ${provider}. Please select an active model from provider settings.`,
      retryable: false,
    };
  }

  const fullInstructions = `${SIFT_SYSTEM_PROMPT}\n\n${prepared.systemPromptAdditions}`;
  const providerLabel = provider.toUpperCase();

  try {
    const adapter = createProviderAdapter(provider, apiKey, model, safeCustomBaseUrl);
    return await executeUnifiedToolLoop(
      adapter,
      fullInstructions,
      prepared,
      model,
      assistantMessageId,
      providerLabel,
      callbacks,
      signal,
      providerConfig
    );
  } catch (err: any) {
    return handleProviderError(err, providerLabel, signal);
  }
}

// ---------------------------------------------------------------------------
// Single Unified Tool Execution Loop
// ---------------------------------------------------------------------------
async function executeUnifiedToolLoop(
  adapter: ProviderAdapter,
  fullInstructions: string,
  prepared: PreparedAgentMessages,
  model: string,
  assistantMessageId: string,
  providerLabel: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal,
  providerConfig?: ClientProviderConfig
): Promise<AgentRunResult> {
  const messages: ProviderMessage[] = [
    { role: 'system', content: fullInstructions },
    ...prepared.inputItems.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const tools: ToolDefinition[] = [webSearchToolSchema];
  const searchRequired = prepared.requiresSearch === true;
  const allEvidence: SearchEvidence[] = [];
  let searchCallCount = 0;
  let forcedSearchRetry = false;
  let iterations = 0;
  const maxIterations = 5;
  let finalResponseId: string | undefined;
  let finalFinishReason: string | undefined;

  while (iterations++ < maxIterations) {
    if (signal?.aborted) throw new Error('AbortError');

    let turnText = '';
    const pendingToolCalls: ToolCallRecord[] = [];

    for await (const event of adapter.stream(messages, tools, signal)) {
      if (signal?.aborted) throw new Error('AbortError');

      if (event.type === 'delta' && event.text) {
        turnText += event.text;
        // When search is mandatory and none has happened yet, buffer the turn.
        // This prevents an unverified answer from being streamed before we can enforce the tool call.
        if (!searchRequired || searchCallCount > 0) {
          callbacks?.onStatus?.('writing');
          callbacks?.onDelta?.(event.text);
        }
      } else if (event.type === 'thinking' && event.text) {
        // Reasoning tokens are not part of the product surface. Show a phase
        // hint, but never stream or retain hidden chain-of-thought.
        callbacks?.onStatus?.('thinking');
      } else if (event.type === 'tool_call' && event.toolCall) {
        pendingToolCalls.push(event.toolCall);
      } else if (event.type === 'done') {
        if (event.finishReason) finalFinishReason = event.finishReason;
        if (event.responseId) finalResponseId = event.responseId;
      }
    }

    // If no tool was called, we have our final response
    if (pendingToolCalls.length === 0) {
      // Enforcement: a volatile question may not be answered from model memory alone.
      if (searchRequired && searchCallCount === 0) {
        if (!forcedSearchRetry) {
          forcedSearchRetry = true;
          messages.push({ role: 'assistant', content: turnText });
          messages.push({
            role: 'user',
            content:
              'STOP. You answered without calling web_search. This question is about current, volatile, or previously discussed facts and MUST be verified against live web evidence. Call web_search now with a concrete query. Do not answer from memory.',
          });
          continue;
        }

        const unavailableText =
          'I could not complete a live web verification for this question, so I do not want to guess. Please retry, or check the official sources directly.';
        callbacks?.onDelta?.(unavailableText);
        return {
          success: true,
          normalized: {
            text: unavailableText,
            citations: [],
            sources: [],
            model,
            responseId: finalResponseId || `${providerLabel.toLowerCase()}_${Date.now()}`,
            finishReason: 'search_not_completed',
          },
        };
      }

      let finalText = turnText.trim();

      // Check if output is a JSON structured verification report
      const structuredReport = parseVerificationReport(finalText);
      if (structuredReport) {
        finalText = formatVerificationTable(structuredReport);
      }

      if (!finalText) {
        // Some tool-capable models return an empty final turn after retrieving
        // evidence. Give them one explicit, tool-free synthesis chance before
        // falling back to a deterministic source list.
        if (allEvidence.length > 0) {
          if (turnText) messages.push({ role: 'assistant', content: turnText });
          finalText = await synthesizeFromEvidence(adapter, messages, callbacks, signal);
        }
        if (!finalText) {
          finalText = fallbackFromEvidence(allEvidence);
          callbacks?.onDelta?.(finalText);
        }
      }

      finalText = ensureSourceList(finalText, allEvidence);

      // A completed search that produced no evidence must not masquerade as a verified answer.
      if (searchRequired && allEvidence.length === 0) {
        const caveat = '\n\n_No live sources were returned for this search, so I could not verify current details. This is not proof that nothing changed._';
        if (!finalText.includes(caveat.trim())) {
          finalText += caveat;
          callbacks?.onDelta?.(caveat);
        }
      }

      const textCitations = extractCitationsFromText(finalText, assistantMessageId, allEvidence);
      const normalizedSources = normalizeSources(evidenceToSources(allEvidence), assistantMessageId);

      return {
        success: true,
        normalized: {
          text: finalText,
          citations: textCitations,
          sources: normalizedSources,
          model,
          responseId: finalResponseId || `${providerLabel.toLowerCase()}_${Date.now()}`,
          finishReason: finalFinishReason || 'completed',
        },
      };
    }

    // Execute tool calls
    messages.push({
      role: 'assistant',
      content: turnText,
      tool_calls: pendingToolCalls,
    });

    callbacks?.onStatus?.('searching_web');

    // Execute multiple tool calls in parallel to eliminate sequential network latency bottlenecks
    const toolExecutions = await Promise.all(
      pendingToolCalls.map(async (tc) => {
        if (tc.name === 'web_search') {
          let args: any = {};
          try {
            args = JSON.parse(tc.arguments || '{}');
          } catch {
            args = {};
          }

          const query = (args.query || '').trim();
          if (!query) {
            return {
              tc,
              evidence: [],
              boundedEvidence: { error: 'web_search requires a non-empty query.', query },
              isError: false,
              attemptedSearch: false,
            };
          }

          searchCallCount += 1;
          const evidence = await internalWebSearchTool.execute({
            query,
            recency: args.recency,
            maxResults: args.maxResults || 5,
            searchKeys: providerConfig?.searchKeys,
          });

          // Stage 2: Deep Content Extraction for Critical Pages
          // Fires when top result has no extracted content or only a brief search snippet (< 300 chars)
          if (evidence.length > 0 && (!evidence[0].extractedContent || evidence[0].extractedContent.length < 300)) {
            try {
              const deepContent = await deepScrapeUrl(
                evidence[0].url,
                4000,
                providerConfig?.searchKeys?.firecrawl
              );
              if (deepContent) {
                evidence[0].extractedContent = deepContent;
              }
            } catch (scrapeErr) {
              console.warn('Deep scrape fallback failed:', scrapeErr);
            }
          }

          return {
            tc,
            evidence,
            boundedEvidence:
              evidence.length > 0
                ? {
                    query,
                    resultCount: evidence.length,
                    results: evidence.map((e) => ({
                      title: e.title,
                      url: e.url,
                      snippet: e.snippet?.slice(0, 400),
                      publishedAt: e.publishedAt,
                      extractedContent: e.extractedContent?.slice(0, 2500),
                    })),
                  }
                : {
                    query,
                    resultCount: 0,
                    error:
                      'No search results were returned. Do not treat this as evidence that nothing changed. Try a different query or state the limitation.',
                  },
            isError: false,
            attemptedSearch: true,
          };
        } else {
          return {
            tc,
            evidence: [],
            boundedEvidence: null,
            isError: true,
            attemptedSearch: false,
          };
        }
      })
    );

    for (const res of toolExecutions) {
      if (res.isError) {
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: `Tool ${res.tc.name} not found.` }),
          tool_call_id: res.tc.id,
        });
      } else {
        for (const item of res.evidence) {
          allEvidence.push(item);
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify(res.boundedEvidence),
          tool_call_id: res.tc.id,
        });
      }
    }
  }

  // Never synthesize a volatile answer without any live evidence.
  if (searchRequired && searchCallCount === 0) {
    const unavailableText =
      'I could not complete a live web verification for this question, so I do not want to guess. Please retry, or check the official sources directly.';
    callbacks?.onDelta?.(unavailableText);
    return {
      success: true,
      normalized: {
        text: unavailableText,
        citations: [],
        sources: [],
        model,
        responseId: finalResponseId || `${providerLabel.toLowerCase()}_${Date.now()}`,
        finishReason: 'search_not_completed',
      },
    };
  }

  // Max iterations reached with tool calls -> force final synthesis turn without tools
  let finalText = await synthesizeFromEvidence(adapter, messages, callbacks, signal);
  const structuredReport = parseVerificationReport(finalText);
  if (structuredReport) {
    finalText = formatVerificationTable(structuredReport);
  }

  if (!finalText) {
    finalText = fallbackFromEvidence(allEvidence);
    callbacks?.onDelta?.(finalText);
  }

  finalText = ensureSourceList(finalText, allEvidence);

  if (searchRequired && allEvidence.length === 0) {
    const caveat = '\n\n_No live sources were returned for this search, so I could not verify current details. This is not proof that nothing changed._';
    if (!finalText.includes(caveat.trim())) {
      finalText += caveat;
      callbacks?.onDelta?.(caveat);
    }
  }

  const textCitations = extractCitationsFromText(finalText, assistantMessageId, allEvidence);
  const normalizedSources = normalizeSources(evidenceToSources(allEvidence), assistantMessageId);

  return {
    success: true,
    normalized: {
      text: finalText,
      citations: textCitations,
      sources: normalizedSources,
      model,
      responseId: finalResponseId || `${providerLabel.toLowerCase()}_${Date.now()}`,
      finishReason: 'completed',
    },
  };
}

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------
function handleProviderError(err: any, providerLabel: string, signal?: AbortSignal): AgentRunResult {
  if (err?.name === 'AbortError' || signal?.aborted) {
    return {
      success: false,
      errorCode: 'REQUEST_TIMEOUT',
      errorMessage: `The research request to ${providerLabel} timed out. Please try again.`,
      retryable: true,
    };
  }

  const status = err?.status || err?.statusCode;
  const rawMsg = err?.message || err?.error?.message || `An error occurred while contacting ${providerLabel}.`;
  const msg = scrubSensitiveStrings(rawMsg);

  if (
    status === 401 ||
    status === 403 ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('User not found')
  ) {
    return {
      success: false,
      errorCode: 'AUTHENTICATION_FAILED',
      errorMessage: `${providerLabel} authentication failed (${status || 401}): ${msg}. Please check your ${providerLabel} key in Provider Settings.`,
      retryable: false,
    };
  }

  if (status === 402 || msg.includes('credits') || msg.includes('payment') || msg.includes('quota')) {
    return {
      success: false,
      errorCode: 'PAYMENT_REQUIRED',
      errorMessage: `${providerLabel} payment error (402): ${msg}. Your account has insufficient credits. Please add credits or select a free model.`,
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      success: false,
      errorCode: 'RATE_LIMITED',
      errorMessage: `${providerLabel} rate limit exceeded: ${msg}. Please wait a moment and retry.`,
      retryable: true,
    };
  }

  if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('Connect Timeout')) {
    if (providerLabel === 'OLLAMA' || providerLabel === 'LOCAL') {
      return {
        success: false,
        errorCode: 'LOCAL_SERVER_UNREACHABLE',
        errorMessage: `Could not connect to ${providerLabel} server (${msg}). Ensure your local server is running (e.g. 'ollama serve' or LM Studio local server).`,
        retryable: true,
      };
    }
  }

  return {
    success: false,
    errorCode: 'MODEL_REQUEST_FAILED',
    errorMessage: `${providerLabel} request failed: ${msg}`,
    retryable: true,
  };
}
