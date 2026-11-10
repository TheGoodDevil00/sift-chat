import type { SupportedProvider } from '@/types/chat';
import { maskApiKey } from './scrub';

export interface EncryptedRecord {
  iv: string; // base64 12-byte IV
  ciphertext: string; // base64 AES-GCM ciphertext + tag
  fingerprint: string; // e.g. "gsk_••••••••••••3a9b"
  updatedAt: string;
}

export type EncryptedVaultStore = Partial<Record<SupportedProvider, EncryptedRecord>>;

export interface ProviderKeyStatus {
  isConfigured: boolean;
  fingerprint?: string;
  updatedAt?: string;
}

const VAULT_STORAGE_KEY = 'sift_encrypted_vault_v1';
const VAULT_SALT_KEY = 'sift_vault_salt_v1';
const VAULT_DEVICE_KEY = 'sift_vault_device_id_v1';

// In-memory decrypted cache (ephemeral, not exposed globally)
const inMemoryKeyCache = new Map<SupportedProvider, string>();
let cachedDerivedKey: CryptoKey | null = null;

// Helpers for byte array encoding/decoding across browser and node
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToUint8(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function uint8ToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToUint8(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {}
  return null;
}

/**
 * Derives a non-extractable AES-GCM 256-bit encryption key using PBKDF2-HMAC-SHA256
 * (100,000 iterations) bound to a unique client device ID and cryptographically random salt.
 */
async function getOrCreateVaultKey(): Promise<CryptoKey> {
  if (cachedDerivedKey) {
    return cachedDerivedKey;
  }

  const storage = getSafeLocalStorage();

  // 1. Resolve or generate cryptographically secure device installation ID (32 bytes)
  let deviceId = storage?.getItem(VAULT_DEVICE_KEY);
  if (!deviceId) {
    const randomBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(randomBytes);
    deviceId = uint8ToHex(randomBytes);
    try {
      storage?.setItem(VAULT_DEVICE_KEY, deviceId);
    } catch {}
  }

  // 2. Resolve or generate 16-byte random salt for PBKDF2
  let saltHex = storage?.getItem(VAULT_SALT_KEY);
  let saltBytes: Uint8Array;
  if (!saltHex) {
    saltBytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(saltBytes);
    saltHex = uint8ToHex(saltBytes);
    try {
      storage?.setItem(VAULT_SALT_KEY, saltHex);
    } catch {}
  } else {
    saltBytes = hexToUint8(saltHex);
  }

  // 3. Derive AES-GCM-256 key via PBKDF2
  const enc = new TextEncoder();
  const passwordKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(`sift_vault_entropy_v1_${deviceId}`),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const derived = await globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes as BufferSource,
      iterations: 100000,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false, // Non-exportable key for protection against memory dump attacks
    ['encrypt', 'decrypt']
  );

  cachedDerivedKey = derived;
  return derived;
}

function readVaultStore(): EncryptedVaultStore {
  const storage = getSafeLocalStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeVaultStore(store: EncryptedVaultStore): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(VAULT_STORAGE_KEY, JSON.stringify(store));
  } catch (err) {
    console.warn('Failed to write encrypted vault to storage:', err);
  }
}

/**
 * Saves a provider key into the encrypted vault with AES-GCM 256.
 * Generates a fresh random 12-byte IV for every write operation.
 * NEVER alters or deletes keys for other providers.
 */
export async function saveProviderKey(
  provider: SupportedProvider,
  plaintextKey: string
): Promise<void> {
  const trimmed = plaintextKey.trim();
  if (!trimmed) {
    await removeProviderKey(provider);
    return;
  }

  const key = await getOrCreateVaultKey();
  const ivBytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(ivBytes);

  const enc = new TextEncoder();
  const cipherBuffer = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ivBytes },
    key,
    enc.encode(trimmed)
  );

  const record: EncryptedRecord = {
    iv: uint8ToBase64(ivBytes),
    ciphertext: uint8ToBase64(new Uint8Array(cipherBuffer)),
    fingerprint: maskApiKey(trimmed),
    updatedAt: new Date().toISOString(),
  };

  const store = readVaultStore();
  store[provider] = record;
  writeVaultStore(store);

  // Update in-memory ephemeral cache
  inMemoryKeyCache.set(provider, trimmed);
}

