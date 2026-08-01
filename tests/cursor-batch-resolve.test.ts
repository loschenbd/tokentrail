import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commitsPresentIn } from '../src/services/git.js';
import { resolveCommitRepos, type ResolveDeps } from '../src/commands/cursor.js';

function makeRepoWithCommit(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-batch-git-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.co']);
  run(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'hi');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return { dir, sha: run(['rev-parse', 'HEAD']) };
}

describe('commitsPresentIn (batched membership)', () => {
  test('returns only the shas present in the repo, in one call', () => {
    const { dir, sha } = makeRepoWithCommit();
    const fake = 'deadbeef00000000000000000000000000000000';
    const present = commitsPresentIn(dir, [sha, fake]);
    assert.equal(present.has(sha), true);
    assert.equal(present.has(fake), false);
    assert.equal(present.size, 1);
  });

  test('empty input does not shell git and returns an empty set', () => {
    const present = commitsPresentIn('/tmp', []);
    assert.equal(present.size, 0);
  });

  test('non-repo dir returns an empty set, no throw', () => {
    const present = commitsPresentIn('/tmp', ['deadbeef00000000000000000000000000000000']);
    assert.equal(present.size, 0);
  });
});

describe('resolveCommitRepos (batched, O(dirs) git spawns)', () => {
  test('resolves present shas to the repo slug and parks unknown ones', () => {
    const { dir, sha } = makeRepoWithCommit();
    const fake = 'deadbeef00000000000000000000000000000000';
    const map = resolveCommitRepos([sha, fake], [dir]);
    assert.ok(map.get(sha)?.startsWith('local/'));
    assert.equal(map.get(fake), null);
  });

  test('first candidate dir containing a sha wins', () => {
    const sha = 'a'.repeat(40);
    const calls: string[] = [];
    // Both dirs "contain" the sha; the first in the list must win.
    const deps: ResolveDeps = {
      isRepo: () => true,
      present: (dir, shas) => {
        calls.push(dir);
        return new Set(shas);
      },
      slug: (dir) => 'local/' + dir.split('/').pop(),
    };
    const map = resolveCommitRepos([sha], ['/repo/first', '/repo/second'], deps);
    assert.equal(map.get(sha), 'local/first');
    // second dir never queried: sha already resolved and removed from remaining
    assert.deepEqual(calls, ['/repo/first']);
  });

  test('issues at most one membership query per repo dir — O(dirs), not O(commits×dirs)', () => {
    const hashes = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(40, '0'));
    const repoDirs = ['/r/a', '/r/b', '/r/c'];
    const nonRepoDirs = ['/n/x', '/n/y'];
    let presentCalls = 0;
    const deps: ResolveDeps = {
      isRepo: (dir) => repoDirs.includes(dir),
      present: (dir, shas) => {
        presentCalls++;
        // /r/a owns the first 50, /r/b the next 50, /r/c none.
        if (dir === '/r/a') return new Set(shas.filter((h) => parseInt(h, 16) < 50));
        if (dir === '/r/b') return new Set(shas.filter((h) => { const n = parseInt(h, 16); return n >= 50 && n < 100; }));
        return new Set();
      },
      slug: (dir) => 'local/' + dir.split('/').pop(),
    };
    const map = resolveCommitRepos(hashes, [...repoDirs, ...nonRepoDirs], deps);
    // one query per repo dir, none for non-repo dirs
    assert.equal(presentCalls, repoDirs.length);
    // 100 resolved, 100 parked
    const resolved = [...map.values()].filter((v) => v !== null).length;
    assert.equal(resolved, 100);
    assert.equal(map.get(hashes[0]!), 'local/a');
    assert.equal(map.get(hashes[50]!), 'local/b');
    assert.equal(map.get(hashes[150]!), null);
  });
});
