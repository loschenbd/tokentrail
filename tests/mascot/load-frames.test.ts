import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadFramesFrom } from '../../src/mascot/load-frames.js';

describe('loadFramesFrom', () => {
  test('returns the parsed bundle for a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, JSON.stringify({
      cols: 36, rows: 16, centerIndex: 7,
      frames: [{ bend: { dx: 0, dy: 0 }, grid: [[' ']] }],
    }));
    const b = loadFramesFrom(path);
    assert.notEqual(b, null);
    assert.equal(b!.cols, 36);
    assert.equal(b!.frames.length, 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null for a missing file (no throw)', () => {
    assert.equal(loadFramesFrom('/nonexistent/path/frames.json'), null);
  });

  test('returns null for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, '{ not json');
    assert.equal(loadFramesFrom(path), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when shape is wrong (missing frames array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mascot-'));
    const path = join(dir, 'frames.json');
    writeFileSync(path, JSON.stringify({ cols: 36, rows: 16, centerIndex: 7 }));
    assert.equal(loadFramesFrom(path), null);
    rmSync(dir, { recursive: true, force: true });
  });
});
