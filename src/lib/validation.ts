import { z } from 'zod';
import type { ChatRequest } from '@/types/chat';

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(tz?: string | null): string {
  if (tz && isValidIanaTimezone(tz)) {
    return tz;
  }
  return 'UTC';
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ClientProviderConfigSchema = z.object({
  provider: z
    .enum([
      'openai',
      'anthropic',
      'gemini',
      'deepseek',
      'xai',
      'cohere',
      'groq',
      'openrouter',
      'ollama',
      'local',
    ])
    .default('openai'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  customBaseUrl: z.string().optional(),
});

export const ChatRequestSchema = z.object({
  conversationId: z
    .string()
    .nullable()
    .optional()
    .refine((val) => !val || uuidRegex.test(val), {
      message: 'conversationId must be a valid UUID or null',
    }),
  message: z
    .string({ required_error: 'message is required' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'message must not be empty' })
    .refine((s) => s.length <= 12000, { message: 'message must not exceed 12,000 characters' }),
  timezone: z.string().optional().default('UTC'),
  clientRequestId: z
    .string({ required_error: 'clientRequestId is required' })
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'clientRequestId must not be empty' }),
  providerConfig: ClientProviderConfigSchema.optional(),
});

export function validateChatRequest(body: unknown): {
  success: true;
  data: ChatRequest;
} | {
  success: false;
  error: string;
} {
  const result = ChatRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      success: false,
      error: issue ? issue.message : 'Invalid request payload',
    };
  }

  const tz = normalizeTimezone(result.data.timezone);

  return {
    success: true,
    data: {
      conversationId: result.data.conversationId || null,
      message: result.data.message,
      timezone: tz,
      clientRequestId: result.data.clientRequestId,
      providerConfig: result.data.providerConfig
        ? {
            provider: result.data.providerConfig.provider,
            model: result.data.providerConfig.model || '',
            apiKey: result.data.providerConfig.apiKey?.trim(),
            customBaseUrl: result.data.providerConfig.customBaseUrl?.trim(),
          }
        : undefined,
    },
  };
}
