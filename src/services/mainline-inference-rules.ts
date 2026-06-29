import { slugify } from '../lib/attribution.js';

const CONVENTIONAL_RE =
  /^(feat|fix|chore|refactor|docs|test|perf|style|build|ci|revert)(?:\(([^)]+)\))?(!)?:\s/i;

export type CommitClassification = {
  key: string;
  name: string;
  source: 'commit-scope';
};

export function classifyCommit(subject: string): CommitClassification | null {
  const m = subject.trim().match(CONVENTIONAL_RE);
  if (!m) return null;
  const scope = (m[2] ?? '').trim();
  if (!scope) return null;
  const key = slugify(scope);
  if (!key) return null;
  return { key, name: humanize(scope), source: 'commit-scope' };
}

function humanize(s: string): string {
  const cleaned = s.replace(/[-_/]+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
