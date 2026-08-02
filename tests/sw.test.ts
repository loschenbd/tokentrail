import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceWorkerJs } from '../src/dashboard/sw.js';
import { buildServer } from '../src/dashboard/server.js';
import { closeDb } from '../src/db/db.js';

describe('serviceWorkerJs', () => {
  test('caches static, versions the cache, and never caches api/html', () => {
    const src = serviceWorkerJs();
    assert.match(src, /addEventListener\(['"]install['"]/);
    assert.match(src, /addEventListener\(['"]fetch['"]/);
    assert.match(src, /tt-static-v\d+\.\d+\.\d+/, 'cache name must embed the semver');
    assert.match(src, /method\s*!==\s*['"]GET['"]/, 'fetch handler must bypass non-GET requests');
    assert.match(src, /startsWith\(\s*['"]\/static\/['"]\s*\)/, 'fetch handler must gate caching on the /static/ path prefix');
  });
});

describe('GET /sw.js', () => {
  test('serves the worker at root scope with no-cache and the versioned cache name', async () => {
    const original = process.env.TRACKER_DB_PATH;
    process.env.TRACKER_DB_PATH = join(mkdtempSync(join(tmpdir(), 'tt-sw-')), 'test.db');
    const app = buildServer({ defaultDays: 30 });
    try {
      const res = await app.inject({ method: 'GET', url: '/sw.js' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /text\/javascript/);
      assert.match(res.headers['cache-control'] as string, /no-cache/);
      assert.match(res.body, /tt-static-v\d+\.\d+\.\d+/);
    } finally {
      await app.close();
      closeDb();
      process.env.TRACKER_DB_PATH = original;
    }
  });
});
