import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveProviderKey,
  saveMultipleProviderKeys,
  getProviderKey,
  removeProviderKey,
  getVaultStatuses,
  migrateLegacyPlaintextKeys,
  clearEntireVault,
} from '@/lib/crypto/vault';
import { scrubSensitiveStrings, maskApiKey } from '@/lib/crypto/scrub';

// In-memory mock storage for Vitest Node environment
class MockLocalStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) || null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] || null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('Cryptographic Scrubbing & Redaction', () => {
  it('redacts sensitive API keys and tokens from strings', () => {
    const rawError =
      'Request to Groq failed with key gsk_abcdef1234567890abcdef1234567890: Invalid model';
    const scrubbed = scrubSensitiveStrings(rawError);
    expect(scrubbed).not.toContain('gsk_abcdef1234567890abcdef1234567890');
    expect(scrubbed).toContain('[REDACTED_API_KEY]');
  });

  it('redacts OpenAI and Anthropic keys', () => {
    const text =
      'OpenAI sk-proj-1234567890abcdef1234567890 and Anthropic sk-ant-api03-abcdef1234567890';
    const scrubbed = scrubSensitiveStrings(text);
    expect(scrubbed).not.toContain('sk-proj-');
    expect(scrubbed).not.toContain('sk-ant-');
  });

  it('masks API keys safely for UI display', () => {
    expect(maskApiKey('gsk_1234567890abcdef1234')).toBe('gsk_••••••••••••1234');
    expect(maskApiKey('sk-ant-very-long-secret-key-9999')).toBe('sk-a••••••••••••9999');
    expect(maskApiKey('')).toBe('');
  });
});

describe('Multi-Provider Encrypted Vault (AES-GCM-256)', () => {
  let mockStorage: MockLocalStorage;

  beforeEach(async () => {
    mockStorage = new MockLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    await clearEntireVault();
  });

  it('encrypts provider keys with AES-GCM and never stores plaintext in storage', async () => {
    const secretKey = 'gsk_super_secret_groq_api_token_123456';
    await saveProviderKey('groq', secretKey);

    // Verify localStorage has NO plaintext
    const rawVault = mockStorage.getItem('sift_encrypted_vault_v1');
    expect(rawVault).toBeTruthy();
    expect(rawVault).not.toContain(secretKey);

    const parsed = JSON.parse(rawVault!);
    expect(parsed.groq).toBeDefined();
    expect(parsed.groq.iv).toBeDefined();
    expect(parsed.groq.ciphertext).toBeDefined();
    expect(parsed.groq.ciphertext).not.toBe(secretKey);

    // Verify decryption retrieves exact plaintext
    const decrypted = await getProviderKey('groq');
    expect(decrypted).toBe(secretKey);
  });

  it('stores keys for multiple providers simultaneously without deleting previous ones', async () => {
    const groqKey = 'gsk_groq_production_key_001';
    const openaiKey = 'sk-proj-openai_production_key_002';
    const anthropicKey = 'sk-ant-anthropic_production_key_003';

    // Save Groq
    await saveProviderKey('groq', groqKey);

    // Save OpenAI - must NOT delete Groq
    await saveProviderKey('openai', openaiKey);

    // Save Anthropic - must NOT delete Groq or OpenAI
    await saveProviderKey('anthropic', anthropicKey);

    // Verify all 3 can be decrypted accurately
    expect(await getProviderKey('groq')).toBe(groqKey);
    expect(await getProviderKey('openai')).toBe(openaiKey);
    expect(await getProviderKey('anthropic')).toBe(anthropicKey);

    // Verify statuses
    const statuses = await getVaultStatuses();
    expect(statuses.groq.isConfigured).toBe(true);
    expect(statuses.openai.isConfigured).toBe(true);
    expect(statuses.anthropic.isConfigured).toBe(true);
    expect(statuses.gemini.isConfigured).toBe(false);
  });

  it('batch saves multiple provider keys safely', async () => {
    await saveMultipleProviderKeys({
      gemini: 'AIzaSy_gemini_key_12345678901234567890',
      deepseek: 'sk-deepseek_key_12345678901234567890',
    });

    expect(await getProviderKey('gemini')).toBe('AIzaSy_gemini_key_12345678901234567890');
    expect(await getProviderKey('deepseek')).toBe('sk-deepseek_key_12345678901234567890');
  });

  it('removing one provider key leaves all other provider keys untouched', async () => {
    await saveProviderKey('groq', 'gsk_123');
    await saveProviderKey('openai', 'sk-456');

    await removeProviderKey('groq');

    expect(await getProviderKey('groq')).toBeNull();
    expect(await getProviderKey('openai')).toBe('sk-456');
  });

  it('uses fresh cryptographic IV for each encryption to prevent frequency analysis', async () => {
    const identicalKey = 'sk-proj-identical-key-for-test-999';
    await saveProviderKey('openai', identicalKey);
    const vault1 = JSON.parse(mockStorage.getItem('sift_encrypted_vault_v1')!);
    const iv1 = vault1.openai.iv;
    const cipher1 = vault1.openai.ciphertext;

    // Save again
    await saveProviderKey('openai', identicalKey);
    const vault2 = JSON.parse(mockStorage.getItem('sift_encrypted_vault_v1')!);
    const iv2 = vault2.openai.iv;
    const cipher2 = vault2.openai.ciphertext;

    // IV and ciphertext must be different even for identical plaintext
    expect(iv1).not.toBe(iv2);
    expect(cipher1).not.toBe(cipher2);
  });

  it('migrates legacy unencrypted plaintext keys and purges them from localStorage', async () => {
    // Simulate old legacy unencrypted storage
    mockStorage.setItem('sift_key_groq', 'gsk_legacy_plaintext_groq');
    mockStorage.setItem('sift_key_cohere', 'cohere_legacy_plaintext_key');

    await migrateLegacyPlaintextKeys();

    // Plaintext keys must be completely removed from localStorage
    expect(mockStorage.getItem('sift_key_groq')).toBeNull();
    expect(mockStorage.getItem('sift_key_cohere')).toBeNull();

    // Keys must now be safely decrypted from the encrypted vault
    expect(await getProviderKey('groq')).toBe('gsk_legacy_plaintext_groq');
    expect(await getProviderKey('cohere')).toBe('cohere_legacy_plaintext_key');
  });
});
