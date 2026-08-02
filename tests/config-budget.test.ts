import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFrom, saveBudgetConfig, resetConfigCache } from '../src/lib/config.js';

let dir: string;
let cfgPath: string;
const prevEnv = process.env.TOKENTRAIL_CONFIG;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tt-cfg-'));
  cfgPath = join(dir, 'config.json');
  process.env.TOKENTRAIL_CONFIG = cfgPath;
  resetConfigCache();
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.TOKENTRAIL_CONFIG;
  else process.env.TOKENTRAIL_CONFIG = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('saveBudgetConfig', () => {
  test('merges budget keys, preserving unrelated keys', () => {
    writeFileSync(cfgPath, JSON.stringify({ copilotStorePath: '/x/y', monthlyBudgetUsd: 100 }, null, 2));
    saveBudgetConfig({ monthlyBudgetUsd: 250, sourceBudgets: { claude: 150 } });
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.copilotStorePath, '/x/y');        // untouched
    assert.equal(raw.monthlyBudgetUsd, 250);           // updated
    assert.deepEqual(raw.sourceBudgets, { claude: 150 }); // merged
  });

  test('normalize exposes sourceBudgets with null defaults', () => {
    writeFileSync(cfgPath, JSON.stringify({ sourceBudgets: { claude: 150, copilot: 0, cursor: -5 } }));
    const cfg = loadConfigFrom(cfgPath);
    // 0 and negative coerce to null (no cap); positive kept.
    assert.deepEqual(cfg.sourceBudgets, { claude: 150, copilot: null, cursor: null });
  });

  test('explicit null clears a budget key', () => {
    writeFileSync(cfgPath, JSON.stringify({ monthlyBudgetUsd: 100, sourceBudgets: { claude: 150 } }));
    saveBudgetConfig({ monthlyBudgetUsd: null, sourceBudgets: { claude: null } });
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.monthlyBudgetUsd, null);
    assert.equal(raw.sourceBudgets.claude, null);
  });

  test('creates the file when none exists', () => {
    resetConfigCache();
    const res = saveBudgetConfig({ monthlyBudgetUsd: 80 });
    assert.equal(res.path, cfgPath);
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    assert.equal(raw.monthlyBudgetUsd, 80);
  });
});
