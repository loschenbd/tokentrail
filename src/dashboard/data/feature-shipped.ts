// Pure derivation for the Feature page's "What shipped" zone and the deduped
// commit accounting. Squash-merge workflows record each PR twice in
// session_commits — once as the raw work commit ("feat(x): foo") and once as the
// squash on master ("feat(x): foo (#64)") — plus separate "release: vX.Y.Z"
// milestone commits. This module collapses the twins, drops the release commits
// from work counts, and groups the merged PRs under the release they rode.
//
// Kept pure (no DB) so it unit-tests in isolation.

export type CommitInput = {
  sha: string;
  subject: string;
  authoredAt: string | null;
  repo: string | null;
};

export type ShippedPr = { repo: string; prNumber: number; title: string; url: string };

export type ShippedRelease = {
  version: string | null; // null = trailing "Unreleased" group
  date: string | null; // release commit's authored date
  prs: ShippedPr[];
  changeCommitCount: number; // non-PR, non-release work commits in the group
};

const SQUASH_RE = /\s\(#(\d+)\)$/;
const RELEASE_RE = /^release:\s*(v[0-9][0-9A-Za-z.\-]*)\s*$/;

export function parseSquash(subject: string): { prNumber: number; base: string } | null {
  const m = subject.match(SQUASH_RE);
  if (!m) return null;
  return { prNumber: Number(m[1]), base: subject.replace(SQUASH_RE, '') };
}

export function parseRelease(subject: string): string | null {
  const m = subject.match(RELEASE_RE);
  return m ? m[1]! : null;
}

export type DedupeResult = {
  // Work commits that never became their own PR (release commits and squash
  // raw-twins removed) — the "extra" commits beyond the merged PRs.
  changeCommits: CommitInput[];
  // Deduped work-item count = change commits + distinct PRs (each twin pair
  // counts once). This is the honest "N commits" for the header.
  workItemCount: number;
  mergedPrNumbers: number[];
  releaseCount: number;
};

export function dedupeCommits(commits: CommitInput[]): DedupeResult {
  const squashBases = new Set<string>();
  const prNums = new Set<number>();
  let releaseCount = 0;
  for (const c of commits) {
    const sq = parseSquash(c.subject);
    if (sq) {
      squashBases.add(sq.base);
      prNums.add(sq.prNumber);
    } else if (parseRelease(c.subject)) {
      releaseCount++;
    }
  }
  const changeCommits: CommitInput[] = [];
  for (const c of commits) {
    if (parseSquash(c.subject)) continue; // the PR side — counted as a PR, not a commit
    if (parseRelease(c.subject)) continue; // milestone, not a work commit
    if (squashBases.has(c.subject)) continue; // raw twin of a squash → collapse
    changeCommits.push(c);
  }
  return {
    changeCommits,
    workItemCount: changeCommits.length + prNums.size,
    mergedPrNumbers: [...prNums],
    releaseCount,
  };
}

// Walk commits chronologically, closing a release group on each "release:"
// commit; merged PRs (squash commits) attach to the group they fall in. Returns
// newest-first, with a trailing version:null group only when unreleased work
// commits/PRs exist after the last release.
export function deriveShipped(
  commits: CommitInput[],
  prByNumber: Map<number, ShippedPr>
): ShippedRelease[] {
  const sorted = [...commits].sort((a, b) => {
    const ta = a.authoredAt ?? '';
    const tb = b.authoredAt ?? '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const squashBases = new Set<string>();
  for (const c of sorted) {
    const sq = parseSquash(c.subject);
    if (sq) squashBases.add(sq.base);
  }

  const groups: ShippedRelease[] = [];
  let curPrs: ShippedPr[] = [];
  let curChange = 0;
  const flush = (version: string | null, date: string | null) => {
    if (version === null && curPrs.length === 0 && curChange === 0) return;
    groups.push({ version, date, prs: curPrs, changeCommitCount: curChange });
    curPrs = [];
    curChange = 0;
  };
  for (const c of sorted) {
    const rel = parseRelease(c.subject);
    if (rel) {
      flush(rel, c.authoredAt);
      continue;
    }
    const sq = parseSquash(c.subject);
    if (sq) {
      curPrs.push(
        prByNumber.get(sq.prNumber) ?? {
          repo: c.repo ?? '',
          prNumber: sq.prNumber,
          title: sq.base,
          url: '',
        }
      );
      continue;
    }
    if (squashBases.has(c.subject)) continue; // raw twin
    curChange++;
  }
  flush(null, null);
  return groups.reverse();
}
