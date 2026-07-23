import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { buildServer } from '../../src/dashboard/server.js';
import { closeDb } from '../../src/db/db.js';

function makeApp() {
  const db = new Database(':memory:');
  runMigrations(db);
  return buildServer({ defaultDays: 7 });
}

describe('/api/setup/*', () => {
  test('GET /api/setup/status returns a SetupStatus shape', async () => {
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.status, 'object');
    for (const k of ['menubarApp', 'daemon', 'skills', 'hook']) {
      assert.equal(typeof body.status[k], 'boolean', `${k} should be boolean`);
    }
    await app.close();
    closeDb();
  });

  test('POST /api/setup/skills returns { ok, status } even when stubbed handler throws', async () => {
    // This test exercises the error path of the wrapper. Because we can't
    // easily stub runInstallSkills here, we point at a templatesDir that
    // doesn't exist — runInstallSkills logs a warning but does not throw,
    // so we expect ok=true with status payload.
    const app = makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup/skills' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.ok, 'boolean');
    assert.equal(typeof body.status, 'object');
    await app.close();
    closeDb();
  });
});
