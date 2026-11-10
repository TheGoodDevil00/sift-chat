import { z } from 'zod';
import path from 'path';
import type { SupportedProvider } from '@/types/chat';

export const LATEST_MODELS = {
  openai: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra (Default)', recommended: true },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (Deep Reasoning)' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (Balanced)' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Fast)' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Recommended)', recommended: true },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (High Capability)' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 (Fast)' },
    { id: 'claude-fable-5-2', name: 'Claude Fable 5.2 (Agentic Reasoning)' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (Recommended)', recommended: true },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite (Fast)' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
  ],
  deepseek: [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash (Recommended)', recommended: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (High Capability)' },
    { id: 'deepseek-chat', name: 'DeepSeek Chat (General)' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' },
  ],
  xai: [
    { id: 'grok-4.7', name: 'Grok 4.7 (Recommended)', recommended: true },
    { id: 'grok-4.7-latest', name: 'Grok 4.7 Latest' },
    { id: 'grok-3', name: 'Grok 3' },
  ],
  cohere: [
    { id: 'command-a-plus-05-2026', name: 'Command A+ (Recommended)', recommended: true },
    { id: 'command-a-03-2025', name: 'Command A (256k Context)' },
    { id: 'command-r7b-12-2024', name: 'Command R7B (Fast)' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile (Recommended)', recommended: true },
    { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B (Long Context)' },
  ],
  openrouter: [
    { id: 'openai/gpt-5.6-sol', name: 'OpenRouter: GPT-5.6 Sol', recommended: true },
    { id: 'anthropic/claude-sonnet-5-5', name: 'OpenRouter: Claude Sonnet 5.5' },
    { id: 'google/gemini-3.8-flash', name: 'OpenRouter: Gemini 3.8 Flash' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'OpenRouter: Llama 3.3 70B' },
  ],
} as const;

const ConfigSchema = z.object({
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().default('gpt-6-astra'),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),

  ANTHROPIC_API_KEY: z.string().optional().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),

  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  DEEPSEEK_API_KEY: z.string().optional().default(''),
  DEEPSEEK_MODEL: z.string().default('deepseek-flash'),

  XAI_API_KEY: z.string().optional().default(''),
  XAI_MODEL: z.string().default('grok-4.7'),

  COHERE_API_KEY: z.string().optional().default(''),
  COHERE_MODEL: z.string().default('command-a-plus-05-2026'),

  GROQ_API_KEY: z.string().optional().default(''),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  OPENROUTER_API_KEY: z.string().optional().default(''),
  OPENROUTER_MODEL: z.string().default('openai/gpt-5.6-sol'),

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
  if (cachedConfig) {
    return cachedConfig;
  }

  const raw = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
    OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-6-astra',
    OPENAI_REASONING_EFFORT: (process.env.OPENAI_REASONING_EFFORT as any) || 'medium',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    XAI_API_KEY: process.env.XAI_API_KEY || '',
    XAI_MODEL: process.env.XAI_MODEL || 'grok-4.7',
    COHERE_API_KEY: process.env.COHERE_API_KEY || '',
    COHERE_MODEL: process.env.COHERE_MODEL || 'command-a-plus-05-2026',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
    GROQ_MODEL: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'openai/gpt-5.6-sol',
    DATABASE_PATH: process.env.DATABASE_PATH || './data/sift.sqlite',
    PORT: process.env.PORT || 3000,
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('Configuration validation failed:', parsed.error.format());
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  const dbPath = path.isAbsolute(parsed.data.DATABASE_PATH)
    ? parsed.data.DATABASE_PATH
    : path.resolve(process.cwd(), parsed.data.DATABASE_PATH);

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
    availableModels: LATEST_MODELS,
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
