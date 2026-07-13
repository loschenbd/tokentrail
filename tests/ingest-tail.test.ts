import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { _setDbForTest } from '../src/db/db.js';
import { runIngest } from '../src/commands/ingest.js';

function usageLine(id: string, ts: string): string {
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: {
        id,
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n'
  );
}

describe('runIngest tail reads', () => {
  let dir: string;
  let file: string;
  let db: Database.Database;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedLogDir = process.env.TRACKER_LOG_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tt-ingest-'));
    mkdirSync(join(dir, 'projects', '-tmp-proj'), { recursive: true });
    mkdirSync(join(dir, 'hooks'));
    file = join(dir, 'projects', '-tmp-proj', 'sess-1.jsonl');
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.TRACKER_LOG_DIR = join(dir, 'hooks');
    db = new Database(':memory:');
    runMigrations(db);
    _setDbForTest(db);
  });

  afterEach(() => {
    _setDbForTest(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedLogDir === undefined) delete process.env.TRACKER_LOG_DIR;
    else process.env.TRACKER_LOG_DIR = savedLogDir;
  });

  test('second run skips unchanged files; appended events ingest from the tail', async () => {
    writeFileSync(file, usageLine('msg_1', '2026-07-01T10:00:00.000Z'));

    const first = await runIngest();
    assert.equal(first.newEvents, 1);
    assert.equal(first.filesScanned, 1);

    const second = await runIngest();
    assert.equal(second.newEvents, 0);
    assert.equal(second.filesSkipped, 1);
    assert.equal(second.filesScanned, 0);

    appendFileSync(file, usageLine('msg_2', '2026-07-01T10:05:00.000Z'));
    const third = await runIngest();
    assert.equal(third.newEvents, 1);
    assert.equal(third.filesScanned, 1);

    const count = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    assert.equal(count.n, 2);

    // The tail scan saw only msg_2, but the session's first_seen_at must
    // still reflect msg_1 from the first scan.
    const sess = db
      .prepare('SELECT first_seen_at, last_seen_at FROM sessions WHERE session_id = ?')
      .get('sess-1') as { first_seen_at: string; last_seen_at: string };
    assert.equal(sess.first_seen_at, '2026-07-01T10:00:00.000Z');
    assert.equal(sess.last_seen_at, '2026-07-01T10:05:00.000Z');
  });

  test('a rewritten (shrunk) file is re-read from byte 0', async () => {
    writeFileSync(
      file,
      usageLine('msg_1', '2026-07-01T10:00:00.000Z') + usageLine('msg_2', '2026-07-01T10:01:00.000Z')
    );
    await runIngest();

    writeFileSync(file, usageLine('msg_3', '2026-07-01T11:00:00.000Z'));
    const result = await runIngest();
    assert.equal(result.newEvents, 1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    assert.equal(count.n, 3);
  });
});
