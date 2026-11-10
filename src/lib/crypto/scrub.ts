/**
 * Utility to scrub and redact sensitive credentials and API keys from text,
 * error messages, stack traces, and logs.
 */

const SENSITIVE_PATTERNS = [
  // OpenAI keys: sk-..., sk-proj-...
  /\bsk-[a-zA-Z0-9_\-]{20,}\b/g,
  // Anthropic API keys: sk-ant-...
  /\bsk-ant-[a-zA-Z0-9_\-]{20,}\b/g,
  // Groq API keys: gsk_...
  /\bgsk_[a-zA-Z0-9_\-]{20,}\b/g,
  // Google Gemini API keys: AIzaSy...
  /\bAIzaSy[a-zA-Z0-9_\-]{33}\b/g,
  // Cohere / generic 40-char hex/alphanumeric tokens
  /\b[a-f0-9]{40}\b/gi,
  // Bearer tokens in headers
  /Bearer\s+[a-zA-Z0-9_\-\.]{16,}/gi,
  // Key query parameters: ?key=..., &apiKey=...
  /([?&](?:apiKey|api_key|key)=)[^&\s]+/gi,
];

/**
 * Scrubs any API key or bearer token from the input string, replacing
 * it with [REDACTED_API_KEY].
 */
export function scrubSensitiveStrings(input: string): string {
  if (!input || typeof input !== 'string') return input;
  let result = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match, p1) => {
      if (p1) {
        return `${p1}[REDACTED_API_KEY]`;
      }
      return '[REDACTED_API_KEY]';
    });
  }
  return result;
}

/**
 * Generates a safe masked fingerprint for display in the UI,
 * e.g., "gsk_••••••••••••3a9b" or "sk-p••••••••••••7c41".
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  const prefix = trimmed.slice(0, 4);
  const suffix = trimmed.slice(-4);
  return `${prefix}••••••••••••${suffix}`;
}
