'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SupportedProvider, ClientProviderConfig } from '@/types/chat';
import {
  saveProviderKey,
  getProviderKey,
  removeProviderKey,
  getVaultStatuses,
  migrateLegacyPlaintextKeys,
  type ProviderKeyStatus,
} from '@/lib/crypto/vault';
import { scrubSensitiveStrings } from '@/lib/crypto/scrub';

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

export const ALL_SUPPORTED_PROVIDERS: SupportedProvider[] = [
  'groq',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'xai',
  'cohere',
  'openrouter',
];

export const PROVIDER_LABELS: Record<SupportedProvider, string> = {
  groq: 'Groq',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  xai: 'xAI (Grok)',
  cohere: 'Cohere',
  openrouter: 'OpenRouter',
};

export const PROVIDER_DESCRIPTIONS: Record<SupportedProvider, string> = {
  groq: 'Ultra-fast Llama & DeepSeek inference',
  openai: 'GPT-4o, o1, o3-mini models',
  anthropic: 'Claude 3.5 Sonnet, Haiku, Opus',
  gemini: 'Gemini 2.0 Flash, 1.5 Pro',
  deepseek: 'DeepSeek V3 and R1 reasoning',
  xai: 'Grok 2 and Grok Beta models',
  cohere: 'Command R+ and Command R',
  openrouter: 'Universal multi-provider gateway',
};

