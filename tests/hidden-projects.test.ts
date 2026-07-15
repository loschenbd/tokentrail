import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { buildOverview } from '../src/dashboard/data/overview.js';
import { buildTodayVM } from '../src/dashboard/data/today.js';
import { buildToday } from '../src/dashboard/data/api.js';
import {
  normalizeProjectToken,
  matchesHiddenPattern,
  hiddenFeatureKeys,
  rollupVisiblePredicate,
} from '../src/dashboard/lib/hidden-projects.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

function makeDb(): DatabaseType.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

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
  rows: Array<{ date: string; cost: number; featureKey: string; featureName?: string; repo?: string }>
): void {
  const insert = db.prepare(`
    INSERT INTO feature_rollups (id, date, feature_key, feature_name, repo, total_cost_usd, sessions_count)
    VALUES (@id, @date, @key, @name, @repo, @cost, 1)
  `);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    insert.run({
      id: `h-${i}`,
      date: r.date,
      key: r.featureKey,
      name: r.featureName ?? r.featureKey,
      repo: r.repo ?? null,
      cost: r.cost,
    });
  }
}

describe('normalizeProjectToken / matchesHiddenPattern', () => {
  test('normalizes case, spaces, underscores, and path separators to hyphens', () => {
    assert.equal(normalizeProjectToken('Job Search'), 'job-search');
    assert.equal(normalizeProjectToken('job_search'), 'job-search');
    assert.equal(normalizeProjectToken('/Users/me/Projects/job-search/'), 'users-me-projects-job-search');
  });

  test('matches when any candidate contains the pattern', () => {
    assert.equal(matchesHiddenPattern(['job-search'], 'loschenbd/job-search'), true);
    assert.equal(matchesHiddenPattern(['job-search'], 'Job Search'), true);
    assert.equal(matchesHiddenPattern(['job-search'], 'archi', null, undefined), false);
    assert.equal(matchesHiddenPattern([], 'job-search'), false);
  });
});

describe('hiddenFeatureKeys', () => {
  test('resolves keys via repo slug, local alias, and repo-less outside bucket', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 10, featureKey: 'pmg-application-pack', repo: 'loschenbd/job-search' },
      { date: daysAgo(1), cost: 5, featureKey: 'outside:code-setup', repo: 'local/job-search-claude-code-setup' },
      { date: daysAgo(1), cost: 3, featureKey: 'outside:projects-job-search', featureName: 'Job Search' },
      { date: daysAgo(1), cost: 20, featureKey: 'archi-homepage', repo: 'loschenbd/archi' },
    ]);
    const keys = hiddenFeatureKeys(db, ['job-search']).sort();
    assert.deepEqual(keys, ['outside:code-setup', 'outside:projects-job-search', 'pmg-application-pack']);
  });

  test('empty patterns resolve to no keys and a pass-through predicate', () => {
    const db = makeDb();
    seedRollups(db, [{ date: daysAgo(1), cost: 10, featureKey: 'x', repo: 'a/job-search' }]);
    assert.deepEqual(hiddenFeatureKeys(db, []), []);
    assert.equal(rollupVisiblePredicate([]), '1=1');
  });

  test('predicate escapes single quotes in feature keys', () => {
    assert.equal(rollupVisiblePredicate(["it's"]), `feature_key NOT IN ('it''s')`);
  });
});

