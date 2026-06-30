export function sliceEventsByCommits<
  E extends { timestamp: string },
  C extends { sha: string; authoredAt: string },
>(events: E[], commits: C[]): Array<{ commitSha: string; events: E[] }> {
  if (commits.length === 0) return [];
  const sorted = [...commits].sort((a, b) =>
    a.authoredAt < b.authoredAt ? -1 : a.authoredAt > b.authoredAt ? 1 : 0
  );
  const slices: Array<{ commitSha: string; events: E[] }> = sorted.map((c) => ({
    commitSha: c.sha,
    events: [],
  }));

  for (const e of events) {
    // Find the index of the first commit whose authoredAt > event.timestamp.
    // Event belongs to the commit BEFORE that index (or the last commit if
    // no such index exists). Preamble events (before commit 0) go to slice 0.
    let idx = sorted.findIndex((c) => c.authoredAt > e.timestamp);
    if (idx === -1) idx = sorted.length; // tail
    const target = Math.max(0, idx - 1);
    // target is guaranteed in range [0, slices.length) by the clamped Math.max.
    slices[target]!.events.push(e);
  }

  // Preamble (events earlier than first commit) were assigned to target 0
  // by the loop above. But a literal event-before-first-commit would have
  // idx=0 (first commit comes after it), then target=max(0, -1)=0. Good.
  return slices;
}
