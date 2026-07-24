import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitExistsIn } from '../src/services/git.js';

function makeRepoWithCommit(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tt-git-'));
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  run(['init', '-q']);
  run(['config', 'user.email', 't@t.co']);
  run(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'hi');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  const sha = run(['rev-parse', 'HEAD']);
  return { dir, sha };
}

describe('commitExistsIn', () => {
  test('true for a sha in the repo, false otherwise', () => {
    const { dir, sha } = makeRepoWithCommit();
    assert.equal(commitExistsIn(dir, sha), true);
    assert.equal(commitExistsIn(dir, 'deadbeef00000000000000000000000000000000'), false);
  });

  test('false for a non-repo dir, no throw', () => {
    assert.equal(commitExistsIn('/tmp', 'deadbeef'), false);
  });
});
