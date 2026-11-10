import { OpenAI } from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { CohereClientV2 } from 'cohere-ai';
import { getConfig } from '../config';
import { SIFT_SYSTEM_PROMPT } from './system-prompt';
import type { PreparedAgentMessages } from './input-builder';
import type { NormalizedAgentResponse } from './response-normalizer';
import {
  internalWebSearchTool,
  webSearchToolSchema,
  type SearchEvidence,
} from './tools/web-search';
import { listProviderModels } from './providers/list-models';
import {
  normalizeSources,
  extractCitationsFromText,
  normalizeCitations,
} from '../citations/normalize';
import { scrubSensitiveStrings } from '../crypto/scrub';
import type { ChatPhase, ClientProviderConfig, SupportedProvider } from '@/types/chat';

export interface AgentRunCallbacks {
  onStatus?: (phase: ChatPhase) => void;
  onDelta?: (text: string) => void;
}

export interface AgentRunResult {
  success: boolean;
  normalized?: NormalizedAgentResponse;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * Universal agent runner implementing the single-tool execution loop:
 *
 * Receive message -> Construct context -> Invoke LLM -> Tool call?
 *   - Yes: Validate web_search args -> Execute search pipeline -> Persist evidence -> Return tool result to LLM -> Invoke LLM
 *   - No: Validate citations and answer -> Persist assistant response -> Stream final response
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