export function ProviderSettingsModal({
  isOpen,
  onClose,
  serverStatus,
  activeConfig,
  onSaveConfig,
  isSoftPrompt = false,
}: ProviderSettingsModalProps) {
  // Navigation / Selection states
  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider>(
    activeConfig.provider || 'groq'
  );
  const [activeProvider, setActiveProvider] = useState<SupportedProvider>(
    activeConfig.provider || 'groq'
  );

  // Multi-provider key and model states (preserved across provider tab switches)
  const [vaultStatuses, setVaultStatuses] = useState<
    Record<SupportedProvider, ProviderKeyStatus>
  >({} as Record<SupportedProvider, ProviderKeyStatus>);

  const [pendingKeys, setPendingKeys] = useState<Partial<Record<SupportedProvider, string>>>({});
  const [pendingModels, setPendingModels] = useState<Partial<Record<SupportedProvider, string>>>({});
  const [showKeyMap, setShowKeyMap] = useState<Partial<Record<SupportedProvider, boolean>>>({});

  // Model discovery states
  const [modelsByProvider, setModelsByProvider] = useState<
    Partial<Record<SupportedProvider, DiscoveredModel[]>>
  >({});
  const [isLoadingModels, setIsLoadingModels] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Refresh vault statuses & run legacy migration when modal opens
  const refreshVault = useCallback(async () => {
    try {
      await migrateLegacyPlaintextKeys();
      const statuses = await getVaultStatuses();
      setVaultStatuses(statuses);
    } catch (err) {
      console.warn('Failed to inspect encrypted vault status:', err);
    }
  }, []);

  // Fetch live models directly from provider /models endpoint
  const fetchLiveModels = useCallback(
    async (prov: SupportedProvider, explicitKey?: string) => {
      const trimmedKey = explicitKey !== undefined ? explicitKey.trim() : (pendingKeys[prov] || '').trim();
      const hasDecrypted = await getProviderKey(prov);
      const effectiveKey = trimmedKey || hasDecrypted || '';
      const hasServerKey = serverStatus?.providers[prov] ?? false;

      if (!effectiveKey && !hasServerKey) {
        setModelsByProvider((prev) => ({ ...prev, [prov]: [] }));
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
            apiKey: effectiveKey || undefined,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          const errMsg = scrubSensitiveStrings(data.error || `Failed to fetch models from ${PROVIDER_LABELS[prov]}`);
          setFetchError(errMsg);
          if (data.models && data.models.length > 0) {
            setModelsByProvider((prev) => ({ ...prev, [prov]: data.models }));
          }
        } else {
          const returnedModels: DiscoveredModel[] = data.models || [];
          setModelsByProvider((prev) => ({ ...prev, [prov]: returnedModels }));
          setWarning(data.warning ? scrubSensitiveStrings(data.warning) : null);
          setFetchError(null);

          if (returnedModels.length > 0) {
            setPendingModels((prev) => {
              const current = prev[prov];
              if (current && returnedModels.some((m) => m.id === current)) {
                return prev;
              }
              return { ...prev, [prov]: returnedModels[0].id };
            });
          }
        }
      } catch (err: any) {
        setFetchError(`Network error contacting ${PROVIDER_LABELS[prov]} models endpoint.`);
      } finally {
        setIsLoadingModels(false);
      }
    },
    [pendingKeys, serverStatus]
  );

  // Initialize modal state on open
  useEffect(() => {
    if (!isOpen) return;

    const initialProv = activeConfig.provider || 'groq';
    setSelectedProvider(initialProv);
    setActiveProvider(initialProv);

    // Load stored models for all providers from localStorage
    const initialModels: Partial<Record<SupportedProvider, string>> = {};
    for (const p of ALL_SUPPORTED_PROVIDERS) {
      try {
        const stored = localStorage.getItem(`sift_model_${p}`);
        if (stored) {
          initialModels[p] = stored;
        } else if (p === activeConfig.provider && activeConfig.model) {
          initialModels[p] = activeConfig.model;
        }
      } catch {}
    }
    setPendingModels(initialModels);

    refreshVault().then(() => {
      fetchLiveModels(initialProv);
    });
  }, [isOpen, activeConfig, refreshVault, fetchLiveModels]);

  if (!isOpen) return null;

  const currentProviderStatus = vaultStatuses[selectedProvider];
  const hasServerKey = serverStatus?.providers[selectedProvider] ?? false;
  const currentKeyInput = pendingKeys[selectedProvider] ?? '';
  const isKeyConfigured = Boolean(currentProviderStatus?.isConfigured || hasServerKey);
  const showKey = showKeyMap[selectedProvider] ?? false;

  const handleSelectProvider = (prov: SupportedProvider) => {
    setSelectedProvider(prov);
    setFetchError(null);
    setWarning(null);
    setIsCustomModel(false);

    // Fetch models if not already fetched for this provider
    if (!modelsByProvider[prov]) {
      fetchLiveModels(prov);
    }
  };

  const handleKeyChange = (prov: SupportedProvider, newKey: string) => {
    setPendingKeys((prev) => ({ ...prev, [prov]: newKey }));

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (newKey.trim().length > 6) {
      debounceTimerRef.current = setTimeout(() => {
        fetchLiveModels(prov, newKey);
      }, 700);
    }
  };

  const handleRemoveKey = async (prov: SupportedProvider) => {
    if (!window.confirm(`Are you sure you want to remove your encrypted key for ${PROVIDER_LABELS[prov]}?`)) {
      return;
    }
    try {
      await removeProviderKey(prov);
      setPendingKeys((prev) => {
        const next = { ...prev };
        delete next[prov];
        return next;
      });
      await refreshVault();
      setModelsByProvider((prev) => ({ ...prev, [prov]: [] }));
    } catch (err) {
      console.warn('Failed to remove provider key:', err);
    }
  };

  const handleSaveAll = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      // 1. Encrypt and persist all modified provider keys
      for (const [prov, keyVal] of Object.entries(pendingKeys) as [SupportedProvider, string][]) {
        if (keyVal !== undefined) {
          const trimmed = keyVal.trim();
          if (trimmed) {
            await saveProviderKey(prov, trimmed);
          }
        }
      }

      // 2. Persist model selections
      for (const [prov, modelVal] of Object.entries(pendingModels) as [SupportedProvider, string][]) {
        if (modelVal && modelVal.trim()) {
          try {
            localStorage.setItem(`sift_model_${prov}`, modelVal.trim());
          } catch {}
        }
      }

      // 3. Persist active provider choice
      try {
        localStorage.setItem('sift_active_provider', activeProvider);
      } catch {}

      // 4. Resolve active provider config
      const activeDecryptedKey = await getProviderKey(activeProvider);
      const activeModel =
        pendingModels[activeProvider]?.trim() ||
        serverStatus?.defaultModels?.[activeProvider] ||
        '';

      onSaveConfig({
        provider: activeProvider,
        model: activeModel,
        apiKey: activeDecryptedKey || undefined,
      });

      onClose();
    } catch (err) {
      console.error('Failed to save provider settings:', err);
      setFetchError('Failed to save encrypted provider settings. Please check storage permissions.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-xs animate-pop-in">
      <div className="bg-white border-2 border-gray-300 rounded-lg shadow-2xl max-w-3xl w-full flex flex-col max-h-[90vh] text-sm font-mono overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-gray-50/70">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-orange-500 rounded-sm" />
            <h2 className="text-base font-bold uppercase tracking-wider text-gray-900">
              {isSoftPrompt ? 'Setup Research Providers' : 'Multi-Provider Keys & Models'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-black font-bold p-1 cursor-pointer transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>

        {isSoftPrompt && (
          <div className="mx-4 mt-3 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs leading-relaxed">
            <strong>Welcome to Sift!</strong> Add API keys for any providers you use.
            All keys are encrypted at rest with hardware-bound <strong>AES-GCM-256</strong>.
            You can configure multiple providers and switch between them anytime without losing your keys.
          </div>
        )}

        <form onSubmit={handleSaveAll} className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Provider List Navigation (Left Sidebar) */}
          <div className="w-full md:w-56 border-b md:border-b-0 md:border-r border-gray-200 bg-gray-50/50 p-2 overflow-y-auto shrink-0 flex md:flex-col gap-1">
            <div className="hidden md:block px-2 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
              Providers
            </div>
            {ALL_SUPPORTED_PROVIDERS.map((p) => {
              const status = vaultStatuses[p];
              const hasServKey = serverStatus?.providers[p] ?? false;
              const isSelected = selectedProvider === p;
              const isActive = activeProvider === p;
              const isConfigured = Boolean(status?.isConfigured || hasServKey || pendingKeys[p]);

              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleSelectProvider(p)}
                  className={`w-full text-left px-3 py-2 rounded text-xs flex items-center justify-between cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-white border-2 border-orange-500 font-bold text-gray-950 shadow-xs'
                      : 'border border-transparent hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <div className="flex flex-col">
                    <span className="font-semibold">{PROVIDER_LABELS[p]}</span>
                    <span className="text-[10px] text-gray-400 font-normal">
                      {isConfigured ? (
                        <span className="text-emerald-700 flex items-center gap-1">
                          <span>●</span>
                          <span>{hasServKey && !status?.isConfigured ? 'Server' : 'Encrypted'}</span>
                        </span>
                      ) : (
                        <span className="text-gray-400">○ Not set</span>
                      )}
                    </span>
                  </div>
                  {isActive && (
                    <span
                      className="px-1.5 py-0.5 text-[9px] bg-orange-100 text-orange-800 border border-orange-300 rounded font-bold uppercase tracking-wider"
                      title="Currently active provider for chat"
                    >
                      Active
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Provider Details & Configuration Panel (Right Pane) */}
          <div className="flex-1 p-4 md:p-6 overflow-y-auto space-y-4">
            {/* Active Provider Status Banner */}
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <div>
                <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <span>{PROVIDER_LABELS[selectedProvider]}</span>
                  {activeProvider === selectedProvider ? (
                    <span className="text-[10px] px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded font-semibold">
                      ✓ Active for Research
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-400 font-normal">
                      Inactive
                    </span>
                  )}
                </h3>
                <p className="text-xs text-gray-500 font-sans mt-0.5">
                  {PROVIDER_DESCRIPTIONS[selectedProvider]}
                </p>
              </div>

              {activeProvider !== selectedProvider && (
                <button
                  type="button"
                  onClick={() => setActiveProvider(selectedProvider)}
                  className="px-2.5 py-1 text-xs border border-orange-300 bg-orange-50 hover:bg-orange-100 text-orange-800 rounded font-medium cursor-pointer transition-colors"
                >
                  Set as Active
                </button>
              )}
            </div>

            {/* API Key Input Section */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase text-gray-700">
                  {PROVIDER_LABELS[selectedProvider]} API Key:
                </label>
                <div className="flex items-center gap-3">
                  {currentKeyInput && (
                    <button
                      type="button"
                      onClick={() =>
                        setShowKeyMap((prev) => ({
                          ...prev,
                          [selectedProvider]: !showKey,
                        }))
                      }
                      className="text-[11px] text-gray-500 hover:text-black underline cursor-pointer"
                    >
                      {showKey ? 'Hide' : 'Show'}
                    </button>
                  )}
                  {currentProviderStatus?.isConfigured && !currentKeyInput && (
                    <button
                      type="button"
                      onClick={() => handleRemoveKey(selectedProvider)}
                      className="text-[11px] text-red-600 hover:text-red-800 underline cursor-pointer"
                      title="Eradicate this provider's key from the encrypted vault"
                    >
                      Remove Key
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => fetchLiveModels(selectedProvider)}
                    disabled={isLoadingModels || (!isKeyConfigured && !currentKeyInput)}
                    className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold cursor-pointer disabled:opacity-50"
                  >
                    {isLoadingModels ? 'Fetching...' : '↻ Refresh Models'}
                  </button>
                </div>
              </div>

              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck="false"
                  value={currentKeyInput}
                  onChange={(e) => handleKeyChange(selectedProvider, e.target.value)}
                  placeholder={
                    currentProviderStatus?.isConfigured
                      ? `Encrypted in browser (${currentProviderStatus.fingerprint}) — enter new key to replace`
                      : hasServerKey
                      ? 'Server environment key active (enter key to override)'
                      : `Enter ${PROVIDER_LABELS[selectedProvider]} API key...`
                  }
                  className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm bg-white"
                />
              </div>

              {/* Security & Encryption Status Badges */}
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                {currentProviderStatus?.isConfigured && !currentKeyInput ? (
                  <span className="text-emerald-700 flex items-center gap-1 font-sans">
                    <span>🔒</span>
                    <span>
                      AES-GCM-256 encrypted in browser vault (<strong>{currentProviderStatus.fingerprint}</strong>)
                    </span>
                  </span>
                ) : hasServerKey && !currentKeyInput ? (
                  <span className="text-blue-700 flex items-center gap-1 font-sans">
                    <span>✓</span>
                    <span>Server environment key detected.</span>
                  </span>
                ) : (
                  <span className="text-gray-500 flex items-center gap-1 font-sans">
                    <span>🛡️</span>
                    <span>
                      Keys are encrypted at rest with hardware-bound AES-GCM-256. Never sent unencrypted or written to server logs.
                    </span>
                  </span>
                )}
              </div>
            </div>

            {/* Live Model Selection (Actual Provider Data) */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase text-gray-700">
                  Active Model ({PROVIDER_LABELS[selectedProvider]}):
                </label>
                <button
                  type="button"
                  onClick={() => setIsCustomModel(!isCustomModel)}
                  className="text-[11px] text-gray-500 hover:text-black underline cursor-pointer"
                >
                  {isCustomModel ? 'Pick from List' : 'Enter Custom Model ID'}
                </button>
              </div>

              {/* Warning Banner */}
              {warning && (
                <div className="mb-2 p-2 bg-amber-50 border border-amber-300 rounded text-amber-800 text-xs flex items-center justify-between">
                  <span>⚠️ {warning}</span>
                  <button
                    type="button"
                    onClick={() => fetchLiveModels(selectedProvider)}
                    className="text-[11px] underline font-semibold ml-2 hover:text-amber-950"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Error Banner */}
              {fetchError && (
                <div className="mb-2 p-2 bg-red-50 border border-red-300 rounded text-red-800 text-xs flex items-center justify-between">
                  <span>✕ {fetchError}</span>
                  <button
                    type="button"
                    onClick={() => fetchLiveModels(selectedProvider)}
                    className="text-[11px] underline font-semibold ml-2 hover:text-red-950"
                  >
                    Retry
                  </button>
                </div>
              )}

              {isLoadingModels ? (
                <div className="w-full p-3 border-2 border-dashed border-orange-300 rounded bg-orange-50/50 text-orange-800 text-xs flex items-center gap-2">
                  <span className="animate-spin inline-block">⏳</span>
                  <span>Fetching live models from {PROVIDER_LABELS[selectedProvider]} API...</span>
                </div>
              ) : isCustomModel ? (
                <input
                  type="text"
                  value={pendingModels[selectedProvider] || ''}
                  onChange={(e) =>
                    setPendingModels((prev) => ({
                      ...prev,
                      [selectedProvider]: e.target.value,
                    }))
                  }
                  placeholder="Enter model ID manually (e.g. llama-3.1-70b-versatile)..."
                  className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
                />
              ) : (modelsByProvider[selectedProvider] || []).length > 0 ? (
                <select
                  value={pendingModels[selectedProvider] || ''}
                  onChange={(e) =>
                    setPendingModels((prev) => ({
                      ...prev,
                      [selectedProvider]: e.target.value,
                    }))
                  }
                  className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none bg-white font-mono text-sm cursor-pointer"
                >
                  {(modelsByProvider[selectedProvider] || []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={pendingModels[selectedProvider] || ''}
                    onChange={(e) =>
                      setPendingModels((prev) => ({
                        ...prev,
                        [selectedProvider]: e.target.value,
                      }))
                    }
                    placeholder="Enter model ID manually..."
                    className="w-full p-2.5 border-2 border-gray-300 rounded focus:border-orange-500 focus:outline-none font-mono text-sm"
                  />
                  <div className="text-[11px] text-gray-500 italic">
                    Enter an API key above to load live models for {PROVIDER_LABELS[selectedProvider]}, or enter a custom model ID.
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>

        {/* Modal Footer */}
        <div className="p-4 border-t border-gray-200 bg-gray-50/70 flex items-center justify-between">
          <div className="text-xs text-gray-500 hidden sm:block">
            Active Provider:{' '}
            <strong className="text-gray-900 font-mono uppercase">
              {PROVIDER_LABELS[activeProvider]}
            </strong>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-100 text-gray-700 cursor-pointer text-xs uppercase tracking-wider font-semibold"
            >
              {isSoftPrompt ? 'Dismiss' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={isSaving}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded cursor-pointer shadow-sm text-xs uppercase tracking-wider flex items-center gap-1.5"
            >
              {isSaving ? 'Encrypting & Saving...' : 'Save All in Browser'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
