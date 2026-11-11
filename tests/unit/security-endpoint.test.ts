import { describe, it, expect } from 'vitest';
import {
  isSafeRemoteUrl,
  isSafeRemoteUrlResolved,
  validateCustomBaseUrl,
} from '@/lib/security/endpoint';
import { deepScrapeUrl } from '@/lib/agent/tools/deep-scrape';
import { runAgent } from '@/lib/agent/run';
import type { PreparedAgentMessages } from '@/lib/agent/input-builder';

describe('isSafeRemoteUrl', () => {
  it('accepts ordinary public HTTP(S) URLs', () => {
    expect(isSafeRemoteUrl('https://exa.ai/pricing')).toBe(true);
    expect(isSafeRemoteUrl('http://example.com/changelog?since=mon')).toBe(true);
  });

  it('rejects internal, credentialed, and non-HTTP URLs', () => {
    for (const url of [
      'http://localhost:3000/api/chat',
      'http://127.0.0.1/secret',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data',
      'http://10.1.2.3/',
      'http://192.168.0.1/admin',
      'http://metadata.google.internal/',
      'file:///etc/passwd',
      'https://user:pass@example.com/',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(isSafeRemoteUrl(url), url).toBe(false);
    }
  });

  it('treats IPv4-mapped IPv6 addresses like their IPv4 value', () => {
    expect(isSafeRemoteUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
    expect(isSafeRemoteUrl('http://[::ffff:7f00:1]/')).toBe(false);
    expect(isSafeRemoteUrl('http://[::ffff:8.8.8.8]/')).toBe(true);
  });

  it('rejects hostnames that resolve to internal addresses', async () => {
    const privateResolver = async () => ['10.0.0.5'];
    const publicResolver = async () => ['93.184.216.34'];
    const failingResolver = async (): Promise<string[]> => {
      throw new Error('ENOTFOUND');
    };

    await expect(
      isSafeRemoteUrlResolved('https://pricing.internal.example.com/', privateResolver)
    ).resolves.toBe(false);
    await expect(
      isSafeRemoteUrlResolved('https://supabase.com/pricing', publicResolver)
    ).resolves.toBe(true);
    await expect(
      isSafeRemoteUrlResolved('https://unresolvable.example.com/', failingResolver)
    ).resolves.toBe(false);
  });

  it('does not resolve a literal internal address before rejecting it', async () => {
    let called = false;
    const spyResolver = async () => {
      called = true;
      return ['93.184.216.34'];
    };

    await expect(
      isSafeRemoteUrlResolved('http://169.254.169.254/latest/meta-data', spyResolver)
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });

  it('deepScrapeUrl refuses internal targets before any network call', async () => {
    await expect(deepScrapeUrl('http://127.0.0.1:11434/api/tags')).resolves.toBeNull();
    await expect(deepScrapeUrl('http://169.254.169.254/latest/meta-data')).resolves.toBeNull();
  });
});

describe('Custom provider endpoint validation', () => {
  it('rejects non-HTTP protocols and embedded credentials', () => {
    expect(validateCustomBaseUrl('file:///etc/passwd', 'openai').ok).toBe(false);
    expect(validateCustomBaseUrl('https://user:pass@example.com/v1', 'openai').ok).toBe(false);
    expect(validateCustomBaseUrl('https://example.com/v1?token=abc', 'openai').ok).toBe(false);
    expect(validateCustomBaseUrl('not a url', 'openai').ok).toBe(false);
  });

  it('rejects private, link-local, and metadata addresses for remote providers', () => {
    for (const url of [
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://172.16.4.2/v1',
      'https://192.168.1.20/v1',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/v1',
      'https://metadata.google.internal/v1',
    ]) {
      expect(validateCustomBaseUrl(url, 'openai').ok, url).toBe(false);
    }
  });

  it('requires https for remote custom endpoints but allows http loopback in development only when opted in', () => {
    expect(validateCustomBaseUrl('http://example.com/v1', 'openai').ok).toBe(false);
    expect(validateCustomBaseUrl('http://localhost:8080/v1', 'openai').ok).toBe(false);
    expect(
      validateCustomBaseUrl('http://localhost:8080/v1', 'openai', { allowLoopback: true }).ok
    ).toBe(true);
  });

  it('allows only loopback for local providers', () => {
    expect(validateCustomBaseUrl('http://localhost:11434/v1', 'ollama').ok).toBe(true);
    expect(validateCustomBaseUrl('http://127.0.0.1:1234/v1', 'local').ok).toBe(true);
    expect(validateCustomBaseUrl('http://192.168.1.20:11434/v1', 'ollama').ok).toBe(false);
    expect(validateCustomBaseUrl('https://example.com/v1', 'ollama').ok).toBe(false);
  });

  it('allows a public https endpoint for a remote provider', () => {
    const check = validateCustomBaseUrl('https://api.example.com/v1', 'openai');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.url).toBe('https://api.example.com/v1');
  });

  it('runAgent refuses a custom endpoint without a client-supplied key', async () => {
    const prepared: PreparedAgentMessages = {
      systemPromptAdditions: '',
      inputItems: [{ role: 'user', content: 'Hello' }],
      requiresSearch: false,
    };

    const result = await runAgent(prepared, 'msg-1', undefined, undefined, {
      provider: 'openai',
      model: 'gpt-test',
      customBaseUrl: 'http://localhost:9999/v1',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CUSTOM_ENDPOINT_REQUIRES_CLIENT_KEY');
  });

  it('runAgent rejects a private endpoint before resolving any server key', async () => {
    const prepared: PreparedAgentMessages = {
      systemPromptAdditions: '',
      inputItems: [{ role: 'user', content: 'Hello' }],
    };

    const result = await runAgent(prepared, 'msg-1', undefined, undefined, {
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'client-key',
      customBaseUrl: 'https://10.0.0.5/v1',
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('INVALID_CUSTOM_BASE_URL');
  });
});
