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
  live: boolean;
  warning?: string;
}

/**
 * Standard fallback models when a provider's live discovery endpoint is unreachable,
 * offline, or experiencing network connect timeouts.
 */
export const PROVIDER_FALLBACK_MODELS: Record<SupportedProvider, ProviderModelItem[]> = {
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'llama-3.3-70b-versatile (Llama 3.3 70B)' },
    { id: 'llama-3.3-70b-specdec', name: 'llama-3.3-70b-specdec (Speculative Decoding)' },
    { id: 'llama-3.1-70b-versatile', name: 'llama-3.1-70b-versatile (Llama 3.1 70B)' },
    { id: 'llama-3.1-8b-instant', name: 'llama-3.1-8b-instant (Fast)' },
    { id: 'deepseek-r1-distill-llama-70b', name: 'deepseek-r1-distill-llama-70b (Reasoning)' },
    { id: 'mixtral-8x7b-32768', name: 'mixtral-8x7b-32768 (Long Context)' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'gpt-4o (Flagship Omni)' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini (Fast)' },
    { id: 'o1', name: 'o1 (Deep Reasoning)' },
    { id: 'o1-mini', name: 'o1-mini' },
    { id: 'o3-mini', name: 'o3-mini (Reasoning)' },
  ],
  anthropic: [
    { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
    { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'deepseek-chat (V3)' },
    { id: 'deepseek-reasoner', name: 'deepseek-reasoner (R1)' },
  ],
  xai: [
    { id: 'grok-2-1212', name: 'grok-2-1212' },
    { id: 'grok-2-vision-1212', name: 'grok-2-vision-1212' },
    { id: 'grok-beta', name: 'grok-beta' },
  ],
  cohere: [
    { id: 'command-r-plus-08-2024', name: 'command-r-plus-08-2024' },
    { id: 'command-r-08-2024', name: 'command-r-08-2024' },
  ],
  openrouter: [
    { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Meta: Llama 3.3 70B Instruct' },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct (Free)' },
    { id: 'google/gemini-2.0-flash-lite-preview-02-05:free', name: 'Gemini 2.0 Flash Lite (Free)' },
    { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (Free)' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: DeepSeek Chat' },
    { id: 'qwen/qwen-2.5-coder-32b-instruct:free', name: 'Qwen 2.5 Coder 32B (Free)' },
  ],
  ollama: [
    { id: 'llama3.2', name: 'llama3.2 (Meta Llama 3.2 3B)' },
    { id: 'llama3.3', name: 'llama3.3 (Meta Llama 3.3 70B)' },
    { id: 'deepseek-r1:8b', name: 'deepseek-r1:8b (DeepSeek R1 Distill)' },
    { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b' },
    { id: 'mistral', name: 'mistral:7b' },
    { id: 'phi4', name: 'phi4 (Microsoft 14B)' },
  ],
  local: [
    { id: 'local-model', name: 'Currently Loaded Model (LM Studio / Local)' },
    { id: 'llama-3.2-3b-instruct', name: 'llama-3.2-3b-instruct' },
    { id: 'mistral-7b-instruct', name: 'mistral-7b-instruct' },
    { id: 'deepseek-r1-distill-qwen-7b', name: 'deepseek-r1-distill-qwen-7b' },
  ],
};

/**
 * Fetch the ACTUAL list of live models directly from the provider's API.
 * Uses a tight 4.5-second timeout and gracefully falls back to standard models
 * if a network connection failure (e.g. connect timeout, offline, proxy issue) occurs.
 */
export async function listProviderModels(
  provider: SupportedProvider,
  apiKey: string,
  customBaseUrl?: string
): Promise<ListModelsResult> {
  const trimmedKey = apiKey.trim();
  const isLocalProvider = provider === 'ollama' || provider === 'local';
  if (!trimmedKey && !isLocalProvider && provider !== 'openrouter') {
    throw new Error(`API key is required to fetch models for ${provider}.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4500);

  try {
    let result: ListModelsResult;
    switch (provider) {
      case 'groq':
        result = await fetchGroqModels(trimmedKey, controller.signal, customBaseUrl);
        break;
      case 'openai':
        result = await fetchOpenAIModels(trimmedKey, controller.signal, customBaseUrl);
        break;
      case 'anthropic':
        result = await fetchAnthropicModels(trimmedKey, controller.signal);
        break;
      case 'gemini':
        result = await fetchGeminiModels(trimmedKey, controller.signal);
        break;
      case 'deepseek':
        result = await fetchDeepSeekModels(trimmedKey, controller.signal, customBaseUrl);
        break;
      case 'xai':
        result = await fetchXAIModels(trimmedKey, controller.signal, customBaseUrl);
        break;
      case 'cohere':
        result = await fetchCohereModels(trimmedKey, controller.signal);
        break;
      case 'openrouter':
        result = await fetchOpenRouterModels(trimmedKey, controller.signal);
        break;
      case 'ollama':
        result = await fetchOllamaModels(customBaseUrl, controller.signal);
        break;
      case 'local':
        result = await fetchLocalModels(customBaseUrl, controller.signal);
        break;
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
    return result;
  } catch (err: any) {
    const isNetworkError =
      err.name === 'AbortError' ||
      err.message?.includes('fetch failed') ||
      err.message?.includes('Connect Timeout') ||
      err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
      err.cause?.code === 'ETIMEDOUT' ||
      err.cause?.code === 'ENOTFOUND' ||
      err.cause?.code === 'ECONNREFUSED';

    // If it's a network timeout/connectivity issue, fall back gracefully to standard models
    if (isNetworkError) {
      console.warn(
        `[listProviderModels] Network connection to ${provider} models timed out or failed. Using fallback list.`
      );
      return {
        provider,
        models: PROVIDER_FALLBACK_MODELS[provider] || [],
        live: false,
        warning: `Live query to ${provider} timed out. Showing standard models.`,
      };
    }

    // Auth errors (401, 403, etc.) are explicitly thrown so the user is informed
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

  const models: ProviderModelItem[] = data
    .filter((m) => {
      if (m.active === false) return false;
      const id = (m.id || '').toLowerCase();
      if (id.includes('whisper') || id.includes('audio')) return false;
      return true;
    })
    .map((m) => ({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window,
    }))
    .sort((a, b) => {
      const aLlama = a.id.toLowerCase().includes('llama');
      const bLlama = b.id.toLowerCase().includes('llama');
      if (aLlama && !bLlama) return -1;
      if (!aLlama && bLlama) return 1;
      return a.id.localeCompare(b.id);
    });

  return { provider: 'groq', models, live: true };
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
      const getPriority = (id: string) => {
        const lower = id.toLowerCase();
        if (lower.startsWith('gpt-4o')) return 1;
        if (lower.startsWith('o3')) return 2;
        if (lower.startsWith('o1')) return 3;
        if (lower.startsWith('gpt-4')) return 4;
        return 10;
      };
      const diff = getPriority(a.id) - getPriority(b.id);
      if (diff !== 0) return diff;
      return a.id.localeCompare(b.id);
    });

  return { provider: 'openai', models, live: true };
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

  return { provider: 'anthropic', models, live: true };
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

  const models: ProviderModelItem[] = rawModels
    .filter((m) => {
      const methods: string[] = m.supportedGenerationMethods || [];
      return methods.includes('generateContent');
    })
    .map((m) => {
      const cleanId = (m.name || '').replace(/^models\//, '');
      return {
        id: cleanId,
        name: m.displayName ? `${m.displayName} (${cleanId})` : cleanId,
        description: m.description,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return { provider: 'gemini', models, live: true };
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

  return { provider: 'deepseek', models, live: true };
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

  return { provider: 'xai', models, live: true };
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

  return { provider: 'cohere', models, live: true };
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------
async function fetchOpenRouterModels(
  apiKey: string,
  signal: AbortSignal
): Promise<ListModelsResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://sift.local',
    'X-Title': 'Sift Research Agent',
  };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  let res = await fetch('https://openrouter.ai/api/v1/models', {
    method: 'GET',
    headers,
    signal,
  });

  // If 401 occurred (e.g. key expired or invalid), retry without key since /models is public
  if (res.status === 401 && headers['Authorization']) {
    delete headers['Authorization'];
    res = await fetch('https://openrouter.ai/api/v1/models', {
      method: 'GET',
      headers,
      signal,
    });
  }

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

  return { provider: 'openrouter', models, live: true };
}

// ---------------------------------------------------------------------------
// Ollama (Local Server)
// ---------------------------------------------------------------------------
async function fetchOllamaModels(
  customBaseUrl?: string,
  signal?: AbortSignal
): Promise<ListModelsResult> {
  const rawBase = customBaseUrl || 'http://localhost:11434';
  const effectiveBase = rawBase.replace(/\/v1\/?$/, '');

  // 1. Try standard OpenAI-compatible /v1/models endpoint
  try {
    const res = await fetch(`${effectiveBase}/v1/models`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    if (res.ok) {
      const json = await res.json();
      const data: any[] = json.data || [];
      const models: ProviderModelItem[] = data.map((m) => ({
        id: m.id,
        name: m.id,
      }));
      if (models.length > 0) {
        return { provider: 'ollama', models, live: true };
      }
    }
  } catch {}

  // 2. Fallback to native Ollama /api/tags endpoint
  const res = await fetch(`${effectiveBase}/api/tags`, {
    method: 'GET',
    signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama returned status ${res.status} from ${effectiveBase}/api/tags`);
  }

  const json = await res.json();
  const rawModels: any[] = json.models || [];
  const models: ProviderModelItem[] = rawModels.map((m) => {
    const sizeGb = m.size ? `${Math.round((m.size / (1024 * 1024 * 1024)) * 10) / 10}GB` : '';
    return {
      id: m.name || m.model,
      name: sizeGb ? `${m.name || m.model} (${sizeGb})` : (m.name || m.model),
    };
  });

  if (models.length === 0) {
    return {
      provider: 'ollama',
      models: PROVIDER_FALLBACK_MODELS.ollama,
      live: false,
      warning: 'Ollama is running, but no models have been pulled yet. Run "ollama pull llama3.2".',
    };
  }

  return { provider: 'ollama', models, live: true };
}

// ---------------------------------------------------------------------------
// Local / LM Studio / vLLM / LocalAI
// ---------------------------------------------------------------------------
async function fetchLocalModels(
  customBaseUrl?: string,
  signal?: AbortSignal
): Promise<ListModelsResult> {
  const rawBase = customBaseUrl || 'http://localhost:1234/v1';
  const effectiveBase = rawBase.replace(/\/$/, '');
  const url = effectiveBase.endsWith('/models') ? effectiveBase : `${effectiveBase}/models`;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Local model server returned status ${res.status} from ${url}`);
  }

  const json = await res.json();
  const data: any[] = json.data || [];
  const models: ProviderModelItem[] = data.map((m) => ({
    id: m.id,
    name: m.id,
  }));

  if (models.length === 0) {
    return {
      provider: 'local',
      models: PROVIDER_FALLBACK_MODELS.local,
      live: false,
      warning: 'Local server is connected, but no model is currently loaded in memory.',
    };
  }

  return { provider: 'local', models, live: true };
}
