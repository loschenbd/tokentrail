import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/dashboard/server.js';
import { _setSettingsDirForTest, writeSettings } from '../src/lib/settings.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'td-settings-'));
  _setSettingsDirForTest(tmp);
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); _setSettingsDirForTest(null); });

describe('dashboard /api/settings', () => {
  test('GET /api/settings returns defaults with no key', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.llm.openrouter.hasKey, false);
    assert.equal(body.llm.openrouter.keyTail, null);
    assert.equal(body.llm.backend, 'auto');
  });

  test('GET /api/settings masks API key with last-4 tail', async () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-v1-abcdefg1234', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
    });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = r.json();
    assert.equal(body.llm.openrouter.hasKey, true);
    assert.equal(body.llm.openrouter.keyTail, '1234');
    assert.equal(body.llm.openrouter.apiKey, undefined);
  });

  test('POST /api/settings persists', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        llm: {
          backend: 'ollama',
          openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
          ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
        },
      },
    });
    assert.equal(r.statusCode, 200);
    const r2 = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(r2.json().llm.backend, 'ollama');
    assert.equal(r2.json().llm.ollama.model, 'qwen2.5:7b');
  });

  test('POST /api/settings rejects malformed body', async () => {
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'POST', url: '/api/settings', payload: { llm: { backend: 'nonsense' } } });
    assert.equal(r.statusCode, 400);
  });
});
