import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildOverview } from '../src/dashboard/data/overview.js';
import { buildFeatureDetail } from '../src/dashboard/data/feature.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);   // runs SCHEMA_STATEMENTS internally, then idempotent ALTER TABLE additions
  return db;
}

describe('buildOverview', () => {
  test('returns zeroed view-model when DB is empty', () => {
    const db = makeDb();
    const vm = buildOverview(db, { days: 30 });
    assert.equal(vm.totalUsd, 0);
    assert.equal(vm.topFeatures.length, 0);
    assert.equal(vm.days.length, 30);  // zero-filled
    assert.equal(vm.recentCommits.length, 0);
    assert.equal(vm.anomalies.length, 0);
  });

  test('computes total + delta vs prior period of same length', () => {
    const db = makeDb();
    // 4 days inside window @ $10 each = $40; 4 days outside (15-18 days ago) @ $5 = $20.
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(2), cost: 10 },
      { date: daysAgo(3), cost: 10 },
      { date: daysAgo(4), cost: 10 },
      { date: daysAgo(16), cost: 5 },
      { date: daysAgo(17), cost: 5 },
      { date: daysAgo(18), cost: 5 },
      { date: daysAgo(19), cost: 5 },
    ]);
    const vm = buildOverview(db, { days: 14 });
    assert.equal(vm.totalUsd, 40);
    assert.equal(vm.priorUsd, 20);
    assert.equal(vm.deltaPct, 100);
  });

  test('groups top features by total cost descending', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 50, feature_key: 'rag', feature_name: 'Local RAG' },
      { date: daysAgo(2), cost: 80, feature_key: 'archi', feature_name: 'Archi homepage' },
      { date: daysAgo(3), cost: 10, feature_key: 'rag', feature_name: 'Local RAG' },
    ]);
    const vm = buildOverview(db, { days: 30 });
    const [first, second] = vm.topFeatures;
    assert.equal(first!.featureKey, 'archi');
    assert.equal(first!.totalUsd, 80);
    assert.equal(second!.featureKey, 'rag');
    assert.equal(second!.totalUsd, 60);
  });

  test('days returns one entry per day in window, zero-filled', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 10 },
      { date: daysAgo(3), cost: 20 },
    ]);
    const vm = buildOverview(db, { days: 7 });
    assert.equal(vm.days.length, 7);
    const totals = vm.days.map((d) => d.total);
    assert.ok(totals.includes(10));
    assert.ok(totals.includes(20));
    assert.equal(totals.filter((t) => t === 0).length, 5);
  });

  test('features array: top 6 real features by window-total, sorted desc, with stable colors', () => {
    const db = makeDb();
    // 7 features, costs 70..10 — only top 6 should keep own bands.
    seedRollups(db, [
      { date: daysAgo(1), cost: 70, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 60, featureKey: 'ingest', featureName: 'ingest' },
      { date: daysAgo(1), cost: 50, featureKey: 'rollup', featureName: 'rollup' },
      { date: daysAgo(1), cost: 40, featureKey: 'enrich', featureName: 'enrich' },
      { date: daysAgo(1), cost: 30, featureKey: 'dashboard', featureName: 'dashboard' },
      { date: daysAgo(1), cost: 20, featureKey: 'infer-mainline', featureName: 'infer-mainline' },
      { date: daysAgo(1), cost: 10, featureKey: 'misc', featureName: 'misc' },
    ]);
    const vm = buildOverview(db, { days: 30 });

    // 6 real bands + 1 Other (no uncategorized in this fixture).
    assert.equal(vm.features.length, 7);
    const realFeatures = vm.features.filter((f) => f.clickable);
    assert.deepEqual(
      realFeatures.map((f) => f.key),
      ['menubar', 'ingest', 'rollup', 'enrich', 'dashboard', 'infer-mainline']
    );

    // Other is present, holds the tail.
    const other = vm.features.find((f) => f.key === '__other__');
    assert.ok(other);
    assert.equal(other!.totalUsd, 10);
    assert.equal(other!.clickable, false);

    // stackPosition: bottom (0) = biggest real feature; top = __other__ when no uncategorized.
    const byPos = [...vm.features].sort((a, b) => a.stackPosition - b.stackPosition);
    assert.equal(byPos[0]!.key, 'menubar');
    assert.equal(byPos[byPos.length - 1]!.key, '__other__');
  });

  test('uncategorized-mainline always gets its own band and stacks above Other', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 100, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 5,   featureKey: 'uncategorized-mainline', featureName: 'uncategorized-mainline' },
      { date: daysAgo(1), cost: 3,   featureKey: 'tail', featureName: 'tail' },
    ]);
    const vm = buildOverview(db, { days: 30 });

    const uncat = vm.features.find((f) => f.key === 'uncategorized-mainline');
    assert.ok(uncat);
    assert.equal(uncat!.clickable, false);
    assert.equal(uncat!.color, '__striped__');

    // Top of stack = uncategorized; just below = Other (tail feature); bottom = menubar.
    const byPos = [...vm.features].sort((a, b) => a.stackPosition - b.stackPosition);
    assert.equal(byPos[0]!.key, 'menubar');
    assert.equal(byPos[byPos.length - 1]!.key, 'uncategorized-mainline');
    // 'tail' is within the top-6 cap (only 2 real features), so it gets its own band.
    assert.equal(byPos[byPos.length - 2]!.key, 'tail');
  });

  test('days[].bands: per-day breakdown, zero-filled, totals match', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 2.10, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 1.21, featureKey: 'ingest',  featureName: 'ingest' },
      { date: daysAgo(2), cost: 0.50, featureKey: 'menubar', featureName: 'menubar' },
    ]);
    const vm = buildOverview(db, { days: 30 });

    assert.equal(vm.days.length, 30);
    const yesterday = vm.days.find((d) => d.date === daysAgo(1))!;
    assert.equal(yesterday.bands['menubar'], 2.10);
    assert.equal(yesterday.bands['ingest'], 1.21);
    assert.equal(yesterday.total, 3.31);

    const dayBefore = vm.days.find((d) => d.date === daysAgo(2))!;
    assert.equal(dayBefore.bands['menubar'], 0.50);
    // Missing band for ingest on this day → either absent or 0; both acceptable.
    assert.ok((dayBefore.bands['ingest'] ?? 0) === 0);

    // Untouched days: bands empty/zero, total 0.
    const zeroDay = vm.days.find((d) => d.date === daysAgo(10))!;
    assert.equal(zeroDay.total, 0);
  });

  test('fewer than 6 features: features array length matches reality, no empty bands', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 5, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 3, featureKey: 'ingest',  featureName: 'ingest' },
    ]);
    const vm = buildOverview(db, { days: 30 });

    // 2 real + 0 Other (no tail) + 0 uncategorized = 2.
    assert.equal(vm.features.length, 2);
    assert.equal(vm.features.find((f) => f.key === '__other__'), undefined);
  });

  test('days[].commits and days[].prs survive on the new shape', () => {
    // Keeps parity with the prior dailySeries semantics.
    const db = makeDb();
    // Existing fixture helpers add commits/prs already; assert presence of the keys.
    const vm = buildOverview(db, { days: 30 });
    for (const d of vm.days) {
      assert.equal(typeof d.commits, 'number');
      assert.equal(typeof d.prs, 'number');
    }
  });
});

