import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Commit = {
  sha: string;
  subject: string;
  body: string;
  authoredAt: string;
  authorEmail: string;
  branches: string;
};

// Walk up from `dir` looking for a .git entry (file or directory — file
// means it's a worktree pointing at a real git dir elsewhere). Returns the
// first directory whose .git exists, or null if we walk to /.
export function findGitRoot(dir: string): string | null {
  let current = dir;
  while (current !== '/' && current !== '') {
    if (!existsSync(current)) {
      current = dirname(current);
      continue;
    }
    const dotGit = join(current, '.git');
    if (existsSync(dotGit)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

// Run `git log` constrained to a time window. Window is inclusive on both
// ends; we pad by a small buffer because Claude Code's session timestamps
// and git author times can differ by a few seconds.
//
// The branches column comes from `--branches --all` decoration and shows
// which named refs the commit is reachable from — useful for surfacing
// "the work happened on feat/X" even when the worktree's gone.
export function commitsInWindow(
  gitRoot: string,
  sinceIso: string,
  untilIso: string,
  authorEmail?: string
): Commit[] {
  const args = [
    'log',
    '--all',
    '--no-merges',
    `--since=${pad(sinceIso, -60)}`,
    `--until=${pad(untilIso, 60)}`,
    '--date=iso-strict',
    '--format=%H%x1f%s%x1f%b%x1f%aI%x1f%ae%x1f%D%x1e',
  ];
  if (authorEmail) {
    args.push(`--author=${authorEmail}`);
  }

  let raw: string;
  try {
    raw = execFileSync('git', args, {
      cwd: gitRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }

  const out: Commit[] = [];
  for (const record of raw.split('\x1e')) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\x1f');
    if (parts.length < 5) continue;
    out.push({
      sha: parts[0] ?? '',
      subject: parts[1] ?? '',
      body: (parts[2] ?? '').trim(),
      authoredAt: parts[3] ?? '',
      authorEmail: parts[4] ?? '',
      branches: cleanRefDecoration(parts[5] ?? ''),
    });
  }
  return out;
}

export function gitConfigEmail(): string | null {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pad(iso: string, deltaSeconds: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setSeconds(d.getSeconds() + deltaSeconds);
  return d.toISOString();
}

// `git log --format=%D` returns refs like "HEAD -> main, origin/main, tag: v1".
// Strip HEAD pointer and tags; keep only branch refs.
function cleanRefDecoration(refs: string): string {
  if (!refs) return '';
  return refs
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('tag:'))
    .map((s) => s.replace(/^HEAD -> /, ''))
    .join(', ');
}