  // 1. Resolve API key: client-supplied key takes priority (in-memory only), then server env
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
  }

  if (!apiKey) {
    return {
      success: false,
      errorCode: 'MISSING_API_KEY',
      errorMessage: `No API key provided for ${provider.toUpperCase()}. Please configure it in the provider settings dropdown or set it in your .env file.`,
      retryable: false,
    };
  }

  // 2. Resolve Model
  let model = providerConfig?.model?.trim();
  if (!model) {
    if (provider === 'openai') model = config.openaiModel;
    else if (provider === 'anthropic') model = config.anthropicModel;
    else if (provider === 'gemini') model = config.geminiModel;
    else if (provider === 'deepseek') model = config.deepseekModel;
    else if (provider === 'xai') model = config.xaiModel;
    else if (provider === 'cohere') model = config.cohereModel;
    else if (provider === 'openrouter') model = config.openrouterModel;
    else if (provider === 'groq') model = config.groqModel;
  }

  // If still no model specified, dynamically query the provider's /models endpoint to get actual available model
  if (!model) {
    try {
      const liveData = await listProviderModels(provider, apiKey, providerConfig?.customBaseUrl);
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

  // Route to the tool execution loop based on provider
  if (provider === 'anthropic') {
    return runAnthropicToolLoop(apiKey, model!, fullInstructions, prepared, assistantMessageId, callbacks, signal);
  } else if (provider === 'gemini') {
    return runGeminiToolLoop(apiKey, model!, fullInstructions, prepared, assistantMessageId, callbacks, signal);
  } else if (provider === 'cohere') {
    return runCohereToolLoop(apiKey, model!, fullInstructions, prepared, assistantMessageId, callbacks, signal);
  } else {
    // OpenAI, DeepSeek, xAI, Groq, OpenRouter use the standard tool calling loop
    let baseUrl = providerConfig?.customBaseUrl;
    let label = 'OpenAI';
    if (provider === 'deepseek') {
      baseUrl = baseUrl || 'https://api.deepseek.com';
      label = 'DeepSeek';
    } else if (provider === 'xai') {
      baseUrl = baseUrl || 'https://api.x.ai/v1';
      label = 'xAI Grok';
    } else if (provider === 'groq') {
      baseUrl = baseUrl || 'https://api.groq.com/openai/v1';
      label = 'Groq';
    } else if (provider === 'openrouter') {
      baseUrl = baseUrl || 'https://openrouter.ai/api/v1';
      label = 'OpenRouter';
    }

    return runOpenAIToolLoop(apiKey, baseUrl, model!, fullInstructions, prepared, assistantMessageId, label, callbacks, signal);
  }
}

// ---------------------------------------------------------------------------
// Unified Tool Loop: OpenAI, DeepSeek, xAI, Groq, OpenRouter
// ---------------------------------------------------------------------------
async function runOpenAIToolLoop(
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  fullInstructions: string,
  prepared: PreparedAgentMessages,
  assistantMessageId: string,
  providerLabel: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: 60000,
  });

  const allEvidence: SearchEvidence[] = [];
  const messages: any[] = [
    { role: 'system', content: fullInstructions },
    ...prepared.inputItems.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  // Expose ONLY our single web_search tool
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: 'function',
      function: webSearchToolSchema,
    },
  ];

  let iterations = 0;
  const maxIterations = 5;

  try {
    while (iterations++ < maxIterations) {
      if (signal?.aborted) throw new Error('AbortError');

      // Invoke LLM
      const response = await client.chat.completions.create(
        {
          model,
          messages,
          tools,
          tool_choice: 'auto',
          stream: false,
        },
        { signal }
      );

      const choice = response.choices?.[0];
      const message = choice?.message;
      if (!message) throw new Error('Empty model response received');

      // F{Tool call?}
      const toolCalls = message.tool_calls || [];
      if (toolCalls.length > 0) {
        // Append assistant tool_calls message
        messages.push(message);

        for (const toolCall of toolCalls) {
          // G[Validate web_search arguments]
          if (toolCall.function.name === 'web_search') {
            callbacks?.onStatus?.('searching_web');
            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
              parsedArgs = { query: toolCall.function.arguments };
            }

            // H[Execute search pipeline]
            const query = (parsedArgs.query || '').trim();
            const evidence = await internalWebSearchTool.execute({
              query,
              recency: parsedArgs.recency,
              maxResults: parsedArgs.maxResults || 6,
            });

            // I[Persist retrieved evidence]
            for (const item of evidence) {
              allEvidence.push(item);
            }

            // J[Return tool result to LLM]
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(evidence),
            });
          }
        }
        // Loop back to E[Invoke LLM]
        continue;
      }

      // F -> No: Final response received
      const finalText = message.content || '';
      callbacks?.onStatus?.('writing');
      callbacks?.onDelta?.(finalText);

      // K[Validate citations and answer]
      const textCitations = extractCitationsFromText(finalText, assistantMessageId);
      const normalizedSources = normalizeSources(
        allEvidence.map((e) => ({ url: e.url, title: e.title })),
        assistantMessageId
      );

      return {
        success: true,
        normalized: {
          text: finalText,
          citations: textCitations,
          sources: normalizedSources,
          model,
          responseId: response.id || `${providerLabel.toLowerCase()}_${Date.now()}`,
          finishReason: choice.finish_reason || 'completed',
        },
      };
    }

    throw new Error('Exceeded maximum tool call iterations');
  } catch (err: any) {
    return handleProviderError(err, providerLabel, signal);
  }
}

