import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import {
  dashboardPort,
  defaultDashboardPort,
  ensureDaemonToken,
  readDaemonToken,
  tokenPath,
} from '../src/lib/daemon-identity.js';
import { buildServer } from '../src/dashboard/server.js';
import { _setDbForTest } from '../src/db/db.js';
import { runMigrations } from '../src/db/migrations.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

describe('defaultDashboardPort', () => {
  test('first macOS user keeps 4920; each other user gets its own port', () => {
    assert.equal(defaultDashboardPort(501), 4920);
    assert.equal(defaultDashboardPort(502), 4921);
    assert.equal(defaultDashboardPort(503), 4922);
  });

  test('system and unknown uids fall back to 4920', () => {
    assert.equal(defaultDashboardPort(0), 4920);
    assert.equal(defaultDashboardPort(null), 4920);
  });

  test('network-account uids wrap into a valid port window', () => {
    const p = defaultDashboardPort(1_234_567_890);
    assert.ok(p >= 4920 && p < 5920, `got ${p}`);
  });

  test('$TOKENTRAIL_PORT overrides the default', () => {
    const prev = process.env.TOKENTRAIL_PORT;
    try {
      process.env.TOKENTRAIL_PORT = '5123';
      assert.equal(dashboardPort(), 5123);
      process.env.TOKENTRAIL_PORT = 'nonsense';
      assert.equal(dashboardPort(), defaultDashboardPort());
    } finally {
      if (prev === undefined) delete process.env.TOKENTRAIL_PORT;
      else process.env.TOKENTRAIL_PORT = prev;
    }
  });
});

describe('ensureDaemonToken', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tt-token-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('creates an owner-only token once and reuses it', () => {
    assert.equal(readDaemonToken(dir), null);
    const a = ensureDaemonToken(dir);
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(statSync(tokenPath(dir)).mode & 0o777, 0o600);
    assert.equal(ensureDaemonToken(dir), a);
  });
});

describe('dashboard auth gate', () => {
  const TOKEN = 'a'.repeat(64);
  const PORT = 4999;
  let db: DatabaseType.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    _setDbForTest(db);
  });
  afterEach(() => {
    _setDbForTest(null);
    db.close();
  });

  const app = () => buildServer({ defaultDays: 30, authToken: TOKEN, port: PORT });

  test('every response names the owning uid; /api/whoami reports it', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/whoami' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.app, 'tokentrail');
    assert.equal(body.port, PORT);
    assert.equal(body.uid, process.getuid!());
    assert.equal(res.headers['x-tokentrail-uid'], String(process.getuid!()));
  });

  test('mutations without the token are refused with an explanation', async () => {
    const res = await app().inject({ method: 'POST', url: '/api/anomalies/9999/dismiss' });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /menu-bar app/);
  });

  test('a wrong token is refused', async () => {
    const res = await app().inject({
      method: 'POST', url: '/api/anomalies/9999/dismiss', headers: { 'x-tokentrail-token': 'b'.repeat(64) },
    });
    assert.equal(res.statusCode, 403);
  });

  test('the token header or the port-scoped cookie lets a mutation through', async () => {
    const viaHeader = await app().inject({
      method: 'POST', url: '/api/anomalies/9999/dismiss', headers: { 'x-tokentrail-token': TOKEN },
    });
    assert.equal(viaHeader.statusCode, 404); // reached the handler

    const viaCookie = await app().inject({
      method: 'POST', url: '/api/anomalies/9999/dismiss', headers: { cookie: `other=1; tt_auth_${PORT}=${TOKEN}` },
    });
    assert.equal(viaCookie.statusCode, 404);

    const otherPortCookie = await app().inject({
      method: 'POST', url: '/api/anomalies/9999/dismiss', headers: { cookie: `tt_auth_4920=${TOKEN}` },
    });
    assert.equal(otherPortCookie.statusCode, 403);
  });

  test('the attribution-rewriting stream counts as a mutation', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/infer-mainline/stream' });
    assert.equal(res.statusCode, 403);
  });

  test('reads stay open', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/settings' });
    assert.equal(res.statusCode, 200);
  });

  test('?tt= with the right token sets the cookie and redirects the token away', async () => {
    const res = await app().inject({ method: 'GET', url: `/settings?days=7&tt=${TOKEN}` });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/settings?days=7');
    const cookie = String(res.headers['set-cookie']);
    assert.match(cookie, new RegExp(`^tt_auth_${PORT}=${TOKEN};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('?tt= with a wrong token redirects without a cookie', async () => {
    const res = await app().inject({ method: 'GET', url: '/?tt=nope' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/');
    assert.equal(res.headers['set-cookie'], undefined);
  });
});
