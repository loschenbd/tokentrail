import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildFeatureDetail } from '../src/dashboard/data/feature.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function today(db: Database.Database): string {
  return (db.prepare(`SELECT date('now','-1 day','localtime') AS d`).get() as { d: string }).d;
}

function seedRollup(db: Database.Database, p: { date: string; sessionIds: string; cost: number }) {
  db.prepare(
    `INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_input_tokens, total_output_tokens, total_cost_usd, sessions_count, session_ids, branches)
     VALUES (?, ?, 'feat-x', 'Feature X', 'o/r', 0, 0, ?, 1, ?, 'feat/x')`
  ).run(`${p.date}::feat-x`, p.date, p.cost, p.sessionIds);
}
function seedSession(db: Database.Database, id: string, title: string, seenAt: string) {
  db.prepare(`INSERT INTO sessions (session_id, title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)`)
    .run(id, title, seenAt, seenAt);
}
function seedUsage(db: Database.Database, id: string, sessionId: string, cost: number) {
  db.prepare(
    `INSERT INTO usage_events (id, session_id, timestamp, model, input_tokens, output_tokens, estimated_cost_usd, source)
     VALUES (?, ?, '2026-08-01T10:00:00Z', 'claude-opus', 0, 0, ?, 'claude')`
  ).run(id, sessionId, cost);
}
function seedCommit(db: Database.Database, sessionId: string, sha: string, subject: string, at: string) {
  db.prepare(`INSERT INTO session_commits (session_id, commit_sha, subject, authored_at, repo) VALUES (?, ?, ?, ?, 'o/r')`)
    .run(sessionId, sha, subject, at);
}
function seedPr(db: Database.Database, sessionId: string, num: number, title: string, state: string, mergedAt: string | null) {
  db.prepare(
    `INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch, merged_at)
     VALUES (?, 'o/r', ?, ?, ?, ?, 'feat/x', ?)`
  ).run(sessionId, num, title, `https://github.com/o/r/pull/${num}`, state, mergedAt);
}

test('a feature with a merged PR is closed, and cost-per-PR / cost-per-commit are computed', () => {
  const db = makeDb();
  const d = today(db);
  seedRollup(db, { date: d, sessionIds: 's1', cost: 100 });
  seedSession(db, 's1', 'do the thing', `${d}T10:00:00Z`);
  seedUsage(db, 'e1', 's1', 100);
  seedCommit(db, 's1', 'aaa1111', 'feat: alpha', '2026-08-01T10:00:00Z');
  seedCommit(db, 's1', 'aaa2222', 'feat: alpha (#5)', '2026-08-01T10:05:00Z');
  seedCommit(db, 's1', 'aaa3333', 'docs: notes', '2026-08-01T10:10:00Z');
  seedCommit(db, 's1', 'aaa4444', 'release: v1.0.0', '2026-08-01T10:15:00Z');
  seedPr(db, 's1', 5, 'Alpha', 'merged', '2026-08-01T10:06:00Z');

  const vm = buildFeatureDetail(db, { featureKey: 'feat-x', days: 30 })!;
  assert.ok(vm);
  assert.equal(vm.status, 'closed');
  assert.equal(vm.mergedPrCount, 1);
  // deduped work items: docs:notes (change) + PR #5 = 2 (raw twin + release excluded)
  assert.equal(vm.commitCount, 2);
  assert.equal(vm.releaseCount, 1);
  assert.equal(vm.costPerPr, 100);
  assert.equal(vm.costPerCommit, 50);
});

test('deltaPct is null when there is no prior-window baseline (no fake 100%)', () => {
  const db = makeDb();
  const d = today(db);
  seedRollup(db, { date: d, sessionIds: 's1', cost: 42 });
  seedSession(db, 's1', 'x', `${d}T10:00:00Z`);
  seedUsage(db, 'e1', 's1', 42);
  const vm = buildFeatureDetail(db, { featureKey: 'feat-x', days: 30 })!;
  assert.equal(vm.deltaPct, null);
});

test('releases group PRs newest-first with a v-range; no PR means opened', () => {
  const db = makeDb();
  const d = today(db);
  seedRollup(db, { date: d, sessionIds: 's1', cost: 80 });
  seedSession(db, 's1', 'x', `${d}T10:00:00Z`);
  seedUsage(db, 'e1', 's1', 80);
  seedCommit(db, 's1', 'b1', 'feat: a (#1)', '2026-08-01T09:00:00Z');
  seedCommit(db, 's1', 'b2', 'release: v0.1.0', '2026-08-01T09:05:00Z');
  seedCommit(db, 's1', 'b3', 'feat: b (#2)', '2026-08-01T09:10:00Z');
  seedCommit(db, 's1', 'b4', 'release: v0.2.0', '2026-08-01T09:15:00Z');
  seedPr(db, 's1', 1, 'A', 'open', null); // not merged
  seedPr(db, 's1', 2, 'B', 'open', null);

  const vm = buildFeatureDetail(db, { featureKey: 'feat-x', days: 30 })!;
  assert.equal(vm.status, 'opened'); // no merged PR
  assert.deepEqual(vm.releases.map((r) => r.version), ['v0.2.0', 'v0.1.0']);
  assert.equal(vm.releases[0]!.prs[0]!.prNumber, 2);
});

test('ledger session costs are scaled to sum to the feature total', () => {
  const db = makeDb();
  const d = today(db);
  // Feature total 60, but the session globally spent 100 (touched other features).
  seedRollup(db, { date: d, sessionIds: 's1', cost: 60 });
  seedSession(db, 's1', 'x', `${d}T10:00:00Z`);
  seedUsage(db, 'e1', 's1', 100);
  const vm = buildFeatureDetail(db, { featureKey: 'feat-x', days: 30 })!;
  assert.equal(vm.totalUsd, 60);
  assert.equal(vm.sessions[0]!.cost, 60); // scaled from 100 → feature total
});