describe('buildFeatureDetail', () => {
  test('returns null when feature has no rollups', () => {
    const db = makeDb();
    const vm = buildFeatureDetail(db, { featureKey: 'missing', days: 30 });
    assert.equal(vm, null);
  });

  test('aggregates rollups, sessions, commits, PRs for a feature', () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count, session_ids, branches)
      VALUES ('r1', date('now','-1 days'), 'rag', 'Local RAG', 100, 1, 's1', 'feat/rag');
      INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
      VALUES ('s1', 'Build the RAG', '/repo/rag', date('now','-1 days'), date('now','-1 days'));
      INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd)
      VALUES ('e1', 's1', datetime('now','-1 days'), 'opus', 100);
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at, repo)
      VALUES ('s1', 'abcdef0', 'Add retriever', datetime('now','-1 days'), 'me/rag');
      INSERT INTO session_prs (session_id, repo, pr_number, pr_title, pr_url, pr_state, head_branch)
      VALUES ('s1', 'me/rag', 7, 'Add retriever', 'https://github.com/me/rag/pull/7', 'open', 'feat/rag');
    `);
    const vm = buildFeatureDetail(db, { featureKey: 'rag', days: 30 });
    assert.ok(vm);
    assert.equal(vm!.featureKey, 'rag');
    assert.equal(vm!.totalUsd, 100);
    assert.equal(vm!.sessions.length, 1);
    assert.equal(vm!.sessions[0]!.commits.length, 1);
    assert.equal(vm!.sessions[0]!.prs.length, 1);
    assert.equal(vm!.sessions[0]!.prs[0]!.prNumber, 7);
  });
});

// daysAgo returns the actual local date string N days ago in YYYY-MM-DD format,
// matching SQLite's date('now', '-N days', 'localtime'). Using JS Date arithmetic
// here keeps test-data dates and assertion comparisons in sync.
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA'); // 'en-CA' produces YYYY-MM-DD
}

function seedRollups(
  db: DatabaseType.Database,
  rows: Array<{ date: string; cost: number; feature_key?: string; feature_name?: string; featureKey?: string; featureName?: string }>
): void {
  const insert = db.prepare(`
    INSERT INTO feature_rollups (id, date, feature_key, feature_name, total_cost_usd, sessions_count)
    VALUES (@id, @date, @key, @name, @cost, 1)
  `);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    insert.run({
      id: `t-${i}`,
      date: r.date,
      key: r.featureKey ?? r.feature_key ?? 'misc',
      name: r.featureName ?? r.feature_name ?? 'misc',
      cost: r.cost,
    });
  }
}
