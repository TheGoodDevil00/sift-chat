'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SupportedProvider, ClientProviderConfig } from '@/types/chat';

export interface ProviderServerStatus {
  providers: Record<SupportedProvider, boolean>;
  hasAnyKey: boolean;
  defaultProvider: SupportedProvider;
  defaultModels?: Record<SupportedProvider, string>;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  description?: string;
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
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  cohere: 'Cohere',
  openrouter: 'OpenRouter',
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
  const [selectedModel, setSelectedModel] = useState<string>(activeConfig.model || '');
  const [apiKey, setApiKey] = useState<string>(activeConfig.apiKey || '');
  const [showKey, setShowKey] = useState(false);

  // Live model discovery states
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const hasServerKey = serverStatus?.providers[selectedProvider] ?? false;

  // Query the provider's /models endpoint to retrieve ACTUAL live data
  const fetchLiveModels = useCallback(
    async (prov: SupportedProvider, key: string) => {
      const trimmedKey = key.trim();
      const hasKeyAvailable = Boolean(trimmedKey || serverStatus?.providers[prov]);

      if (!hasKeyAvailable) {
        setModels([]);
        setFetchError(null);
        setWarning(null);
        return;
      }

      setIsLoadingModels(true);
      setFetchError(null);
      setWarning(null);

      try {
        const res = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: prov,
            apiKey: trimmedKey || undefined,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setFetchError(data.error || `Failed to fetch models from ${PROVIDER_NAMES[prov]}`);
          if (data.models && data.models.length > 0) {
            setModels(data.models);
          }
        } else {
          const returnedModels: DiscoveredModel[] = data.models || [];
          setModels(returnedModels);
          setWarning(data.warning || null);
          setFetchError(null);

          if (returnedModels.length > 0) {
            setSelectedModel((current) => {
              if (current && returnedModels.some((m) => m.id === current)) {
                return current;
              }
              return returnedModels[0].id;
            });
          }
        }
      } catch (err: any) {
        setFetchError(`Network error contacting ${PROVIDER_NAMES[prov]} models endpoint.`);
      } finally {
        setIsLoadingModels(false);
      }
    },
    [serverStatus]
  );

  // When modal opens or provider changes, load stored key & fetch actual models
  useEffect(() => {
    if (!isOpen) return;

    const prov = activeConfig.provider || 'openai';
    setSelectedProvider(prov);

    let keyToUse = activeConfig.apiKey || '';
    try {
      const stored = localStorage.getItem(`sift_key_${prov}`);
      if (stored) keyToUse = stored;
    } catch {}

    setApiKey(keyToUse);

    let modelToUse = activeConfig.model || '';
    try {
      const storedModel = localStorage.getItem(`sift_model_${prov}`);
      if (storedModel) modelToUse = storedModel;
    } catch {}
    setSelectedModel(modelToUse);

    fetchLiveModels(prov, keyToUse);
  }, [isOpen, activeConfig, fetchLiveModels]);

  if (!isOpen) return null;

  const handleProviderChange = (newProvider: SupportedProvider) => {
    setSelectedProvider(newProvider);
    setFetchError(null);
    setWarning(null);
    setModels([]);
    setIsCustomModel(false);

    let keyForNewProvider = '';
    try {
      keyForNewProvider = localStorage.getItem(`sift_key_${newProvider}`) || '';
    } catch {}
    setApiKey(keyForNewProvider);

    let storedModel = '';
    try {
      storedModel = localStorage.getItem(`sift_model_${newProvider}`) || '';
    } catch {}
    setSelectedModel(storedModel);

    fetchLiveModels(newProvider, keyForNewProvider);
  };

  const handleKeyChange = (newKey: string) => {
    setApiKey(newKey);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (newKey.trim().length > 5) {
      debounceTimerRef.current = setTimeout(() => {
        fetchLiveModels(selectedProvider, newKey);
      }, 700);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedKey = apiKey.trim();
    const finalModel = selectedModel.trim();

    try {
      if (trimmedKey) {
        localStorage.setItem(`sift_key_${selectedProvider}`, trimmedKey);
      }
      localStorage.setItem('sift_active_provider', selectedProvider);
      if (finalModel) {
        localStorage.setItem(`sift_model_${selectedProvider}`, finalModel);
      }
    } catch (err) {
      console.warn('LocalStorage save error:', err);
    }

    onSaveConfig({
      provider: selectedProvider,
      model: finalModel,
      apiKey: trimmedKey || undefined,
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
            {isSoftPrompt ? 'Setup Model Provider' : 'Provider & Live Models'}
          </h2>
        </div>

        {isSoftPrompt && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs leading-relaxed">
            <strong>Welcome to Sift!</strong> Select your model provider and enter your API
            key. Sift will query the provider directly to fetch your account&apos;s active models.
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
              <option value="groq">Groq (Ultra-Fast Inference)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="gemini">Google Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="xai">xAI (Grok)</option>
              <option value="cohere">Cohere</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </div>

          {/* 2. API Key Input */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase text-gray-600">
                {PROVIDER_NAMES[selectedProvider]} API Key:
              </label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="text-[11px] text-gray-500 hover:text-black underline cursor-pointer"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  onClick={() => fetchLiveModels(selectedProvider, apiKey)}
                  disabled={isLoadingModels}
                  className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold cursor-pointer disabled:opacity-50"
                >
                  {isLoadingModels ? 'Fetching...' : '↻ Fetch Models'}
                </button>
              </div>
            </div>
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder={
                hasServerKey
                  ? 'Server key detected (leave blank or enter custom key)'
                  : `Enter ${PROVIDER_NAMES[selectedProvider]} API key...`
              }
              className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
            />
            {hasServerKey && !apiKey.trim() ? (
              <div className="text-[11px] text-emerald-700 mt-1 flex items-center gap-1 font-sans">
                <span>✓</span>
                <span>Server environment key detected.</span>
              </div>
            ) : (
              <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1 font-sans">
                <span>🔒</span>
                <span>Stored strictly client-side in your browser. Never written to server disk or logs.</span>
              </div>
            )}
          </div>

          {/* 3. Live Model Selection (Actual Provider Data) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold uppercase text-gray-600">
                Active Model ({PROVIDER_NAMES[selectedProvider]}):
              </label>
              <button
                type="button"
                onClick={() => setIsCustomModel(!isCustomModel)}
                className="text-[11px] text-gray-500 hover:text-black underline cursor-pointer"
              >
                {isCustomModel ? 'Pick from List' : 'Enter Custom ID'}
              </button>
            </div>

            {/* Warning banner (e.g. timeout fallback notice) */}
            {warning && (
              <div className="mb-2 p-2 bg-amber-50 border border-amber-300 rounded text-amber-800 text-xs flex items-center justify-between">
                <span>⚠️ {warning}</span>
                <button
                  type="button"
                  onClick={() => fetchLiveModels(selectedProvider, apiKey)}
                  className="text-[11px] underline font-semibold ml-2 hover:text-amber-950"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Error banner (e.g. invalid key) */}
            {fetchError && (
              <div className="mb-2 p-2 bg-red-50 border border-red-300 rounded text-red-800 text-xs flex items-center justify-between">
                <span>✕ {fetchError}</span>
                <button
                  type="button"
                  onClick={() => fetchLiveModels(selectedProvider, apiKey)}
                  className="text-[11px] underline font-semibold ml-2 hover:text-red-950"
                >
                  Retry
                </button>
              </div>
            )}

            {isLoadingModels ? (
              <div className="w-full p-3 border-2 border-dashed border-orange-300 rounded bg-orange-50/50 text-orange-800 text-xs flex items-center gap-2">
                <span className="animate-spin inline-block">⏳</span>
                <span>Fetching live model list from {PROVIDER_NAMES[selectedProvider]} API...</span>
              </div>
            ) : isCustomModel ? (
              <input
                type="text"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                placeholder="Enter model ID manually (e.g. llama-3.1-70b-versatile)..."
                className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
              />
            ) : models.length > 0 ? (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none bg-white font-mono text-sm cursor-pointer"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  placeholder="Enter model ID manually (e.g. llama-3.1-70b-versatile)..."
                  className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
                />
                <div className="text-[11px] text-gray-500 italic">
                  Enter your {PROVIDER_NAMES[selectedProvider]} API key above to load available
                  models, or enter a model ID manually.
                </div>
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
              {isSoftPrompt ? 'Dismiss' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={!selectedModel.trim()}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded cursor-pointer shadow-sm"
            >
              Save in Browser
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
