import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrations.js';
import { buildToday } from '../src/dashboard/data/api.js';
import { resetConfigCache } from '../src/lib/config.js';
import type { BudgetReport } from '../src/dashboard/data/budget.js';

let dir: string;
const prev = process.env.TOKENTRAIL_CONFIG;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tt-api-')); });
afterEach(() => {
  if (prev === undefined) delete process.env.TOKENTRAIL_CONFIG; else process.env.TOKENTRAIL_CONFIG = prev;
  resetConfigCache(); rmSync(dir, { recursive: true, force: true });
});

test('TodayResponse.budget carries per-source caps from config', () => {
  const cfg = join(dir, 'config.json');
  writeFileSync(cfg, JSON.stringify({ monthlyBudgetUsd: 200, sourceBudgets: { claude: 150 } }));
  process.env.TOKENTRAIL_CONFIG = cfg; resetConfigCache();
  const db = new Database(':memory:'); runMigrations(db);
  db.prepare(`INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd, source)
              VALUES ('a','s',date('now','localtime')||'T12:00:00Z','claude','40','jsonl')`).run();
  const t = buildToday(db);
  assert.ok(t.budget !== null);
  const budget = t.budget as BudgetReport;
  assert.equal(budget.sources.length, 1);
  assert.equal(budget.sources[0]!.key, 'claude');
});
