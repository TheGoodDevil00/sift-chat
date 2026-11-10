import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listProviderModels } from '@/lib/agent/providers/list-models';

describe('listProviderModels', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws an error if apiKey is empty', async () => {
    await expect(listProviderModels('groq', '   ')).rejects.toThrow(
      'API key is required to fetch models for groq.'
    );
  });

  it('fetches and filters Groq models correctly (excluding audio/whisper)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [
          { id: 'whisper-large-v3', active: true },
          { id: 'llama-3.1-70b-versatile', active: true, context_window: 131072 },
          { id: 'llama-3.3-70b-specdec', active: true, context_window: 8192 },
          { id: 'gemma2-9b-it', active: true },
          { id: 'deprecated-model', active: false },
        ],
      }),
    } as any);

    const result = await listProviderModels('groq', 'gsk_test_key');
    expect(result.provider).toBe('groq');
    // whisper and inactive should be excluded
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain('llama-3.1-70b-versatile');
    expect(ids).toContain('llama-3.3-70b-specdec');
    expect(ids).toContain('gemma2-9b-it');
    expect(ids).not.toContain('whisper-large-v3');
    expect(ids).not.toContain('deprecated-model');
  });

  it('fetches and formats Anthropic models correctly', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet' },
          { id: 'claude-3-haiku-20240307', display_name: 'Claude 3 Haiku' },
        ],
      }),
    } as any);

    const result = await listProviderModels('anthropic', 'sk-ant-test');
    expect(result.provider).toBe('anthropic');
    expect(result.models.length).toBe(2);
    expect(result.models[0].id).toBe('claude-3-5-sonnet-20241022');
    expect(result.models[0].name).toBe('Claude 3.5 Sonnet (claude-3-5-sonnet-20241022)');
  });

  it('fetches Gemini models and strips models/ prefix', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Text Embedding 004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      }),
    } as any);

    const result = await listProviderModels('gemini', 'gemini-key');
    expect(result.provider).toBe('gemini');
    expect(result.models.length).toBe(1);
    expect(result.models[0].id).toBe('gemini-2.5-flash');
    expect(result.models[0].name).toContain('Gemini 2.5 Flash');
  });

  it('propagates provider error messages cleanly', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({
          error: { message: 'Invalid API Key provided.' },
        }),
    } as any);

    await expect(listProviderModels('groq', 'bad_key')).rejects.toThrow(
      'Groq models error (401): Invalid API Key provided.'
    );
  });

  it('falls back to standard models gracefully when network connect timeout occurs', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const result = await listProviderModels('groq', 'gsk_test_key');
    expect(result.provider).toBe('groq');
    expect(result.live).toBe(false);
    expect(result.warning).toContain('timed out');
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.some((m) => m.id.includes('llama'))).toBe(true);
  });

  it('fetches OpenRouter models with proper routing headers', async () => {
    global.fetch = vi.fn().mockImplementation((url, init) => {
      expect(init.headers['HTTP-Referer']).toBe('https://sift.local');
      expect(init.headers['X-Title']).toBe('Sift Research Agent');
      return Promise.resolve({
        ok: true,
        json: async () => ({
          data: [
            { id: 'anthropic/claude-3.5-sonnet', name: 'Anthropic: Claude 3.5 Sonnet' },
            { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
          ],
        }),
      } as any);
    });

    const result = await listProviderModels('openrouter', 'sk-or-v1-test');
    expect(result.provider).toBe('openrouter');
    expect(result.models.length).toBe(2);
    expect(result.models[0].id).toBe('anthropic/claude-3.5-sonnet');
    expect(result.models[1].id).toBe('meta-llama/llama-3.3-70b-instruct:free');
  });

  it('fetches Ollama local models without requiring an API key', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'llama3.2:latest', size: 2000000000 },
          { name: 'deepseek-r1:8b', size: 4900000000 },
        ],
      }),
    } as any);

    const result = await listProviderModels('ollama', '');
    expect(result.provider).toBe('ollama');
    expect(result.models.length).toBe(2);
    expect(result.models[0].id).toBe('llama3.2:latest');
    expect(result.models[1].id).toBe('deepseek-r1:8b');
  });

  it('fetches Local / LM Studio models without requiring an API key', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'mistral-7b-instruct-v0.3' }],
      }),
    } as any);

    const result = await listProviderModels('local', '', 'http://localhost:1234/v1');
    expect(result.provider).toBe('local');
    expect(result.models.length).toBe(2);
    expect(result.models[0].id).toBe('qwen2.5-7b-instruct');
  });
});
