import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type LLMBackend = 'openrouter' | 'ollama' | 'none' | 'auto';

export type Settings = {
  llm: {
    backend: LLMBackend;
    openrouter: { apiKey: string | null; model: string };
    ollama: { baseUrl: string; model: string };
  };
  // Project name/repo/path substrings to hide from the dashboard and
  // menubar. Display-only: ingest, rollups, and detail-page deep links
  // are untouched, so removing an entry restores the project everywhere.
  hiddenProjects: string[];
};

const DEFAULTS: Settings = {
  llm: {
    backend: 'auto',
    openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
    ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
  },
  hiddenProjects: [],
};

let testDir: string | null = null;

/** Test hook — production code should never call this. */
export function _setSettingsDirForTest(dir: string | null): void {
  testDir = dir;
}

export function settingsDir(): string {
  if (testDir) return testDir;
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Tokentrail');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'tokentrail');
}

export function settingsPath(): string {
  return join(settingsDir(), 'settings.json');
}

export function readSettings(): Settings {
  const path = settingsPath();
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`settings.json unreadable at ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`settings.json invalid JSON at ${path}: ${(e as Error).message}`);
  }
  return mergeWithDefaults(parsed);
}

export function writeSettings(next: Settings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function mergeWithDefaults(parsed: unknown): Settings {
  const merged = structuredClone(DEFAULTS);
  if (!parsed || typeof parsed !== 'object') return merged;
  const llm = (parsed as { llm?: unknown }).llm;
  if (llm && typeof llm === 'object') {
    const l = llm as Record<string, unknown>;
    if (typeof l['backend'] === 'string' && ['openrouter', 'ollama', 'none', 'auto'].includes(l['backend'])) {
      merged.llm.backend = l['backend'] as LLMBackend;
    }
    const or = l['openrouter'];
    if (or && typeof or === 'object') {
      const o = or as Record<string, unknown>;
      if (typeof o['apiKey'] === 'string') merged.llm.openrouter.apiKey = o['apiKey'];
      if (typeof o['model'] === 'string') merged.llm.openrouter.model = o['model'];
    }
    const olla = l['ollama'];
    if (olla && typeof olla === 'object') {
      const o = olla as Record<string, unknown>;
      if (typeof o['baseUrl'] === 'string') merged.llm.ollama.baseUrl = o['baseUrl'];
      if (typeof o['model'] === 'string') merged.llm.ollama.model = o['model'];
    }
  }
  const hidden = (parsed as { hiddenProjects?: unknown }).hiddenProjects;
  if (Array.isArray(hidden)) {
    merged.hiddenProjects = hidden.filter(
      (p): p is string => typeof p === 'string' && p.trim().length > 0
    );
  }
  return merged;
}
