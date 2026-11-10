import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listProviderModels, PROVIDER_FALLBACK_MODELS } from '@/lib/agent/providers/list-models';
import { getConfig } from '@/lib/config';
import { scrubSensitiveStrings } from '@/lib/crypto/scrub';
import type { SupportedProvider } from '@/types/chat';

export const dynamic = 'force-dynamic';

const RequestSchema = z.object({
  provider: z.enum([
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
  ]),
  apiKey: z.string().optional(),
  customBaseUrl: z.string().url().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request payload: ' + parsed.error.issues[0]?.message },
        { status: 400 }
      );
    }

    const { provider, apiKey, customBaseUrl } = parsed.data;

    // Resolve API key: client-passed in-memory key takes precedence, fallback to server env
    let resolvedKey = apiKey?.trim();
    if (!resolvedKey) {
      const serverConfig = getConfig();
      switch (provider) {
        case 'openai':
          resolvedKey = serverConfig.openaiApiKey;
          break;
        case 'anthropic':
          resolvedKey = serverConfig.anthropicApiKey;
          break;
        case 'gemini':
          resolvedKey = serverConfig.geminiApiKey;
          break;
        case 'deepseek':
          resolvedKey = serverConfig.deepseekApiKey;
          break;
        case 'xai':
          resolvedKey = serverConfig.xaiApiKey;
          break;
        case 'cohere':
          resolvedKey = serverConfig.cohereApiKey;
          break;
        case 'groq':
          resolvedKey = serverConfig.groqApiKey;
          break;
        case 'openrouter':
          resolvedKey = serverConfig.openrouterApiKey;
          break;
        case 'ollama':
          resolvedKey = 'ollama';
          break;
        case 'local':
          resolvedKey = 'local';
          break;
      }
    }

    // Local providers do not require an API key
    if (!resolvedKey && (provider === 'ollama' || provider === 'local')) {
      resolvedKey = provider;
    }

    if (!resolvedKey && provider !== 'openrouter') {
      return NextResponse.json(
        {
          error: `No API key found for ${provider}. Please enter your ${provider} API key to fetch models.`,
          models: PROVIDER_FALLBACK_MODELS[provider as SupportedProvider] || [],
        },
        { status: 400 }
      );
    }

    const result = await listProviderModels(
      provider as SupportedProvider,
      resolvedKey,
      customBaseUrl
    );

    return NextResponse.json({
      provider: result.provider,
      models: result.models,
      live: result.live,
      warning: result.warning,
    });
  } catch (err: any) {
    const rawMessage = err.message || err.cause?.message || 'Failed to fetch models from provider';
    const message = scrubSensitiveStrings(rawMessage);
    console.warn(`[POST /api/models] Provider error: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