describe('buildOverview with hidden projects', () => {
  function seededDb(): DatabaseType.Database {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(1), cost: 40, featureKey: 'archi-homepage', repo: 'loschenbd/archi' },
      { date: daysAgo(2), cost: 60, featureKey: 'pmg-application-pack', repo: 'loschenbd/job-search' },
      { date: daysAgo(3), cost: 10, featureKey: 'outside:projects-job-search', featureName: 'Job Search' },
    ]);
    return db;
  }

  test('excludes hidden spend from totals, projects, and day bands', () => {
    const vm = buildOverview({ db: seededDb(), days: 30, hidden: ['job-search'] });
    assert.equal(vm.totalUsd, 40);
    assert.deepEqual(vm.projects.map((p) => p.name), ['archi']);
    assert.ok(vm.topFeatures.every((f) => f.featureKey !== 'pmg-application-pack'));
    for (const day of vm.days) {
      const bandSum = Object.values(day.bands).reduce((s, v) => s + v, 0);
      assert.equal(Math.round((bandSum + day.unattributedTotal) * 100) / 100, day.total);
    }
  });

  test('no hidden param leaves everything visible (back-compat)', () => {
    const vm = buildOverview({ db: seededDb(), days: 30 });
    assert.equal(vm.totalUsd, 110);
    assert.deepEqual(vm.projects.map((p) => p.name).sort(), ['Job Search', 'archi', 'job-search']);
  });

  test('color slots stay stable when hiding toggles, but hidden keys leave the emitted map', () => {
    const db = seededDb();
    const shown = buildOverview({ db, days: 30 });
    const hidden = buildOverview({ db, days: 30, hidden: ['job-search'] });
    assert.equal(hidden.projectColors['repo:loschenbd/archi'], shown.projectColors['repo:loschenbd/archi']);
    // The map is serialized into page HTML — no hidden project may appear.
    assert.ok(Object.keys(hidden.projectColors).every((k) => !k.includes('job-search')));
  });
});

describe('buildTodayVM / buildToday with hidden projects', () => {
  test('today view excludes hidden rollups and sessions', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(0), cost: 7, featureKey: 'archi-homepage', repo: 'loschenbd/archi' },
      { date: daysAgo(0), cost: 9, featureKey: 'pmg-application-pack', repo: 'loschenbd/job-search' },
    ]);
    const now = new Date().toISOString();
    const insertEvent = db.prepare(`
      INSERT INTO usage_events (id, session_id, timestamp, model, estimated_cost_usd, project_dir, repo, inferred_feature_key, inferred_feature_name)
      VALUES (@id, @sid, @ts, 'claude-test', @usd, @dir, @repo, @fk, @fn)
    `);
    insertEvent.run({ id: 'e1', sid: 's-archi', ts: now, usd: 7, dir: '/Users/me/Projects/archi', repo: 'loschenbd/archi', fk: 'archi-homepage', fn: 'Archi homepage' });
    insertEvent.run({ id: 'e2', sid: 's-job', ts: now, usd: 9, dir: '/Users/me/Projects/job-search', repo: 'loschenbd/job-search', fk: 'pmg-application-pack', fn: 'Pmg application pack' });

    const vm = buildTodayVM(db, { hidden: ['job-search'] });
    assert.equal(vm.todayUsd, 7);
    assert.equal(vm.sessionsToday, 1);
    assert.deepEqual(vm.sessions.map((s) => s.projectName), ['archi']);
    const hourlyTotal = vm.hourly.reduce((s, h) => s + h.usd, 0);
    assert.equal(hourlyTotal, 7);
    for (const h of vm.hourly) {
      assert.ok(h.projects.every((p) => p.name !== 'job-search'));
    }
  });

  test('/api/today payload excludes hidden projects and cache respects the setting', () => {
    const db = makeDb();
    seedRollups(db, [
      { date: daysAgo(0), cost: 7, featureKey: 'archi-homepage', repo: 'loschenbd/archi' },
      { date: daysAgo(0), cost: 9, featureKey: 'pmg-application-pack', repo: 'loschenbd/job-search' },
    ]);
    const visible = buildToday(db, { hidden: [] });
    assert.equal(visible.todayUsd, 16);
    // Same DB state, different hidden setting: must not serve the cached payload.
    const filtered = buildToday(db, { hidden: ['job-search'] });
    assert.equal(filtered.todayUsd, 7);
    assert.deepEqual(filtered.topProjects.map((p) => p.name), ['archi']);
    assert.ok(filtered.menubar.trend.projects.every((p) => p.name !== 'job-search'));
  });
});
