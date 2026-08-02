import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/dashboard/server.js';
import { closeDb } from '../src/db/db.js';

describe('GET /manifest.webmanifest', () => {
  test('returns a standalone PWA manifest with icons', async () => {
    const original = process.env.TRACKER_DB_PATH;
    process.env.TRACKER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'tt-manifest-')), 'test.db');
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /application\/manifest\+json/);
      const m = res.json() as { name: string; display: string; start_url: string; icons: unknown[] };
      assert.equal(m.name, 'Tokentrail');
      assert.equal(m.display, 'standalone');
      assert.equal(m.start_url, '/');
      assert.equal(m.icons.length, 3);
    } finally {
      await app.close();
      closeDb();
      process.env.TRACKER_DB_PATH = original;
    }
  });
});