// ---------------------------------------------------------------------------
// Unified Tool Loop: Anthropic Claude
// ---------------------------------------------------------------------------
async function runAnthropicToolLoop(
  apiKey: string,
  model: string,
  fullInstructions: string,
  prepared: PreparedAgentMessages,
  assistantMessageId: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const client = new Anthropic({
    apiKey,
    timeout: 60000,
  });

  const allEvidence: SearchEvidence[] = [];
  const messages: any[] = prepared.inputItems.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  // Expose ONLY our single web_search tool
  const anthropicTools: Anthropic.Tool[] = [
    {
      name: 'web_search',
      description: webSearchToolSchema.description,
      input_schema: {
        type: 'object',
        properties: webSearchToolSchema.parameters.properties as any,
        required: webSearchToolSchema.parameters.required,
      },
    },
  ];

  let iterations = 0;
  const maxIterations = 5;

  try {
    while (iterations++ < maxIterations) {
      if (signal?.aborted) throw new Error('AbortError');

      const response = await client.messages.create(
        {
          model,
          max_tokens: 4096,
          system: fullInstructions,
          messages,
          tools: anthropicTools,
        },
        { signal }
      );

      // F{Tool call?}
      if (response.stop_reason === 'tool_use') {
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        const toolResultBlocks: any[] = [];

        for (const block of response.content) {
          if (block.type === 'tool_use' && block.name === 'web_search') {
            callbacks?.onStatus?.('searching_web');
            const input: any = block.input || {};

            // H[Execute search pipeline]
            const evidence = await internalWebSearchTool.execute({
              query: (input.query || '').trim(),
              recency: input.recency,
              maxResults: input.maxResults || 6,
            });

            // I[Persist retrieved evidence]
            for (const item of evidence) {
              allEvidence.push(item);
            }

            // J[Return tool result to LLM]
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(evidence),
            });
          }
        }

        messages.push({
          role: 'user',
          content: toolResultBlocks,
        });

        // Loop back to E[Invoke LLM]
        continue;
      }

      // F -> No: Final response
      let finalText = '';
      for (const block of response.content) {
        if (block.type === 'text') {
          finalText += block.text;
        }
      }

      callbacks?.onStatus?.('writing');
      callbacks?.onDelta?.(finalText);

      // K[Validate citations and answer]
      const textCitations = extractCitationsFromText(finalText, assistantMessageId);
      const normalizedSources = normalizeSources(
        allEvidence.map((e) => ({ url: e.url, title: e.title })),
        assistantMessageId
      );

      return {
        success: true,
        normalized: {
          text: finalText,
          citations: textCitations,
          sources: normalizedSources,
          model,
          responseId: response.id || `anthropic_${Date.now()}`,
          finishReason: response.stop_reason || 'completed',
        },
      };
    }

    throw new Error('Exceeded maximum tool call iterations');
  } catch (err: any) {
    return handleProviderError(err, 'Anthropic', signal);
  }
}

