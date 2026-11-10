import type { SupportedProvider } from '@/types/chat';

export interface ProviderModelItem {
  id: string;
  name: string;
  contextWindow?: number;
  description?: string;
}

export interface ListModelsResult {
  provider: SupportedProvider;
  models: ProviderModelItem[];
}

/**
 * Fetch the ACTUAL list of live models directly from the provider's API.
 * No hardcoded presets - queries the live endpoint using the provided API key.
 */
export async function listProviderModels(
  provider: SupportedProvider,
  apiKey: string,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    throw new Error(`API key is required to fetch models for ${provider}.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    switch (provider) {
      case 'groq':
        return await fetchGroqModels(trimmedKey, controller.signal, customBaseUrl);
      case 'openai':
        return await fetchOpenAIModels(trimmedKey, controller.signal, customBaseUrl);
      case 'anthropic':
        return await fetchAnthropicModels(trimmedKey, controller.signal);
      case 'gemini':
        return await fetchGeminiModels(trimmedKey, controller.signal);
      case 'deepseek':
        return await fetchDeepSeekModels(trimmedKey, controller.signal, customBaseUrl);
      case 'xai':
        return await fetchXAIModels(trimmedKey, controller.signal, customBaseUrl);
      case 'cohere':
        return await fetchCohereModels(trimmedKey, controller.signal);
      case 'openrouter':
        return await fetchOpenRouterModels(trimmedKey, controller.signal);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Connection timed out while fetching models from ${provider}.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------
async function fetchGroqModels(
  apiKey: string,
  signal: AbortSignal,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const baseUrl = (customBaseUrl || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || parsed.message || errorText;
    } catch {}
    throw new Error(`Groq models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  // Filter out audio / whisper / non-chat models
  const models: ProviderModelItem[] = data
    .filter((m) => {
      if (m.active === false) return false;
      const id = (m.id || '').toLowerCase();
      if (id.includes('whisper')) return false;
      return true;
    })
    .map((m) => ({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window,
    }))
    .sort((a, b) => {
      // Put popular llama / deepseek models first
      const aLlama = a.id.toLowerCase().includes('llama');
      const bLlama = b.id.toLowerCase().includes('llama');
      if (aLlama && !bLlama) return -1;
      if (!aLlama && bLlama) return 1;
      return a.id.localeCompare(b.id);
    });

  return { provider: 'groq', models };
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------
async function fetchOpenAIModels(
  apiKey: string,
  signal: AbortSignal,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const baseUrl = (customBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`OpenAI models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  const excludedKeywords = [
    'whisper',
    'dall-e',
    'tts',
    'embedding',
    'text-moderation',
    'babbage',
    'davinci',
    'canary',
    'audio',
  ];

  const models: ProviderModelItem[] = data
    .filter((m) => {
      const id = (m.id || '').toLowerCase();
      return !excludedKeywords.some((k) => id.includes(k));
    })
    .map((m) => ({
      id: m.id,
      name: m.id,
    }))
    .sort((a, b) => {
      // Sort newer models (gpt-4, gpt-5, gpt-6, o1, o3) towards top
      const getPriority = (id: string) => {
        const lower = id.toLowerCase();
        if (lower.startsWith('gpt-6')) return 1;
        if (lower.startsWith('gpt-5')) return 2;
        if (lower.startsWith('o3')) return 3;
        if (lower.startsWith('o1')) return 4;
        if (lower.startsWith('gpt-4o')) return 5;
        if (lower.startsWith('gpt-4')) return 6;
        return 10;
      };
      const diff = getPriority(a.id) - getPriority(b.id);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });

  return { provider: 'openai', models };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
async function fetchAnthropicModels(
  apiKey: string,
  signal: AbortSignal
): Promise<ListModelsResult> {
  const res = await fetch('https://api.anthropic.com/v1/models', {
    method: 'GET',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`Anthropic models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  const models: ProviderModelItem[] = data.map((m) => ({
    id: m.id,
    name: m.display_name ? `${m.display_name} (${m.id})` : m.id,
  }));

  return { provider: 'anthropic', models };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------
async function fetchGeminiModels(
  apiKey: string,
  signal: AbortSignal
): Promise<ListModelsResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    apiKey
  )}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`Gemini models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const rawModels: any[] = json.models || [];

  // Filter models that support content generation
  const models: ProviderModelItem[] = rawModels
    .filter((m) => {
      const methods: string[] = m.supportedGenerationMethods || [];
      return methods.includes('generateContent');
    })
    .map((m) => {
      // Strip 'models/' prefix
      const cleanId = (m.name || '').replace(/^models\//, '');
      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})` : cleanId,
        description: m.description,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return { provider: 'gemini', models };
}

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------
async function fetchDeepSeekModels(
  apiKey: string,
  signal: AbortSignal,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const baseUrl = (customBaseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`DeepSeek models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  const models: ProviderModelItem[] = data.map((m) => ({
    id: m.id,
    name: m.id,
  }));

  return { provider: 'deepseek', models };
}

// ---------------------------------------------------------------------------
// xAI
// ---------------------------------------------------------------------------
async function fetchXAIModels(
  apiKey: string,
  signal: AbortSignal,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const baseUrl = (customBaseUrl || 'https://api.x.ai/v1').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`xAI models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  const models: ProviderModelItem[] = data
    .filter((m) => !(m.id || '').includes('embedding'))
    .map((m) => ({
      id: m.id,
      name: m.id,
    }));

  return { provider: 'xai', models };
}

// ---------------------------------------------------------------------------
// Cohere
// ---------------------------------------------------------------------------
async function fetchCohereModels(
  apiKey: string,
  signal: AbortSignal
): Promise<ListModelsResult> {
  const res = await fetch('https://api.cohere.com/v1/models?endpoint=chat', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.message || parsed.error || errorText;
    } catch {}
    throw new Error(`Cohere models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const rawList: any[] = json.models || [];

  const models: ProviderModelItem[] = rawList.map((m) => ({
    id: m.name,
    name: m.name,
    contextWindow: m.context_length,
  }));

  return { provider: 'cohere', models };
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
async function fetchOpenRouterModels(
  apiKey: string,
  signal: AbortSignal
): Promise<ListModelsResult> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (!res.ok) {
    const errorText = await res.text();
    let message = errorText;
    try {
      const parsed = JSON.parse(errorText);
      message = parsed.error?.message || errorText;
    } catch {}
    throw new Error(`OpenRouter models error (${res.status}): ${message}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];

  const models: ProviderModelItem[] = data.map((m) => ({
    id: m.id,
    name: m.name ? `${m.name} (${m.id})` : m.id,
    contextWindow: m.context_length,
    description: m.description,
  }));

  return { provider: 'openrouter', models };
}
