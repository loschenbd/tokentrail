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

// Alias used by new brief tests.
function openInMemoryDb(): DatabaseType.Database {
  return makeDb();
}

describe('buildOverview', () => {
  test('returns zeroed view-model when DB is empty', () => {
    const db = makeDb();
    const vm = buildOverview({ db, days: 30 });
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
    const vm = buildOverview({ db, days: 14 });
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
    const vm = buildOverview({ db, days: 30 });
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
    const vm = buildOverview({ db, days: 7 });
    assert.equal(vm.days.length, 7);
    const totals = vm.days.map((d) => d.total);
    assert.ok(totals.includes(10));
    assert.ok(totals.includes(20));
    assert.equal(totals.filter((t) => t === 0).length, 5);
  });

  test('projects[]: top 6 by 30d $ (old-format seeds; each feature is its own project)', () => {
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
    const vm = buildOverview({ db, days: 30 });

    // 6 real + 1 Other (no uncategorized in this fixture).
    assert.equal(vm.projects.length, 7);
    const realProjects = vm.projects.filter((p) => p.clickable);
    assert.deepEqual(
      realProjects.map((p) => p.key),
      ['menubar', 'ingest', 'rollup', 'enrich', 'dashboard', 'infer-mainline']
    );

    // Other is present, holds the tail.
    const other = vm.projects.find((p) => p.key === '__other__');
    assert.ok(other);
    assert.equal(other!.totalUsd, 10);
    assert.equal(other!.clickable, false);

    // stackPosition: bottom (0) = biggest real project; top = __other__.
    const byPos = [...vm.projects].sort((a, b) => a.stackPosition - b.stackPosition);
    assert.equal(byPos[0]!.key, 'menubar');
    assert.equal(byPos[byPos.length - 1]!.key, '__other__');
  });

  test('uncategorized-mainline dissolves: not a project; counted in unattributed block', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 100, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 5,   featureKey: 'uncategorized-mainline', featureName: 'uncategorized-mainline' },
      { date: daysAgo(1), cost: 3,   featureKey: 'tail', featureName: 'tail' },
    ]);
    const vm = buildOverview({ db, days: 30 });

    // 'uncategorized-mainline' (old-format, no project_key) is NOT a named project.
    assert.equal(vm.projects.length, 2); // menubar + tail
    assert.ok(!vm.projects.some((p) => p.key === 'uncategorized-mainline'));

    // Unattributed block is populated.
    assert.ok(vm.unattributed !== null);
    assert.equal(vm.unattributed!.totalUsd, 5);
  });

  test('days[].bands: per-day breakdown, zero-filled, totals match', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 2.10, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 1.21, featureKey: 'ingest',  featureName: 'ingest' },
      { date: daysAgo(2), cost: 0.50, featureKey: 'menubar', featureName: 'menubar' },
    ]);
    const vm = buildOverview({ db, days: 30 });

    assert.equal(vm.days.length, 30);
    const yesterday = vm.days.find((d) => d.date === daysAgo(1))!;
    assert.equal(yesterday.bands['menubar'], 2.10);
    assert.equal(yesterday.bands['ingest'], 1.21);
    assert.equal(yesterday.total, 3.31);

    const dayBefore = vm.days.find((d) => d.date === daysAgo(2))!;
    assert.equal(dayBefore.bands['menubar'], 0.50);
    // Missing band for ingest on this day → either absent or 0; both acceptable.
    assert.ok((dayBefore.bands['ingest'] ?? 0) === 0);

    // Untouched days: total 0.
    const zeroDay = vm.days.find((d) => d.date === daysAgo(10))!;
    assert.equal(zeroDay.total, 0);
  });

  test('fewer than 6 projects: projects array length matches reality, no Other', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 5, featureKey: 'menubar', featureName: 'menubar' },
      { date: daysAgo(1), cost: 3, featureKey: 'ingest',  featureName: 'ingest' },
    ]);
    const vm = buildOverview({ db, days: 30 });

    // 2 real projects, no Other.
    assert.equal(vm.projects.length, 2);
    assert.equal(vm.projects.find((p) => p.key === '__other__'), undefined);
  });

  test('days[].commits and days[].prs survive on the new shape', () => {
    // Keeps parity with the prior dailySeries semantics.
    const db = makeDb();
    // Existing fixture helpers add commits/prs already; assert presence of the keys.
    const vm = buildOverview({ db, days: 30 });
    for (const d of vm.days) {
      assert.equal(typeof d.commits, 'number');
      assert.equal(typeof d.prs, 'number');
    }
  });

  // --- NEW brief tests (project-first payload) ---

  test('projects[]: top 6 by 30d $ plus Other; correct stack positions', () => {
    const db = openInMemoryDb();
    // Seven distinct projects, decreasing spend.
    seedRollups(db, [
      { date: daysAgo(2), projectKey: 'p1', usd: 700 },
      { date: daysAgo(2), projectKey: 'p2', usd: 600 },
      { date: daysAgo(2), projectKey: 'p3', usd: 500 },
      { date: daysAgo(2), projectKey: 'p4', usd: 400 },
      { date: daysAgo(2), projectKey: 'p5', usd: 300 },
      { date: daysAgo(2), projectKey: 'p6', usd: 200 },
      { date: daysAgo(2), projectKey: 'p7', usd: 100 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    const keys = vm.projects.map((p) => p.key);
    assert.deepEqual(keys.slice(0, 6), ['p1','p2','p3','p4','p5','p6']);
    assert.equal(vm.projects[6]!.key, '__other__');
    // Stack: 0 = bottom (largest), Other = 6 (top).
    assert.equal(vm.projects[0]!.stackPosition, 0);
    assert.equal(vm.projects[6]!.stackPosition, 6);
    assert.equal(vm.projects[6]!.clickable, false);
    assert.ok(vm.projects.slice(0, 6).every((p) => p.clickable));
  });

  test('projects[] omits Other when <=6 projects total', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(1), projectKey: 'p1', usd: 100 },
      { date: daysAgo(1), projectKey: 'p2', usd: 80 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    assert.equal(vm.projects.length, 2);
    assert.ok(!vm.projects.some((p) => p.key === '__other__'));
  });

  test('days[].bands keyed by project; sums to day total', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 40 },
      { date: daysAgo(1), projectKey: 'archi', featureKey: 'onboarding', usd: 10 },
      { date: daysAgo(1), projectKey: 'tokentrail', featureKey: 'dashboard', usd: 50 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    const row = vm.days.find((d) => d.date === daysAgo(1))!;
    assert.equal(row.total, 100);
    assert.equal(row.bands['archi'], 50);
    assert.equal(row.bands['tokentrail'], 50);
    const sum = Object.values(row.bands).reduce((a, b) => a + b, 0);
    assert.equal(sum, row.total);
  });

  test('days[].featureBands nested per project; unattributed uses __unattributed__ key', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 30 },
      { date: daysAgo(1), projectKey: 'archi', featureKey: 'uncategorized-mainline', usd: 20 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    const row = vm.days.find((d) => d.date === daysAgo(1))!;
    assert.equal(row.featureBands['archi']?.['rag'], 30);
    assert.equal(row.featureBands['archi']?.['__unattributed__'], 20);
    assert.equal(row.unattributedTotal, 20);
  });

  test('projectFeatureMix: per-project features sorted $ desc; window totals', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(3), projectKey: 'archi', featureKey: 'rag',        usd: 100 },
      { date: daysAgo(3), projectKey: 'archi', featureKey: 'onboarding', usd:  50 },
      { date: daysAgo(3), projectKey: 'archi', featureKey: 'uncategorized-mainline', usd: 75 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    const mix = vm.projectFeatureMix.find((m) => m.projectKey === 'archi')!;
    const keys = mix.features.map((f) => f.key);
    assert.deepEqual(keys, ['rag', '__unattributed__', 'onboarding']);
    assert.equal(mix.features[1]!.color, '__striped__');
  });

  test('unattributed: null when zero unattributed in window', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(1), projectKey: 'archi', featureKey: 'rag', usd: 100 },
    ]);
    const vm = buildOverview({ db, days: 30 });
    assert.equal(vm.unattributed, null);
  });

  test('unattributed: populated payload includes sparkline and top projects', () => {
    const db = openInMemoryDb();
    seedRollups(db, [
      { date: daysAgo(1), projectKey: 'archi',      featureKey: 'uncategorized-mainline', usd: 60 },
      { date: daysAgo(1), projectKey: 'tokentrail', featureKey: 'uncategorized-mainline', usd: 40 },
      { date: daysAgo(2), projectKey: 'archi',      featureKey: 'uncategorized-mainline', usd: 10 },
      { date: daysAgo(3), projectKey: 'archi',      featureKey: 'rag',                    usd: 30 }, // for pctOfTrail denominator
    ]);
    const vm = buildOverview({ db, days: 30 });
    assert.ok(vm.unattributed);
    assert.equal(vm.unattributed!.totalUsd, 110);
    assert.equal(vm.unattributed!.sparkline.length, 30);
    const top = vm.unattributed!.topProjects.map((p) => p.key);
    assert.deepEqual(top, ['archi', 'tokentrail']);
    const pct = vm.unattributed!.pctOfTrail;
    assert.ok(pct > 70 && pct < 90, `expected pctOfTrail in [70,90], got ${pct}`);
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
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function seedRollups(
  db: DatabaseType.Database,
  rows: Array<{
    date: string;
    cost?: number;
    usd?: number;
    feature_key?: string;
    feature_name?: string;
    featureKey?: string;
    featureName?: string;
    projectKey?: string;
  }>
): void {
  const insert = db.prepare(`
    INSERT INTO feature_rollups (id, date, project_key, feature_key, feature_name, total_cost_usd, sessions_count)
    VALUES (@id, @date, @projectKey, @key, @name, @cost, 1)
  `);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    insert.run({
      id: `t-${i}`,
      date: r.date,
      projectKey: r.projectKey ?? null,
      key: r.featureKey ?? r.feature_key ?? 'misc',
      name: r.featureName ?? r.feature_name ?? 'misc',
      cost: r.usd ?? r.cost ?? 0,
    });
  }
}
