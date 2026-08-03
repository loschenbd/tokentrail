import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSquash,
  parseRelease,
  dedupeCommits,
  deriveShipped,
  type CommitInput,
  type ShippedPr,
} from '../src/dashboard/data/feature-shipped.js';

test('parseSquash extracts the PR number and the base subject', () => {
  assert.deepEqual(parseSquash('feat(x): foo (#64)'), { prNumber: 64, base: 'feat(x): foo' });
  assert.equal(parseSquash('feat(x): foo'), null);
  // A parenthetical that is not a trailing (#n) is not a squash marker.
  assert.equal(parseSquash('feat(x): foo (rework)'), null);
});

test('parseRelease matches only release: vX.Y.Z commits', () => {
  assert.equal(parseRelease('release: v0.12.0'), 'v0.12.0');
  assert.equal(parseRelease('release: v0.7.1'), 'v0.7.1');
  assert.equal(parseRelease('feat: release the hounds'), null);
});

// A realistic squash-merge history: each PR appears as a raw twin + a squash,
// interleaved with release milestones and some never-PR'd change commits.
function fixture(): CommitInput[] {
  const c = (sha: string, subject: string, authoredAt = '2026-08-01T10:00:00Z'): CommitInput => ({
    sha, subject, authoredAt, repo: 'o/r',
  });
  return [
    c('a1', 'feat(x): alpha'),               // raw twin of #64
    c('a2', 'feat(x): alpha (#64)'),         // squash of #64
    c('a3', 'release: v0.7.0'),
    c('b1', 'docs: notes'),                  // never-PR'd change commit
    c('b2', 'fix(y): beta'),                 // raw twin of #65
    c('b3', 'fix(y): beta (#65)'),           // squash of #65
    c('b4', 'release: v0.8.0'),
    c('c1', 'feat(z): gamma'),               // trailing unreleased change commit
  ];
}

test('dedupeCommits collapses squash twins and excludes release commits', () => {
  const r = dedupeCommits(fixture());
  // change commits = docs:notes + feat(z):gamma (the two never-PR'd); raw twins
  // a1/b2 and squashes a2/b3 and releases a3/b4 all excluded.
  assert.deepEqual(r.changeCommits.map((x) => x.sha), ['b1', 'c1']);
  assert.equal(r.releaseCount, 2);
  assert.deepEqual(r.mergedPrNumbers.sort(), [64, 65]);
  // work items = 2 change commits + 2 distinct PRs
  assert.equal(r.workItemCount, 4);
});

test('deriveShipped groups PRs under their release, newest first, with an Unreleased tail', () => {
  const prByNumber = new Map<number, ShippedPr>([
    [64, { repo: 'o/r', prNumber: 64, title: 'Alpha', url: 'u64' }],
    [65, { repo: 'o/r', prNumber: 65, title: 'Beta', url: 'u65' }],
  ]);
  const groups = deriveShipped(fixture(), prByNumber);
  // newest first: Unreleased (gamma) → v0.8.0 (#65, +1 change: docs) → v0.7.0 (#64)
  assert.deepEqual(groups.map((g) => g.version), [null, 'v0.8.0', 'v0.7.0']);

  const unreleased = groups[0]!;
  assert.equal(unreleased.prs.length, 0);
  assert.equal(unreleased.changeCommitCount, 1); // feat(z): gamma

  const v080 = groups[1]!;
  assert.deepEqual(v080.prs.map((p) => p.prNumber), [65]);
  assert.equal(v080.prs[0]!.title, 'Beta');
  assert.equal(v080.changeCommitCount, 1); // docs: notes

  const v070 = groups[2]!;
  assert.deepEqual(v070.prs.map((p) => p.prNumber), [64]);
  assert.equal(v070.changeCommitCount, 0);
});

test('deriveShipped falls back to the base subject when a PR is missing from the map', () => {
  const groups = deriveShipped(
    [
      { sha: 'x', subject: 'feat: thing (#99)', authoredAt: '2026-08-01T10:00:00Z', repo: 'o/r' },
      { sha: 'y', subject: 'release: v1.0.0', authoredAt: '2026-08-01T11:00:00Z', repo: 'o/r' },
    ],
    new Map()
  );
  assert.equal(groups[0]!.prs[0]!.title, 'feat: thing');
  assert.equal(groups[0]!.prs[0]!.prNumber, 99);
});
