import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listProviderModels } from '@/lib/agent/providers/list-models';
import { getConfig } from '@/lib/config';
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
      }
    }

    if (!resolvedKey) {
      return NextResponse.json(
        {
          error: `No API key found for ${provider}. Please enter your ${provider} API key to fetch actual models.`,
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
    });
  } catch (err: any) {
    const message = err.message || 'Failed to fetch models from provider';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
