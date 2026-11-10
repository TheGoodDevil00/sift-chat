import { z } from 'zod';
import path from 'path';
import type { SupportedProvider } from '@/types/chat';

const ConfigSchema = z.object({
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().optional().default(''),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().optional().default(''),

  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().optional().default(''),

  DEEPSEEK_API_KEY: z.string().optional().default(''),
  DEEPSEEK_MODEL: z.string().optional().default(''),

  XAI_API_KEY: z.string().optional().default(''),
  XAI_MODEL: z.string().optional().default(''),

  COHERE_API_KEY: z.string().optional().default(''),
  COHERE_MODEL: z.string().optional().default(''),

  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().optional().default(''),

  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODEL: z.string().optional().default(''),

  DATABASE_PATH: z.string().default('./data/sift.sqlite'),
  PORT: z.coerce.number().default(3000),
});

export type AppConfig = {
  openaiApiKey: string;
  openaiModel: string;
  openaiReasoningEffort: 'low' | 'medium' | 'high';
  anthropicApiKey: string;
  anthropicModel: string;
  geminiApiKey: string;
  geminiModel: string;
  deepseekApiKey: string;
  deepseekModel: string;
  xaiApiKey: string;
  xaiModel: string;
  cohereApiKey: string;
  cohereModel: string;
  groqApiKey: string;
  groqModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  databasePath: string;
  port: number;
};

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const raw = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || '',
    OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT || 'medium',

    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || '',

    GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || '',

    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || '',

    XAI_API_KEY: process.env.XAI_API_KEY || '',
    XAI_MODEL: process.env.XAI_MODEL || '',

    COHERE_API_KEY: process.env.COHERE_API_KEY || '',
    COHERE_MODEL: process.env.COHERE_MODEL || '',

    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    GROQ_MODEL: process.env.GROQ_MODEL || '',

    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || '',

    DATABASE_PATH: process.env.DATABASE_PATH || './data/sift.sqlite',
    PORT: process.env.PORT || 3000,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Invalid configuration:', parsed.error.format());
    throw new Error('Application configuration validation failed');
  }

  const dbPath = path.isAbsolute(parsed.data.DATABASE_PATH)
    ? parsed.data.DATABASE_PATH
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), parsed.data.DATABASE_PATH);

  cachedConfig = {
    openaiApiKey: parsed.data.OPENAI_API_KEY.trim(),
    openaiModel: parsed.data.OPENAI_MODEL.trim(),
    openaiReasoningEffort: parsed.data.OPENAI_REASONING_EFFORT,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY.trim(),
    anthropicModel: parsed.data.ANTHROPIC_MODEL.trim(),
    geminiApiKey: parsed.data.GEMINI_API_KEY.trim(),
    geminiModel: parsed.data.GEMINI_MODEL.trim(),
    deepseekApiKey: parsed.data.DEEPSEEK_API_KEY.trim(),
    deepseekModel: parsed.data.DEEPSEEK_MODEL.trim(),
    xaiApiKey: parsed.data.XAI_API_KEY.trim(),
    xaiModel: parsed.data.XAI_MODEL.trim(),
    cohereApiKey: parsed.data.COHERE_API_KEY.trim(),
    cohereModel: parsed.data.COHERE_MODEL.trim(),
    groqApiKey: parsed.data.GROQ_API_KEY.trim(),
    groqModel: parsed.data.GROQ_MODEL.trim(),
    openrouterApiKey: parsed.data.OPENROUTER_API_KEY.trim(),
    openrouterModel: parsed.data.OPENROUTER_MODEL.trim(),
    databasePath: dbPath,
    port: parsed.data.PORT,
  };

  return cachedConfig;
}

export function getPublicConfigSummary() {
  const config = getConfig();
  const hasOpenAi = Boolean(config.openaiApiKey);
  const hasAnthropic = Boolean(config.anthropicApiKey);
  const hasGemini = Boolean(config.geminiApiKey);
  const hasDeepSeek = Boolean(config.deepseekApiKey);
  const hasXai = Boolean(config.xaiApiKey);
  const hasCohere = Boolean(config.cohereApiKey);
  const hasGroq = Boolean(config.groqApiKey);
  const hasOpenRouter = Boolean(config.openrouterApiKey);

  const hasAnyKey =
    hasOpenAi ||
    hasAnthropic ||
    hasGemini ||
    hasDeepSeek ||
    hasXai ||
    hasCohere ||
    hasGroq ||
    hasOpenRouter;

  let defaultProvider: SupportedProvider = 'openai';
  if (hasAnthropic && !hasOpenAi) defaultProvider = 'anthropic';
  else if (hasGemini && !hasOpenAi) defaultProvider = 'gemini';
  else if (hasDeepSeek && !hasOpenAi) defaultProvider = 'deepseek';
  else if (hasXai && !hasOpenAi) defaultProvider = 'xai';
  else if (hasCohere && !hasOpenAi) defaultProvider = 'cohere';
  else if (hasGroq && !hasOpenAi) defaultProvider = 'groq';
  else if (hasOpenRouter && !hasOpenAi) defaultProvider = 'openrouter';

  return {
    providers: {
      openai: hasOpenAi,
      anthropic: hasAnthropic,
      gemini: hasGemini,
      deepseek: hasDeepSeek,
      xai: hasXai,
      cohere: hasCohere,
      groq: hasGroq,
      openrouter: hasOpenRouter,
    },
    hasAnyKey,
    defaultProvider,
    defaultModels: {
      openai: config.openaiModel,
      anthropic: config.anthropicModel,
      gemini: config.geminiModel,
      deepseek: config.deepseekModel,
      xai: config.xaiModel,
      cohere: config.cohereModel,
      groq: config.groqModel,
      openrouter: config.openrouterModel,
    },
  };
}

export function hasOpenAiKey(): boolean {
  const config = getConfig();
  return Boolean(config.openaiApiKey && config.openaiApiKey.length > 0);
}
