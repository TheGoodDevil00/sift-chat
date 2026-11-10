'use client';

import React, { useState, useEffect } from 'react';
import type { SupportedProvider, ClientProviderConfig } from '@/types/chat';

export interface ProviderServerStatus {
  providers: Record<SupportedProvider, boolean>;
  hasAnyKey: boolean;
  defaultProvider: SupportedProvider;
  availableModels: Record<SupportedProvider, Array<{ id: string; name: string; recommended?: boolean }>>;
}

interface ProviderSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverStatus: ProviderServerStatus | null;
  activeConfig: ClientProviderConfig;
  onSaveConfig: (config: ClientProviderConfig) => void;
  isSoftPrompt?: boolean;
}

const PROVIDER_NAMES: Record<SupportedProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  cohere: 'Cohere',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};

const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  openai: 'gpt-6-astra',
  anthropic: 'claude-sonnet-5-5',
  gemini: 'gemini-3.8-flash',
  deepseek: 'deepseek-flash',
  xai: 'grok-4.7',
  cohere: 'command-a-plus-05-2026',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-5.6-sol',
};

export function ProviderSettingsModal({
  isOpen,
  onClose,
  serverStatus,
  activeConfig,
  onSaveConfig,
  isSoftPrompt = false,
}: ProviderSettingsModalProps) {
  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider>(
    activeConfig.provider || 'openai'
  );
  const [selectedModel, setSelectedModel] = useState<string>(
    activeConfig.model || DEFAULT_MODELS[selectedProvider]
  );
  const [apiKey, setApiKey] = useState<string>(activeConfig.apiKey || '');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const prov = activeConfig.provider || 'openai';
      setSelectedProvider(prov);
      setSelectedModel(activeConfig.model || DEFAULT_MODELS[prov]);
      setApiKey(activeConfig.apiKey || '');
    }
  }, [isOpen, activeConfig]);

  if (!isOpen) return null;

  const hasServerKey = serverStatus?.providers[selectedProvider] ?? false;
  const availableModels = serverStatus?.availableModels[selectedProvider] || [];

  const handleProviderChange = (newProvider: SupportedProvider) => {
    setSelectedProvider(newProvider);
    setSelectedModel(DEFAULT_MODELS[newProvider]);
    try {
      const stored = localStorage.getItem(`sift_key_${newProvider}`);
      setApiKey(stored || '');
    } catch {
      setApiKey('');
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    try {
      if (apiKey.trim()) {
        localStorage.setItem(`sift_key_${selectedProvider}`, apiKey.trim());
      }
      localStorage.setItem('sift_active_provider', selectedProvider);
      localStorage.setItem(`sift_model_${selectedProvider}`, selectedModel);
    } catch (err) {
      console.warn('LocalStorage error:', err);
    }

    onSaveConfig({
      provider: selectedProvider,
      model: selectedModel,
      apiKey: apiKey.trim() || undefined,
    });

    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-pop-in">
      <div className="bg-white border-2 border-gray-300 rounded-lg shadow-xl max-w-lg w-full p-6 text-sm font-mono relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-black font-bold p-1 cursor-pointer"
          title="Close"
        >
          ✕
        </button>

        <div className="flex items-center gap-2 mb-3">
          <span className="w-2.5 h-2.5 bg-orange-500 rounded-sm" />
          <h2 className="text-base font-bold uppercase tracking-wider">
            {isSoftPrompt ? 'Setup Model Provider' : 'Provider & Model Settings'}
          </h2>
        </div>

        {isSoftPrompt && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs leading-relaxed">
            <strong>Welcome to Sift!</strong> No API keys were detected in your server
            environment. Configure your provider and key below to begin, or close this if
            you prefer setting up your <code>.env</code> file manually.
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4">
          {/* 1. Provider Dropdown */}
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-600 mb-1">
              Model Provider:
            </label>
            <select
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value as SupportedProvider)}
              className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none bg-white font-mono text-sm cursor-pointer"
            >
              <option value="openai">OpenAI (Responses API + built-in search)</option>
              <option value="anthropic">Anthropic Claude (Sonnet 5.5 / Opus 5.5)</option>
              <option value="gemini">Google Gemini (Gemini 3.8 Flash + Google Grounding)</option>
              <option value="deepseek">DeepSeek (DeepSeek V4.1 Flash / V4 Pro)</option>
              <option value="xai">xAI (Grok 4.7 / Grok 3)</option>
              <option value="cohere">Cohere (Command A+ / Command A)</option>
              <option value="groq">Groq (Llama 3.3 70B Ultra-Fast)</option>
              <option value="openrouter">OpenRouter (Multi-Model Gateway)</option>
            </select>
          </div>

          {/* 2. Model Selection */}
          <div>
            <label className="block text-xs font-semibold uppercase text-gray-600 mb-1">
              Model (Latest 2026 Models):
            </label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none bg-white font-mono text-sm cursor-pointer"
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
          </div>

          {/* 3. API Key Input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase text-gray-600">
                {PROVIDER_NAMES[selectedProvider]} API Key:
              </label>
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="text-[11px] text-gray-500 hover:text-black underline cursor-pointer"
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                hasServerKey
                  ? 'Server key detected (leave blank to use server key)'
                  : `Enter ${PROVIDER_NAMES[selectedProvider]} API key...`
              }
              className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
            />
            {hasServerKey ? (
              <div className="text-[11px] text-emerald-700 mt-1 flex items-center gap-1 font-sans">
                <span>✓</span>
                <span>Server environment key detected. You can leave this blank to use the server key.</span>
              </div>
            ) : (
              <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1 font-sans">
                <span>🔒</span>
                <span>Stored strictly in your browser. Never written to server disk or logs.</span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="pt-2 flex items-center justify-end gap-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-100 text-gray-700 cursor-pointer"
            >
              {isSoftPrompt ? 'Dismiss for now' : 'Cancel'}
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded cursor-pointer shadow-sm"
            >
              Save in Browser
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