// ---------------------------------------------------------------------------
// Unified Tool Loop: Google Gemini
// ---------------------------------------------------------------------------
async function runGeminiToolLoop(
  apiKey: string,
  model: string,
  fullInstructions: string,
  prepared: PreparedAgentMessages,
  assistantMessageId: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const ai = new GoogleGenAI({ apiKey });
  const allEvidence: SearchEvidence[] = [];

  const geminiTools: any[] = [
    {
      functionDeclarations: [
        {
          name: 'web_search',
          description: webSearchToolSchema.description,
          parameters: webSearchToolSchema.parameters,
        },
      ],
    },
  ];

  try {
    const chat = ai.chats.create({
      model,
      config: {
        systemInstruction: fullInstructions,
        tools: geminiTools,
      },
    });

    let iterations = 0;
    const maxIterations = 5;

    // Send the user prompt
    let nextMessage: any = prepared.inputItems[prepared.inputItems.length - 1]?.content || '';

    while (iterations++ < maxIterations) {
      if (signal?.aborted) throw new Error('AbortError');

      const response = await chat.sendMessage({
        message: nextMessage,
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        callbacks?.onStatus?.('searching_web');
        const functionResponses: any[] = [];

        for (const fc of functionCalls) {
          if (fc.name === 'web_search') {
            const args: any = fc.args || {};
            const evidence = await internalWebSearchTool.execute({
              query: (args.query || '').trim(),
              recency: args.recency,
              maxResults: args.maxResults || 6,
            });

            for (const item of evidence) {
              allEvidence.push(item);
            }

            functionResponses.push({
              functionResponse: {
                name: 'web_search',
                response: { evidence },
              },
            });
          }
        }

        nextMessage = functionResponses;
        continue;
      }

      // Final response text
      const finalText = response.text || '';
      callbacks?.onStatus?.('writing');
      callbacks?.onDelta?.(finalText);

      const textCitations = extractCitationsFromText(finalText, assistantMessageId);
      const normalizedSources = normalizeSources(
        allEvidence.map((e) => ({ url: e.url, title: e.title })),
        assistantMessageId
      );

      return {
        success: true,
        normalized: {
          text: finalText,
          citations: textCitations,
          sources: normalizedSources,
          model,
          responseId: `gemini_${Date.now()}`,
          finishReason: 'completed',
        },
      };
    }

    throw new Error('Exceeded maximum tool call iterations');
  } catch (err: any) {
    return handleProviderError(err, 'Google Gemini', signal);
  }
}

// ---------------------------------------------------------------------------
// Unified Tool Loop: Cohere
// ---------------------------------------------------------------------------
async function runCohereToolLoop(
  apiKey: string,
  model: string,
  fullInstructions: string,
  prepared: PreparedAgentMessages,
  assistantMessageId: string,
  callbacks?: AgentRunCallbacks,
  signal?: AbortSignal
): Promise<AgentRunResult> {
  const cohere = new CohereClientV2({ token: apiKey });
  const allEvidence: SearchEvidence[] = [];

  const messages: any[] = [
    { role: 'system', content: fullInstructions },
    ...prepared.inputItems.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const cohereTools: any[] = [
    {
      type: 'function',
      function: webSearchToolSchema,
    },
  ];

  let iterations = 0;
  const maxIterations = 5;

  try {
    while (iterations++ < maxIterations) {
      if (signal?.aborted) throw new Error('AbortError');

      const response = await cohere.chat({
        model,
        messages: messages as any,
        tools: cohereTools,
      });

      const toolCalls = response.message?.toolCalls || [];
      if (toolCalls.length > 0) {
        messages.push(response.message);

        for (const tc of toolCalls) {
          if (tc.function?.name === 'web_search') {
            callbacks?.onStatus?.('searching_web');
            let parsedArgs: any = {};
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}');
            } catch {
              parsedArgs = { query: tc.function.arguments };
            }

            const evidence = await internalWebSearchTool.execute({
              query: (parsedArgs.query || '').trim(),
              recency: parsedArgs.recency,
              maxResults: parsedArgs.maxResults || 6,
            });

            for (const item of evidence) {
              allEvidence.push(item);
            }

            messages.push({
              role: 'tool',
              toolCallId: tc.id,
              content: JSON.stringify(evidence),
            });
          }
        }
        continue;
      }

      // Final response text
      const contentParts = response.message?.content || [];
      let finalText = '';
      for (const p of contentParts) {
        if (p.type === 'text') {
          finalText += p.text;
        }
      }

      callbacks?.onStatus?.('writing');
      callbacks?.onDelta?.(finalText);

      const textCitations = extractCitationsFromText(finalText, assistantMessageId);
      const normalizedSources = normalizeSources(
        allEvidence.map((e) => ({ url: e.url, title: e.title })),
        assistantMessageId
      );

      return {
        success: true,
        normalized: {
          text: finalText,
          citations: textCitations,
          sources: normalizedSources,
          model,
          responseId: response.id || `cohere_${Date.now()}`,
          finishReason: 'completed',
        },
      };
    }

    throw new Error('Exceeded maximum tool call iterations');
  } catch (err: any) {
    return handleProviderError(err, 'Cohere', signal);
  }
}

// ---------------------------------------------------------------------------
// Error Helper
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
  const msg = err?.message || `An error occurred while contacting ${providerLabel}.`;

  if (status === 401 || msg.includes('API key') || msg.includes('authentication') || msg.includes('unauthorized')) {
    return {
      success: false,
      errorCode: 'MISSING_API_KEY',
      errorMessage: `Invalid or missing API key for ${providerLabel}. Please check your credentials in Provider Settings.`,
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      success: false,
      errorCode: 'RATE_LIMITED',
      errorMessage: `${providerLabel} rate limit exceeded. Please wait a moment and retry.`,
      retryable: true,
    };
  }

  return {
    success: false,
    errorCode: 'MODEL_REQUEST_FAILED',
    errorMessage: `${providerLabel} request failed: ${scrubSensitiveStrings(msg)}`,
    retryable: true,
  };
}
