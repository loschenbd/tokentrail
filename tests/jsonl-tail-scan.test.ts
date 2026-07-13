import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSessionFile } from '../src/services/jsonl-reader.js';
import type { AssistantUsage } from '../src/services/jsonl-reader.js';

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

function userLine(text: string, ts: string): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { content: text },
    }) + '\n'
  );
}

describe('scanSessionFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tt-scan-'));
    const projectDir = join(dir, '-Users-someone-proj');
    mkdirSync(projectDir);
    file = join(projectDir, 'session-abc.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function scan(start: number): Promise<{ events: AssistantUsage[]; scan: Awaited<ReturnType<typeof scanSessionFile>> }> {
    const events: AssistantUsage[] = [];
    const result = await scanSessionFile(file, start, (u) => events.push(u));
    return { events, scan: result };
  }

  test('full scan extracts usage events, title, and time bounds in one pass', async () => {
    writeFileSync(
      file,
      userLine('build the thing', '2026-07-01T10:00:00Z') +
        usageLine('msg_1', '2026-07-01T10:00:05Z') +
        usageLine('msg_2', '2026-07-01T10:01:00Z')
    );
    const { events, scan: s } = await scan(0);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventId, 'msg_1');
    assert.equal(s.meta.sessionId, 'session-abc');
    assert.equal(s.meta.title, 'build the thing');
    assert.equal(s.meta.firstSeenAt, '2026-07-01T10:00:00Z');
    assert.equal(s.meta.lastSeenAt, '2026-07-01T10:01:00Z');
  });

  test('consumedBytes equals file size for a newline-terminated file', async () => {
    const content = usageLine('msg_1', '2026-07-01T10:00:00Z');
    writeFileSync(file, content);
    const { scan: s } = await scan(0);
    assert.equal(s.consumedBytes, Buffer.byteLength(content));
  });

  test('resuming from consumedBytes reads only appended events', async () => {
    writeFileSync(file, usageLine('msg_1', '2026-07-01T10:00:00Z'));
    const first = await scan(0);
    assert.equal(first.events.length, 1);

    appendFileSync(file, usageLine('msg_2', '2026-07-01T10:05:00Z'));
    const second = await scan(first.scan.consumedBytes);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.eventId, 'msg_2');
    // Tail scan saw no user message — title must be null so the DB
    // upsert falls back to the stored value.
    assert.equal(second.scan.meta.title, null);
    assert.equal(second.scan.meta.firstSeenAt, '2026-07-01T10:05:00Z');
  });

  test('trailing complete line without newline is parsed and counted', async () => {
    const complete = usageLine('msg_1', '2026-07-01T10:00:00Z');
    const noNewline = usageLine('msg_2', '2026-07-01T10:01:00Z').trimEnd();
    writeFileSync(file, complete + noNewline);
    const { events, scan: s } = await scan(0);
    assert.equal(events.length, 2);
    assert.equal(s.consumedBytes, Buffer.byteLength(complete + noNewline));
  });

  test('mid-write fragment does not advance the watermark and is recovered next scan', async () => {
    const complete = usageLine('msg_1', '2026-07-01T10:00:00Z');
    const nextLine = usageLine('msg_2', '2026-07-01T10:01:00Z');
    const fragment = nextLine.slice(0, 25); // truncated JSON — invalid
    writeFileSync(file, complete + fragment);

    const first = await scan(0);
    assert.equal(first.events.length, 1);
    assert.equal(first.scan.consumedBytes, Buffer.byteLength(complete));

    // Writer finishes the line; resume must recover msg_2 whole.
    appendFileSync(file, nextLine.slice(25));
    const second = await scan(first.scan.consumedBytes);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.eventId, 'msg_2');
    assert.equal(second.scan.consumedBytes, Buffer.byteLength(complete + nextLine));
  });

  test('multibyte characters spanning chunk boundaries survive byte-accurate splitting', async () => {
    // A long line of multibyte content forces the emoji across the
    // 64KB stream chunk boundary.
    const pad = '♣'.repeat(40000);
    const line1 = userLine(`trail ${pad} 🗺️ end`, '2026-07-01T10:00:00Z');
    const line2 = usageLine('msg_1', '2026-07-01T10:00:05Z');
    writeFileSync(file, line1 + line2);
    const { events, scan: s } = await scan(0);
    assert.equal(events.length, 1);
    assert.equal(s.meta.title?.startsWith('trail ♣'), true);
    assert.equal(s.consumedBytes, Buffer.byteLength(line1 + line2));
  });
});
