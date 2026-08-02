import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { buildSettingsVM } from '../src/dashboard/data/settings.js';
import { saveBudgetConfig, resetConfigCache } from '../src/lib/config.js';
import { buildServer } from '../src/dashboard/server.js';
import { _setDbForTest } from '../src/db/db.js';
import { _setSettingsDirForTest } from '../src/lib/settings.js';
import { runMigrations } from '../src/db/migrations.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

let dir: string, cfg: string;
const prev = process.env.TOKENTRAIL_CONFIG;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tt-set-')); cfg = join(dir, 'config.json');
  process.env.TOKENTRAIL_CONFIG = cfg; resetConfigCache(); });
afterEach(() => { if (prev === undefined) delete process.env.TOKENTRAIL_CONFIG; else process.env.TOKENTRAIL_CONFIG = prev;
  resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

test('settings VM pre-fills budget values from config', () => {
  writeFileSync(cfg, JSON.stringify({ monthlyBudgetUsd: 200, budgetCycleStartDay: 5, sourceBudgets: { claude: 150 } }));
  resetConfigCache();
  const vm = buildSettingsVM();
  assert.equal(vm.budget.monthlyBudgetUsd, 200);
  assert.equal(vm.budget.budgetCycleStartDay, 5);
  assert.equal(vm.budget.sourceBudgets.claude, 150);
});

describe('POST /api/budget', () => {
  let tmp: string;
  let testDb: DatabaseType.Database;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'td-budget-'));
    _setSettingsDirForTest(tmp);
    testDb = new Database(':memory:');
    runMigrations(testDb);
    _setDbForTest(testDb);
  });
  afterEach(() => {
    _setSettingsDirForTest(null);
    _setDbForTest(null);
    testDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test('rejects out-of-range cycle day', async () => {
    const app = buildServer({ defaultDays: 30 });
    const res = await app.inject({ method: 'POST', url: '/api/budget',
      payload: { budgetCycleStartDay: 40 } });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('rejects negative amounts', async () => {
    const app = buildServer({ defaultDays: 30 });
    const res = await app.inject({ method: 'POST', url: '/api/budget',
      payload: { monthlyBudgetUsd: -5 } });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  test('saves and round-trips', async () => {
    const app = buildServer({ defaultDays: 30 });
    const res = await app.inject({ method: 'POST', url: '/api/budget',
      payload: { monthlyBudgetUsd: 120, sourceBudgets: { cursor: 25 } } });
    assert.equal(res.statusCode, 200);
    resetConfigCache();
    const raw = JSON.parse(readFileSync(cfg, 'utf-8'));
    assert.equal(raw.monthlyBudgetUsd, 120);
    assert.equal(raw.sourceBudgets.cursor, 25);
    await app.close();
  });
});
