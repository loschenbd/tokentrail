import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/dashboard/server.js';
import { getDb, closeDb } from '../src/db/db.js';

// Test harness: each test gets its own real temp-file SQLite DB via
// TRACKER_DB_PATH (the in-memory `:memory:` route would conflict with the
// getDb() singleton). Set the env var BEFORE calling buildServer() or
// getDb() so the singleton points at the temp DB on first access.
function withTempDb(): { restore: () => void } {
  const originalPath = process.env.TRACKER_DB_PATH;
  const tmpDir = mkdtempSync(join(tmpdir(), 'tokentrail-anom-actions-'));
  process.env.TRACKER_DB_PATH = join(tmpDir, 'test.db');
  return {
    restore: () => {
      closeDb();
      if (originalPath === undefined) delete process.env.TRACKER_DB_PATH;
      else process.env.TRACKER_DB_PATH = originalPath;
    },
  };
}

function insertAnomaly(opts: { dismissed: boolean; featureKey?: string }): number {
  const db = getDb();
  const info = db.prepare(
    `INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason, dismissed_at)
     VALUES ('feature_spike', '2026-06-16', ?, NULL, 10, 1, 10, '10x baseline', ?)`,
  ).run(opts.featureKey ?? 'feat-x', opts.dismissed ? '2026-06-16T00:00:00Z' : null);
  return Number(info.lastInsertRowid);
}

function getDismissedAt(id: number): string | null | undefined {
  const row = getDb().prepare('SELECT dismissed_at FROM anomalies WHERE id = ?').get(id) as
    | { dismissed_at: string | null }
    | undefined;
  return row ? row.dismissed_at : undefined;
}

describe('POST /api/anomalies/:id/dismiss', () => {
  test('returns 204 and sets dismissed_at when anomaly is active', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const id = insertAnomaly({ dismissed: false });
      assert.equal(getDismissedAt(id), null);

      const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/dismiss` });
      assert.equal(res.statusCode, 204);

      const after = getDismissedAt(id);
      assert.ok(after, 'dismissed_at should be populated');
      assert.match(after as string, /^\d{4}-\d{2}-\d{2}/);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 404 when the anomaly id does not exist', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/anomalies/9999/dismiss' });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 409 when the anomaly is already dismissed', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const id = insertAnomaly({ dismissed: true });
      const before = getDismissedAt(id);

      const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/dismiss` });
      assert.equal(res.statusCode, 409);

      // No mutation: dismissed_at unchanged.
      assert.equal(getDismissedAt(id), before);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 400 for a malformed id', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/anomalies/not-a-number/dismiss' });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
      t.restore();
    }
  });
});

describe('POST /api/anomalies/:id/restore', () => {
  test('returns 204 and clears dismissed_at when anomaly is dismissed', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const id = insertAnomaly({ dismissed: true });
      assert.ok(getDismissedAt(id));

      const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/restore` });
      assert.equal(res.statusCode, 204);

      assert.equal(getDismissedAt(id), null);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 404 when the anomaly id does not exist', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/anomalies/9999/restore' });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 409 when the anomaly is already active', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const id = insertAnomaly({ dismissed: false });
      assert.equal(getDismissedAt(id), null);

      const res = await app.inject({ method: 'POST', url: `/api/anomalies/${id}/restore` });
      assert.equal(res.statusCode, 409);

      assert.equal(getDismissedAt(id), null);
    } finally {
      await app.close();
      t.restore();
    }
  });

  test('returns 400 for a malformed id', async () => {
    const t = withTempDb();
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/anomalies/not-a-number/restore' });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.close();
      t.restore();
    }
  });
});
