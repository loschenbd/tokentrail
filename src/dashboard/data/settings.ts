import { readSettings } from '../../lib/settings.js';

export type SettingsViewModel = {
  llm: {
    backend: string;
    openrouter: { hasKey: boolean; keyTail: string | null; model: string };
    ollama: { baseUrl: string; model: string };
  };
};

export function buildSettingsVM(): SettingsViewModel {
  const s = readSettings();
  const key = s.llm.openrouter.apiKey ?? null;
  return {
    llm: {
      backend: s.llm.backend,
      openrouter: {
        hasKey: !!key,
        keyTail: key ? key.slice(-4) : null,
        model: s.llm.openrouter.model,
      },
      ollama: { baseUrl: s.llm.ollama.baseUrl, model: s.llm.ollama.model },
    },
  };
}
