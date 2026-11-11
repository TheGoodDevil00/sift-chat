import type { SupportedProvider } from '@/types/chat';
import type { ProviderAdapter } from './adapter';
import { OpenAIAdapter } from './openai-adapter';
import { AnthropicAdapter } from './anthropic-adapter';
import { GeminiAdapter } from './gemini-adapter';
import { CohereAdapter } from './cohere-adapter';

export * from './adapter';
export * from './openai-adapter';
export * from './anthropic-adapter';
export * from './gemini-adapter';
export * from './cohere-adapter';
export * from './list-models';

export function createProviderAdapter(
  provider: SupportedProvider,
  apiKey: string,
  model: string,
  customBaseUrl?: string
): ProviderAdapter {
  if (provider === 'anthropic') {
    return new AnthropicAdapter(apiKey, model);
  }

  if (provider === 'gemini') {
    return new GeminiAdapter(apiKey, model);
  }

  if (provider === 'cohere') {
    return new CohereAdapter(apiKey, model);
  }

  // OpenAI, DeepSeek, xAI, Groq, OpenRouter, Ollama, Local
  let baseUrl = customBaseUrl;
  const defaultHeaders: Record<string, string> = {};

  if (provider === 'deepseek') {
    baseUrl = baseUrl || 'https://api.deepseek.com';
  } else if (provider === 'xai') {
    baseUrl = baseUrl || 'https://api.x.ai/v1';
  } else if (provider === 'groq') {
    baseUrl = baseUrl || 'https://api.groq.com/openai/v1';
  } else if (provider === 'openrouter') {
    baseUrl = baseUrl || 'https://openrouter.ai/api/v1';
    defaultHeaders['HTTP-Referer'] = 'https://sift.local';
    defaultHeaders['X-Title'] = 'Sift Research Agent';
  } else if (provider === 'ollama') {
    baseUrl = baseUrl || 'http://localhost:11434/v1';
  } else if (provider === 'local') {
    baseUrl = baseUrl || 'http://localhost:1234/v1';
  }

  return new OpenAIAdapter(
    apiKey,
    model,
    baseUrl,
    defaultHeaders,
    (process.env.OPENAI_REASONING_EFFORT as any) || 'medium'
  );
}
