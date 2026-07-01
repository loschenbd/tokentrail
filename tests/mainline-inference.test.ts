import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { inferMainlineFeatures } from '../src/services/mainline-inference.js';

type DB = ReturnType<typeof Database>;

function seed(db: DB) {
  // Mainline work_unit
  db.exec(`
    INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at, status)
    VALUES ('w1', 'octo/tokentrail', 'main', 'mainline-octo-tokentrail-main', 'tokentrail (main)',
            '2026-06-29T09:00:00Z', '2026-06-29T13:00:00Z', 'active');
  `);
  // Non-mainline work_unit (should be ignored)
  db.exec(`
    INSERT INTO work_units (id, repo, branch, feature_key, feature_name, first_seen_at, last_seen_at, status)
    VALUES ('w2', 'octo/tokentrail', 'feat/x', 'cool-thing', 'Cool thing',
            '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z', 'active');
  `);
  db.exec(`
    INSERT INTO sessions (session_id, title, project_dir, first_seen_at, last_seen_at)
    VALUES ('s1', 'work on menubar then marketing', '/x', '2026-06-29T09:00:00Z', '2026-06-29T13:00:00Z'),
           ('s2', 'override session', '/y', '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z'),
           ('s3', 'no-commits session', '/z', '2026-06-29T09:00:00Z', '2026-06-29T10:00:00Z');
    UPDATE sessions SET feature_override = 'explicit-feature' WHERE session_id = 's2';
  `);
}

