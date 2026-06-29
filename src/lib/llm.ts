import OpenAI from 'openai';
import { readSettings, type LLMBackend, type Settings } from './settings.js';

export type LLMClient = {
  backend: 'openrouter' | 'ollama';
  model: string;
  client: OpenAI;
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function getLLMClient(): LLMClient | null {
  const settings = readSettings();
  const backend = resolveBackend(settings.llm.backend, settings);

  if (backend === 'openrouter') {
    const apiKey = process.env.OPENROUTER_API_KEY ?? settings.llm.openrouter.apiKey;
    if (!apiKey) return null;
    const model = process.env.OPENROUTER_MODEL ?? settings.llm.openrouter.model;
    return {
      backend: 'openrouter',
      model,
      client: new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL }),
    };
  }

  if (backend === 'ollama') {
    const baseURL = process.env.OLLAMA_BASE_URL ?? settings.llm.ollama.baseUrl;
    const model = process.env.OLLAMA_MODEL ?? settings.llm.ollama.model;
    return {
      backend: 'ollama',
      model,
      // Ollama's OpenAI-compatible endpoint ignores apiKey but the SDK
      // requires a non-empty string.
      client: new OpenAI({ apiKey: 'ollama', baseURL }),
    };
  }

  return null;
}

function resolveBackend(setting: LLMBackend, settings: Settings): 'openrouter' | 'ollama' | 'none' {
  const envOverride = process.env.TOKENTRAIL_LLM_BACKEND as LLMBackend | undefined;
  const choice = envOverride ?? setting;
  if (choice === 'openrouter' || choice === 'ollama') return choice;
  if (choice === 'none') return 'none';
  // auto: no network probe — pick openrouter if key set, else none.
  // Users wanting ollama must select it explicitly in settings.
  if (process.env.OPENROUTER_API_KEY || settings.llm.openrouter.apiKey) {
    return 'openrouter';
  }
  return 'none';
}
