import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceEventsByCommits } from '../src/services/mainline-inference-slicing.js';

const ev = (ts: string, id = ts) => ({ id, timestamp: ts });
const co = (sha: string, ts: string) => ({ sha, authoredAt: ts });

describe('sliceEventsByCommits()', () => {
  test('empty commits → empty result', () => {
    const out = sliceEventsByCommits([ev('2026-06-29T10:00:00Z')], []);
    assert.deepEqual(out, []);
  });

  test('single commit absorbs all events', () => {
    const events = [ev('2026-06-29T09:00:00Z'), ev('2026-06-29T11:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.commitSha, 'A');
    assert.equal(out[0]!.events.length, 2);
  });

  test('preamble events route to first commit', () => {
    const events = [ev('2026-06-29T08:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out[0]!.commitSha, 'A');
    assert.equal(out[0]!.events[0]!.id, '2026-06-29T08:00:00Z');
  });

  test('events between commits go to the earlier commit', () => {
    const events = [ev('2026-06-29T11:00:00Z')]; // between A (10:00) and B (12:00)
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const a = out.find((s) => s.commitSha === 'A');
    assert.equal(a?.events.length, 1);
  });

  test('tail events go to last commit', () => {
    const events = [ev('2026-06-29T13:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const b = out.find((s) => s.commitSha === 'B');
    assert.equal(b?.events.length, 1);
  });

  test('events exactly at commit timestamp belong to that commit (half-open intervals)', () => {
    const events = [ev('2026-06-29T12:00:00Z')];
    const commits = [co('A', '2026-06-29T10:00:00Z'), co('B', '2026-06-29T12:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    const b = out.find((s) => s.commitSha === 'B');
    assert.equal(b?.events.length, 1);
  });

  test('commits arrive in any order — output is sorted by authoredAt', () => {
    const events = [ev('2026-06-29T11:00:00Z')];
    const commits = [co('B', '2026-06-29T12:00:00Z'), co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out[0]!.commitSha, 'A');
    assert.equal(out[1]!.commitSha, 'B');
  });

  test('commits with no events get empty slice (still returned)', () => {
    const events: Array<{ id: string; timestamp: string }> = [];
    const commits = [co('A', '2026-06-29T10:00:00Z')];
    const out = sliceEventsByCommits(events, commits);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.events.length, 0);
  });
});
