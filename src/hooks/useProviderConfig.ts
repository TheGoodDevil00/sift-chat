import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  SupportedProvider,
  ClientProviderConfig,
} from '@/types/chat';
import type { ProviderServerStatus } from '@/components/ProviderSettingsModal';
import {
  getProviderKey,
  getVaultStatuses,
  migrateLegacyPlaintextKeys,
  type ProviderKeyStatus,
} from '@/lib/crypto/vault';

export function useProviderConfig() {
  const [providerConfig, setProviderConfig] = useState<ClientProviderConfig>({
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  });
  const [serverStatus, setServerStatus] = useState<ProviderServerStatus | null>(null);
  const [vaultStatuses, setVaultStatuses] = useState<
    Record<SupportedProvider, ProviderKeyStatus>
  >({} as Record<SupportedProvider, ProviderKeyStatus>);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
  const [isSoftPrompt, setIsSoftPrompt] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement>(null);

  // Close provider menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        providerMenuRef.current &&
        !providerMenuRef.current.contains(event.target as Node)
      ) {
        setIsProviderMenuOpen(false);
      }
    }
    if (isProviderMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isProviderMenuOpen]);

  // Fetch server provider & env status on mount, migrate legacy keys, initialize encrypted vault
  useEffect(() => {
    async function initConfig() {
      try {
        await migrateLegacyPlaintextKeys();
        const initialVaultStatuses = await getVaultStatuses();
        setVaultStatuses(initialVaultStatuses);

        const res = await fetch('/api/config');
        if (res.ok) {
          const data: ProviderServerStatus = await res.json();
          setServerStatus(data);

          const savedProvider =
            (localStorage.getItem('sift_active_provider') as SupportedProvider) ||
            data.defaultProvider ||
            'groq';
          const savedModel =
            localStorage.getItem(`sift_model_${savedProvider}`) ||
            data.defaultModels?.[savedProvider] ||
            '';
          const savedKey = await getProviderKey(savedProvider);
          const savedBaseUrl =
            localStorage.getItem(`sift_base_url_${savedProvider}`) ||
            (savedProvider === 'ollama'
              ? 'http://localhost:11434/v1'
              : savedProvider === 'local'
              ? 'http://localhost:1234/v1'
              : undefined);

          const restoredConfig: ClientProviderConfig = {
            provider: savedProvider,
            model: savedModel,
            apiKey:
              savedKey ||
              (savedProvider === 'ollama' || savedProvider === 'local'
                ? savedProvider
                : undefined),
            customBaseUrl: savedBaseUrl,
          };
          setProviderConfig(restoredConfig);

          const hasAnyVaultKey = Object.values(initialVaultStatuses).some(
            (v) => v.isConfigured
          );
          const hasDismissed = sessionStorage.getItem('sift_soft_prompt_dismissed') === 'true';

          if (!data.hasAnyKey && !hasAnyVaultKey && !hasDismissed) {
            setIsSoftPrompt(true);
            setIsSettingsOpen(true);
          }
        }
      } catch (err) {
        console.warn('Failed to load server config status:', err);
      }
    }
    initConfig();
  }, []);

  const handleQuickSwitchProvider = useCallback(
    async (newProv: SupportedProvider) => {
      try {
        localStorage.setItem('sift_active_provider', newProv);
      } catch {}

      const key = await getProviderKey(newProv);
      const model =
        localStorage.getItem(`sift_model_${newProv}`) ||
        serverStatus?.defaultModels?.[newProv] ||
        (newProv === 'ollama' ? 'my-custom-model:latest' : newProv === 'local' ? 'local-model' : '');

      const customBaseUrl =
        localStorage.getItem(`sift_base_url_${newProv}`) ||
        (newProv === 'ollama'
          ? 'http://localhost:11434/v1'
          : newProv === 'local'
          ? 'http://localhost:1234/v1'
          : undefined);

      setProviderConfig({
        provider: newProv,
        model,
        apiKey:
          key ||
          (newProv === 'ollama' || newProv === 'local' ? newProv : undefined),
        customBaseUrl,
      });
      setIsProviderMenuOpen(false);
    },
    [serverStatus]
  );

  const handleSaveProviderConfig = useCallback(
    async (newConfig: ClientProviderConfig) => {
      setProviderConfig(newConfig);
      try {
        const refreshedStatuses = await getVaultStatuses();
        setVaultStatuses(refreshedStatuses);
      } catch (err) {
        console.warn('Failed to refresh vault statuses after save:', err);
      }
    },
    []
  );

  return {
    providerConfig,
    setProviderConfig,
    serverStatus,
    vaultStatuses,
    isSettingsOpen,
    setIsSettingsOpen,
    isProviderMenuOpen,
    setIsProviderMenuOpen,
    isSoftPrompt,
    setIsSoftPrompt,
    providerMenuRef,
    handleQuickSwitchProvider,
    handleSaveProviderConfig,
  };
}