function makeDb(): DB {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('inferMainlineFeatures()', () => {
  test('single-commit session: all events get the same key', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at)
      VALUES ('s1', 'sha1', 'feat(menubar): redesign', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd)
      VALUES ('e1', 's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'claude-sonnet', 0.5),
             ('e2', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'claude-sonnet', 0.5);
    `);
    const summary = await inferMainlineFeatures(db);
    assert.equal(summary.sessionsRelabeled, 1);
    const rows = db.prepare(`SELECT id, inferred_feature_key FROM usage_events WHERE session_id='s1' ORDER BY id`).all() as Array<{id: string; inferred_feature_key: string}>;
    assert.deepEqual(rows.map(r => r.inferred_feature_key), ['menubar', 'menubar']);
  });

  test('multi-scope split by time window', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z'),
        ('s1', 'b', 'feat(marketing): Y', '2026-06-29T12:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('pre',  's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
        ('mid',  's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
        ('tail', 's1', '2026-06-29T12:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT id, inferred_feature_key FROM usage_events WHERE session_id='s1'`).all() as Array<{id:string;inferred_feature_key:string}>;
    const map = Object.fromEntries(r.map(x => [x.id, x.inferred_feature_key]));
    assert.equal(map.pre, 'menubar', 'preamble → first commit');
    assert.equal(map.mid, 'menubar', 'between A and B → A');
    assert.equal(map.tail, 'marketing', 'tail → last commit');
  });

  test('feature_override short-circuits — no inference written', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s2', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's2', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key FROM usage_events WHERE session_id='s2'`).get() as {inferred_feature_key: string | null};
    assert.equal(r.inferred_feature_key, null);
  });

  test('non-mainline work_units are skipped', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s3', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'feat/x', 'm', 0.1);
    `);
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key FROM usage_events WHERE session_id='s3'`).get() as {inferred_feature_key: string | null};
    assert.equal(r.inferred_feature_key, null);
  });

  test('session with no commits and no LLM → no-signal feature', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    process.env.TOKENTRAIL_LLM_BACKEND = 'none';
    await inferMainlineFeatures(db);
    const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s3'`).get() as {inferred_feature_key: string; inference_source: string};
    assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
    assert.equal(r.inference_source, 'no-signal');
  });

  test('second run with unchanged commit_set_hash is a no-op', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'feat(menubar): X', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's1', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    const first = await inferMainlineFeatures(db);
    const second = await inferMainlineFeatures(db);
    assert.equal(first.sessionsRelabeled, 1);
    assert.equal(second.sessionsRelabeled, 0);
  });

  test('Rule B: non-conventional commit subjects get LLM-named features', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'whatever I did today', '2026-06-29T10:00:00Z'),
        ('s1', 'b', 'more progress on the thing', '2026-06-29T12:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e1', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1),
        ('e2', 's1', '2026-06-29T12:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);

    const fakeClient = {
      backend: 'openrouter' as const,
      model: 'anthropic/claude-haiku-4.5',
      client: {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: JSON.stringify({
                labels: [
                  { commit_sha: 'a', topic_slug: 'menubar-rework' },
                  { commit_sha: 'b', topic_slug: 'menubar-rework' },
                ],
              })}}],
            })),
          },
        },
      } as any,
    };
    const summary = await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
    assert.equal(summary.llmCalls, 1);
    const rows = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s1'`).all() as Array<{inferred_feature_key:string; inference_source:string}>;
    assert.ok(rows.every(r => r.inferred_feature_key === 'menubar-rework'));
    assert.ok(rows.every(r => r.inference_source === 'session-title-llm'));
  });

  test('Rule B malformed response → session-title fallback, then no-signal when that also fails', async () => {
    // When the batch call returns unparseable content the service now
    // asks the LLM for a session-title slug as a fallback. In this test
    // that call ALSO returns garbage, so the commit lands on no-signal.
    // Two LLM calls total: one batch + one fallback.
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'whatever I did today', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e1', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    const fakeClient = {
      backend: 'openrouter' as const,
      model: 'anthropic/claude-haiku-4.5',
      client: { chat: { completions: { create: mock.fn(async () => ({ choices: [{ message: { content: 'not json' }}]})) }} } as any,
    };

    const summary = await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
    assert.equal(summary.llmCalls, 1);
    const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s1'`).get() as {inferred_feature_key:string; inference_source:string};
    assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
    assert.equal(r.inference_source, 'no-signal');
  });

  test('Rule B labels with empty topic_slug fall through to no-signal', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO session_commits (session_id, commit_sha, subject, authored_at) VALUES
        ('s1', 'a', 'whatever I did today', '2026-06-29T10:00:00Z');
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e1', 's1', '2026-06-29T11:00:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    const fakeClient = {
      backend: 'openrouter' as const,
      model: 'anthropic/claude-haiku-4.5',
      client: { chat: { completions: { create: mock.fn(async () => ({
        choices: [{ message: { content: JSON.stringify({ labels: [{ commit_sha: 'a', topic_slug: '' }] }) }}],
      })) }} } as any,
    };
    await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
    const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE id='e1'`).get() as { inferred_feature_key: string; inference_source: string };
    assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
    assert.equal(r.inference_source, 'no-signal');
  });

  test('Rule B no-commits with empty topic_slug falls through to no-signal', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);
    const fakeClient = {
      backend: 'openrouter' as const,
      model: 'anthropic/claude-haiku-4.5',
      client: { chat: { completions: { create: mock.fn(async () => ({
        choices: [{ message: { content: JSON.stringify({ topic_slug: '' }) }}],
      })) }} } as any,
    };
    await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
    const r = db.prepare(`SELECT inferred_feature_key, inference_source FROM usage_events WHERE session_id='s3'`).get() as { inferred_feature_key: string; inference_source: string };
    assert.equal(r.inferred_feature_key, 'uncategorized-mainline');
    assert.equal(r.inference_source, 'no-signal');
  });

  test('Rule B no-commits path: LLM names the session topic from title alone', async () => {
    const db = makeDb();
    seed(db);
    db.exec(`
      INSERT INTO usage_events (id, session_id, timestamp, repo, branch, model, estimated_cost_usd) VALUES
        ('e1', 's3', '2026-06-29T09:30:00Z', 'octo/tokentrail', 'main', 'm', 0.1);
    `);

    const fakeClient = {
      backend: 'openrouter' as const,
      model: 'anthropic/claude-haiku-4.5',
      client: {
        chat: {
          completions: {
            create: mock.fn(async () => ({
              choices: [{ message: { content: JSON.stringify({ topic_slug: 'no-commits-session-rework' }) }}],
            })),
          },
        },
      } as any,
    };

    const summary = await inferMainlineFeatures(db, { getLLMClient: () => fakeClient });
    assert.equal(summary.llmCalls, 1);
    const r = db.prepare(
      `SELECT inferred_feature_key, inferred_feature_name, inference_source
         FROM usage_events WHERE session_id='s3'`
    ).get() as { inferred_feature_key: string; inferred_feature_name: string; inference_source: string };
    assert.equal(r.inferred_feature_key, 'no-commits-session-rework');
    assert.equal(r.inferred_feature_name, 'No commits session rework');
    assert.equal(r.inference_source, 'session-title-llm');
  });
});