/**
 * Batch saves multiple provider keys in a single transaction without deleting previous keys.
 */
export async function saveMultipleProviderKeys(
  entries: Partial<Record<SupportedProvider, string>>
): Promise<void> {
  for (const [prov, key] of Object.entries(entries) as [SupportedProvider, string][]) {
    if (key !== undefined) {
      await saveProviderKey(prov, key);
    }
  }
}

/**
 * Decrypts and retrieves a provider's key from the AES-GCM encrypted vault.
 */
export async function getProviderKey(provider: SupportedProvider): Promise<string | null> {
  // Check in-memory cache first
  if (inMemoryKeyCache.has(provider)) {
    return inMemoryKeyCache.get(provider) || null;
  }

  const store = readVaultStore();
  const record = store[provider];
  if (!record || !record.iv || !record.ciphertext) {
    return null;
  }

  try {
    const key = await getOrCreateVaultKey();
    const ivBytes = base64ToUint8(record.iv);
    const cipherBytes = base64ToUint8(record.ciphertext);

    const decryptedBuffer = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes as BufferSource },
      key,
      cipherBytes as BufferSource
    );

    const dec = new TextDecoder();
    const decrypted = dec.decode(decryptedBuffer);

    inMemoryKeyCache.set(provider, decrypted);
    return decrypted;
  } catch (err) {
    console.warn(`Failed to decrypt credentials for provider ${provider}:`, err);
    return null;
  }
}

/**
 * Removes a specific provider's key from the encrypted vault.
 * All other provider keys remain completely unaffected.
 */
export async function removeProviderKey(provider: SupportedProvider): Promise<void> {
  inMemoryKeyCache.delete(provider);
  const store = readVaultStore();
  if (store[provider]) {
    delete store[provider];
    writeVaultStore(store);
  }
}

/**
 * Returns configuration status and masked fingerprint for all providers
 * without needing to decrypt the actual keys.
 */
export async function getVaultStatuses(): Promise<
  Record<SupportedProvider, ProviderKeyStatus>
> {
  const store = readVaultStore();
  const allProviders: SupportedProvider[] = [
    'groq',
    'openai',
    'anthropic',
    'gemini',
    'deepseek',
    'xai',
    'cohere',
    'openrouter',
  ];

  const statuses = {} as Record<SupportedProvider, ProviderKeyStatus>;
  for (const p of allProviders) {
    const record = store[p];
    if (record && record.ciphertext) {
      statuses[p] = {
        isConfigured: true,
        fingerprint: record.fingerprint,
        updatedAt: record.updatedAt,
      };
    } else {
      statuses[p] = {
        isConfigured: false,
      };
    }
  }

  return statuses;
}

/**
 * Transparently migrates any legacy unencrypted keys (`sift_key_${provider}`)
 * from previous versions into the encrypted AES-GCM vault, and purges the plaintext
 * entries from localStorage immediately to eliminate security exposure.
 */
export async function migrateLegacyPlaintextKeys(): Promise<void> {
  const storage = getSafeLocalStorage();
  if (!storage) return;

  const allProviders: SupportedProvider[] = [
    'groq',
    'openai',
    'anthropic',
    'gemini',
    'deepseek',
    'xai',
    'cohere',
    'openrouter',
  ];

  for (const prov of allProviders) {
    const legacyKey = storage.getItem(`sift_key_${prov}`);
    if (legacyKey && legacyKey.trim()) {
      try {
        await saveProviderKey(prov, legacyKey.trim());
        // Eradicate plaintext key from browser storage
        storage.removeItem(`sift_key_${prov}`);
      } catch (err) {
        console.warn(`Failed to migrate legacy key for ${prov}:`, err);
      }
    }
  }
}

/**
 * Completely wipes the encrypted vault and all in-memory keys.
 */
export async function clearEntireVault(): Promise<void> {
  inMemoryKeyCache.clear();
  cachedDerivedKey = null;
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      storage.removeItem(VAULT_STORAGE_KEY);
      storage.removeItem(VAULT_SALT_KEY);
      storage.removeItem(VAULT_DEVICE_KEY);
    } catch {}
  }
}
