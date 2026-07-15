import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { buildServer } from '../src/dashboard/server.js';
import { _setSettingsDirForTest, writeSettings, readSettings } from '../src/lib/settings.js';
import { _setDbForTest } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrations.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

let tmp: string;
let testDb: DatabaseType.Database;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'td-settings-'));
  _setSettingsDirForTest(tmp);
  testDb = new Database(':memory:');
  runMigrations(testDb);
  _setDbForTest(testDb);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  _setSettingsDirForTest(null);
  _setDbForTest(null);
  testDb.close();
});

function seedRollup(db: DatabaseType.Database, featureKey: string, repo: string | null): void {
  db.prepare(`
    INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_cost_usd, sessions_count)
    VALUES (?, date('now', 'localtime'), ?, ?, ?, 5, 1)
  `).run(`seed-${featureKey}`, featureKey, featureKey, repo);
}

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
      hiddenProjects: [],
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

  test('POST /api/settings with apiKey: null clears a stored key', async () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-v1-abcdefg1234', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
      hiddenProjects: [],
    });
    const app = buildServer({ defaultDays: 30 });
    // Verify key is present before clearing.
    const before = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(before.json().llm.openrouter.hasKey, true);
    // POST with apiKey: null to clear.
    const r = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        llm: {
          backend: 'openrouter',
          openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
          ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
        },
      },
    });
    assert.equal(r.statusCode, 200);
    // Subsequent GET must report no key.
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.equal(after.json().llm.openrouter.hasKey, false);
    assert.equal(after.json().llm.openrouter.keyTail, null);
  });

  test('GET /api/settings includes keyTail for typed-confirm consumption', async () => {
    writeSettings({
      llm: {
        backend: 'openrouter',
        openrouter: { apiKey: 'sk-or-v1-XXXX5678', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
      hiddenProjects: [],
    });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = r.json();
    assert.equal(body.llm.openrouter.hasKey, true);
    assert.equal(body.llm.openrouter.keyTail, '5678');
    // The raw key must NOT be exposed.
    assert.equal(body.llm.openrouter.apiKey, undefined);
  });

  test('GET /api/settings includes hiddenProjects and the ledger project list', async () => {
    seedRollup(testDb, 'archi-homepage', 'loschenbd/archi');
    seedRollup(testDb, 'pmg-application-pack', 'loschenbd/job-search');
    writeSettings({ ...readSettings(), hiddenProjects: ['job-search'] });
    const app = buildServer({ defaultDays: 30 });
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.deepEqual(body.hiddenProjects, ['job-search']);
    const byName = Object.fromEntries(body.projects.map((p: { name: string; hidden: boolean }) => [p.name, p.hidden]));
    assert.equal(byName['archi'], false);
    assert.equal(byName['job-search'], true);
  });

  test('POST /api/settings with hiddenProjects only updates the list and preserves llm', async () => {
    writeSettings({
      llm: {
        backend: 'ollama',
        openrouter: { apiKey: 'sk-or-v1-keep1234', model: 'anthropic/claude-haiku-4.5' },
        ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
      },
      hiddenProjects: [],
    });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: { hiddenProjects: ['job-search', '  ', 42] },
    });
    assert.equal(r.statusCode, 200);
    const s = readSettings();
    assert.deepEqual(s.hiddenProjects, ['job-search']);
    assert.equal(s.llm.backend, 'ollama');
    assert.equal(s.llm.openrouter.apiKey, 'sk-or-v1-keep1234');
  });

  test('POST /api/settings with llm only preserves hiddenProjects', async () => {
    writeSettings({ ...readSettings(), hiddenProjects: ['job-search'] });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({
      method: 'POST',
      url: '/api/settings',
      payload: {
        llm: {
          backend: 'none',
          openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
          ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
        },
      },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(readSettings().hiddenProjects, ['job-search']);
    assert.equal(readSettings().llm.backend, 'none');
  });

  test('POST /api/settings rejects non-array hiddenProjects and empty updates', async () => {
    const app = buildServer({ defaultDays: 30 });
    const bad = await app.inject({ method: 'POST', url: '/api/settings', payload: { hiddenProjects: 'job-search' } });
    assert.equal(bad.statusCode, 400);
    const empty = await app.inject({ method: 'POST', url: '/api/settings', payload: {} });
    assert.equal(empty.statusCode, 400);
  });

  test('GET /settings HTML renders the hidden-projects section', async () => {
    seedRollup(testDb, 'archi-homepage', 'loschenbd/archi');
    writeSettings({ ...readSettings(), hiddenProjects: ['job-search'] });
    const app = buildServer({ defaultDays: 30 });
    const r = await app.inject({ method: 'GET', url: '/settings' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Hidden projects/);
    assert.match(r.body, /hidden-chip/);
    assert.match(r.body, /hide-project-select/);
  });

  test('POST /api/settings/test returns ok=false when backend is not configured', async () => {
    const prevOR = process.env.OPENROUTER_API_KEY;
    const prevBackend = process.env.TOKENTRAIL_LLM_BACKEND;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.TOKENTRAIL_LLM_BACKEND;
    try {
      writeSettings({
        llm: {
          backend: 'none',
          openrouter: { apiKey: null, model: 'anthropic/claude-haiku-4.5' },
          ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:3b' },
        },
        hiddenProjects: [],
      });
      const app = buildServer({ defaultDays: 30 });
      const r = await app.inject({
        method: 'POST',
        url: '/api/settings/test',
        payload: { backend: 'none' },
      });
      assert.equal(r.statusCode, 200);
      const body = r.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /not configured/i);
    } finally {
      if (prevOR !== undefined) process.env.OPENROUTER_API_KEY = prevOR;
      if (prevBackend !== undefined) process.env.TOKENTRAIL_LLM_BACKEND = prevBackend;
    }
  });
});
