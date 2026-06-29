import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, writeSettings, settingsPath, _setSettingsDirForTest } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tokentrail-settings-'));
  _setSettingsDirForTest(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _setSettingsDirForTest(null);
});

describe('settings', () => {
  test('readSettings returns defaults when file missing', () => {
    const s = readSettings();
    assert.equal(s.llm.backend, 'auto');
    assert.equal(s.llm.openrouter.model, 'anthropic/claude-haiku-4.5');
    assert.equal(s.llm.ollama.model, 'qwen2.5:3b');
    assert.equal(s.llm.ollama.baseUrl, 'http://localhost:11434/v1');
    assert.equal(s.llm.openrouter.apiKey, null);
  });

  test('writeSettings persists and round-trips', () => {
    const next = {
      llm: {
        backend: 'ollama' as const,
        openrouter: { apiKey: 'sk-or-test', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
      },
    };
    writeSettings(next);
    const s = readSettings();
    assert.deepEqual(s, next);
  });

  test('writeSettings creates file with mode 0600', () => {
    writeSettings(readSettings());
    const p = settingsPath();
    assert.equal(existsSync(p), true);
    // On macOS/Linux check mode bits. Skip on Windows (stat.mode is fake).
    if (process.platform !== 'win32') {
      const mode = statSync(p).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  });

  test('writeSettings is atomic (temp file then rename)', () => {
    writeSettings(readSettings());
    const p = settingsPath();
    const stray = p + '.tmp';
    assert.equal(existsSync(stray), false, 'temp file should not survive');
  });

  test('readSettings on malformed JSON throws a clear error', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(settingsPath(), '{not json', 'utf8');
    assert.throws(() => readSettings(), /settings\.json.*invalid/i);
  });
});
