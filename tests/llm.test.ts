import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLLMClient } from '../src/lib/llm.js';
import { _setSettingsDirForTest, writeSettings } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tokentrail-llm-'));
  _setSettingsDirForTest(tmp);
  delete process.env.TOKENTRAIL_LLM_BACKEND;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _setSettingsDirForTest(null);
});

describe('getLLMClient()', () => {
  test('backend=none returns null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'none';
    assert.equal(getLLMClient(), null);
  });

  test('backend=openrouter without API key returns null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    assert.equal(getLLMClient(), null);
  });

  test('backend=openrouter with env API key returns OpenAI client', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
    assert.equal(c?.model, 'anthropic/claude-haiku-4.5');
  });

  test('backend=openrouter with settings.json API key returns client', () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-from-file', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
    });
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
  });

  test('backend=ollama returns client without contacting network', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'ollama';
    const c = getLLMClient();
    assert.equal(c?.backend, 'ollama');
    assert.equal(c?.model, 'qwen2.5:3b');
  });

  test('auto with openrouter key set → openrouter', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const c = getLLMClient();
    assert.equal(c?.backend, 'openrouter');
  });

  test('auto with no key → null', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'auto';
    assert.equal(getLLMClient(), null);
  });

  test('env OPENROUTER_MODEL override respected', () => {
    process.env.TOKENTRAIL_LLM_BACKEND = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENROUTER_MODEL = 'anthropic/claude-sonnet-4-6';
    assert.equal(getLLMClient()?.model, 'anthropic/claude-sonnet-4-6');
  });
});
