import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { getConfig, resetConfigCache } from '../src/lib/config.js';
import { readUsageEvents } from '../src/services/copilot-store-reader.js';
import { copilotCostUsd } from '../src/lib/cost.js';
import { runCopilot } from '../src/commands/copilot.js';
import { runSourceReport } from '../src/commands/report.js';

describe('copilot schema + config', () => {
  test('creates copilot_ingest_state table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    assert.ok(names.includes('copilot_ingest_state'));
  });

  test('copilotStorePath config default is null', () => {
    resetConfigCache();
    assert.equal(getConfig().copilotStorePath, null);
  });
});

// A real on-disk fixture mimicking Copilot CLI's ~/.copilot/session-store.db
// (schema_version 6). Two turns in one session; the second lacks
// total_nano_aiu to exercise the token-rate fallback. Written to a file (not
// :memory:) so the reader can reopen it readonly.
function makeCopilotDb(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE schema_version (version INTEGER NOT NULL);`);
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
    branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);`);
  db.exec(`CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT,
    model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    total_nano_aiu INTEGER, request_multiplier REAL, duration_ms INTEGER,
    time_to_first_token_ms INTEGER, inter_token_latency_ms INTEGER, initiator TEXT,
    api_endpoint TEXT, reasoning_effort TEXT, finish_reason TEXT,
    content_filter_triggered INTEGER, token_details_json TEXT,
    created_at TEXT DEFAULT (datetime('now')));`);
  db.prepare(
    `INSERT INTO sessions (id, cwd, repository, branch, created_at)
     VALUES (?,?,?,?,?)`
  ).run('sess-1', '/tmp/does-not-exist-repo', 'owner/repo', 'feature/x', '2026-08-01 18:02:00');
  const ins = db.prepare(
    `INSERT INTO assistant_usage_events
       (session_id, turn_index, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        total_nano_aiu, request_multiplier, initiator, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  // Turn 1: total_nano_aiu = 1e11 → exactly $1.00 (1e11 * 1e-11).
  ins.run('sess-1', 0, 'claude-sonnet-4.5', 1000, 500, 0, 0, 0, 1e11, 1, 'user', '2026-08-01 18:02:05');
  // Turn 2: no total_nano_aiu → token fallback (gpt-5.4: 2000*2.5 + 800*15 per 1e6).
  ins.run('sess-1', 1, 'gpt-5.4', 2000, 800, 0, 0, 0, null, 1, 'user', '2026-08-01 18:02:10');
  db.close();
}

describe('readUsageEvents', () => {
  test('reads rows after the watermark, maps fields, normalizes timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-'));
    const path = join(dir, 'session-store.db');
    makeCopilotDb(path);

    const all = readUsageEvents(path, 0);
    assert.equal(all.length, 2);
    const t1 = all[0]!;
    const t2 = all[1]!;
    assert.equal(t1.model, 'claude-sonnet-4.5');
    assert.equal(t1.inputTokens, 1000);
    assert.equal(t1.totalNanoAiu, 1e11);
    assert.equal(t1.branch, 'feature/x');
    assert.equal(t1.repository, 'owner/repo');
    assert.equal(t1.cwd, '/tmp/does-not-exist-repo');
    assert.equal(t1.timestamp, '2026-08-01T18:02:05Z');
    assert.equal(t2.totalNanoAiu, null);

    // Watermark: reading after the first row's id returns only the second.
    const after = readUsageEvents(path, t1.rowId);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.rowId, t2.rowId);
  });

  test('missing db degrades to [] (non-fatal)', () => {
    assert.deepEqual(readUsageEvents(join(tmpdir(), 'nope-nonexistent.db'), 0), []);
  });
});

describe('copilotCostUsd', () => {
  test('prefers pre-computed total_nano_aiu (1e11 nano = $1.00)', () => {
    const usd = copilotCostUsd({
      model: 'claude-sonnet-4.5',
      inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 0,
      totalNanoAiu: 1e11,
    });
    assert.equal(usd, 1);
  });

  test('falls back to the resale rate card when total_nano_aiu is null', () => {
    // gpt-5.4: input 2.5/1M, output 15/1M → 2000*2.5/1e6 + 800*15/1e6 = 0.005 + 0.012
    const usd = copilotCostUsd({
      model: 'gpt-5.4',
      inputTokens: 2000, outputTokens: 800, cacheWriteTokens: 0, cacheReadTokens: 0,
      totalNanoAiu: null,
    });
    assert.equal(usd, 0.017);
  });

  // Regression: Copilot's input_tokens INCLUDES cached tokens. The fallback
  // must subtract cache_read/cache_write from input or it double-bills them.
  // Numbers + expected value are from a real captured gpt-5-mini turn.
  test('fallback treats input_tokens as inclusive of cache (real gpt-5-mini row)', () => {
    const usd = copilotCostUsd({
      model: 'gpt-5-mini',
      inputTokens: 14494, outputTokens: 182, cacheReadTokens: 4352, cacheWriteTokens: 0,
      totalNanoAiu: null,
    });
    // (14494-4352)*0.25 + 4352*0.025 + 182*2, per 1e6 = 0.0030083
    assert.equal(usd, 0.003008);
  });

  test('nano path reproduces the real row exactly', () => {
    const usd = copilotCostUsd({
      model: 'gpt-5-mini',
      inputTokens: 14494, outputTokens: 182, cacheReadTokens: 4352, cacheWriteTokens: 0,
      totalNanoAiu: 300830000,
    });
    assert.equal(usd, 0.003008); // 300830000 * 1e-11 = 0.0030083 → round6
  });
});

describe('runCopilot', () => {
  test('ingests into usage_events with source=copilot, dedups, advances watermark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-'));
    const storePath = join(dir, 'session-store.db');
    makeCopilotDb(storePath);

    // Point config at the fixture store.
    const cfgPath = join(dir, 'tokentrail.json');
    writeFileSync(cfgPath, JSON.stringify({ copilotStorePath: storePath }));
    process.env.TOKENTRAIL_CONFIG = cfgPath;
    resetConfigCache();

    const db = new Database(':memory:');
    runMigrations(db);

    const first = await runCopilot(db);
    assert.equal(first.newEvents, 2);

    const rows = db
      .prepare("SELECT id, source, model, estimated_cost_usd, branch FROM usage_events ORDER BY id")
      .all() as Array<any>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.source === 'copilot'));
    assert.ok(rows.every((r) => r.id.startsWith('copilot:sess-1:')));
    // The $1.00 nano-priced turn is present.
    assert.ok(rows.some((r) => r.estimated_cost_usd === 1));
    // Session-time branch was preferred.
    assert.ok(rows.every((r) => r.branch === 'feature/x'));

    // Re-run is idempotent: OR IGNORE + watermark → no new rows.
    const second = await runCopilot(db);
    assert.equal(second.newEvents, 0);

    const wm = db.prepare('SELECT last_row_id FROM copilot_ingest_state WHERE key=?').get('usage') as any;
    assert.equal(wm.last_row_id, 2);

    delete process.env.TOKENTRAIL_CONFIG;
    resetConfigCache();
  });
});

describe('runSourceReport (dedicated copilot view)', () => {
  test('renders copilot-only spend by branch and by model', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const ins = db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model,
        input_tokens, output_tokens, estimated_cost_usd, source)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const today = new Date().toISOString();
    ins.run('copilot:s:1', 's', today, 'owner/repo', 'feature/x', 'claude-sonnet-4.5', 1000, 500, 1.0, 'copilot');
    ins.run('copilot:s:2', 's', today, 'owner/repo', 'feature/x', 'gpt-5.4', 2000, 800, 0.5, 'copilot');
    // A Claude row that must NOT appear in the copilot-scoped report.
    ins.run('jsonl:x', 'x', today, 'owner/repo', 'main', 'claude-opus-4.8', 10, 10, 9.99, 'jsonl');

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      runSourceReport(db, 'copilot', ['copilot'], 30);
    } finally {
      console.log = orig;
    }
    const out = lines.join('\n');
    assert.match(out, /source=copilot/);
    assert.match(out, /feature\/x/);
    assert.match(out, /claude-sonnet-4\.5/);
    assert.match(out, /gpt-5\.4/);
    assert.match(out, /\$1\.50/);          // total copilot cost
    assert.doesNotMatch(out, /9\.99/);      // claude row excluded
    assert.doesNotMatch(out, /opus/);       // claude model excluded
  });
});
