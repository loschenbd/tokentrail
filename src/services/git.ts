import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import type { RepoContext } from '../lib/types.js';

export function isGitRepo(cwd: string): boolean {
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return false;
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export function currentBranch(cwd: string): string | null {
  return runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function currentCommitSha(cwd: string): string | null {
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

export function originUrl(cwd: string): string | null {
  return runGit(cwd, ['remote', 'get-url', 'origin']);
}

// Returns "owner/repo" for github / gitlab / bitbucket-style remotes.
// Returns null if the URL doesn't parse cleanly.
export function parseRepoSlug(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  // git@github.com:owner/repo.git
  let m = remoteUrl.match(/^[^@]+@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  // https://github.com/owner/repo(.git)?
  m = remoteUrl.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

// Decode `~/.claude/projects/<encoded>` back into a filesystem path.
//
// Claude Code's encoding replaces both "/" and "." with "-", which is lossy:
// "foo-bar" could originally be "foo-bar", "foo/bar", "foo.bar" or "foo/.bar".
// The naive dash→slash replacement destroys folder names containing hyphens
// (e.g. "gemify-universal/.claude/worktrees/feat/gem-memory-date").
//
// This decoder uses the filesystem as an oracle: walk encoded chunks, greedy-
// extending each path segment to the longest existing directory. The "--"
// pattern (slash before a hidden dir) is decoded into a "/." boundary.
// Falls back to the naive form when nothing on disk matches — handles deleted
// projects gracefully.
export function decodeProjectDir(encoded: string): string {
  const trimmed = encoded.replace(/^-/, '');
  // Replace empty chunks (from "--") with a sentinel so we can distinguish
  // "/.hidden" boundaries from regular slashes in the segment walk.
  const chunks = trimmed.split('-');

  let path = '/';
  let i = 0;
  while (i < chunks.length) {
    // "--" in the encoded form → "/." in the decoded form (hidden dir).
    // First chunk is empty, next chunk is the (hidden) dir's name body.
    if (chunks[i] === '') {
      i++;
      if (i >= chunks.length) break;
      const next = '.' + chunks[i];
      path = joinPath(path, next);
      i++;
      continue;
    }

    // Greedy extend: find longest j s.t. chunks[i..j].join('-') is a real
    // subdirectory of `path`. Hyphens inside the joined name are restored.
    let bestJ = i;
    for (let j = i; j < chunks.length; j++) {
      if (chunks[j] === '') break; // next "--" boundary; stop here
      const candidate = chunks.slice(i, j + 1).join('-');
      const test = joinPath(path, candidate);
      if (existsSync(test) && statSync(test).isDirectory()) {
        bestJ = j;
      }
    }

    const name = chunks.slice(i, bestJ + 1).join('-');
    path = joinPath(path, name);
    i = bestJ + 1;
  }

  return path;
}

function joinPath(base: string, name: string): string {
  return base.endsWith('/') ? base + name : base + '/' + name;
}

export function repoContextFor(projectDir: string): RepoContext {
  if (!isGitRepo(projectDir)) {
    return { repo: null, branch: null, commitSha: null };
  }
  // Prefer the GitHub-style slug from the origin remote. Fall back to
  // local/<basename> so local-only git repos (no remote configured) still
  // get a stable repo identity for attribution and rollups.
  const slug = parseRepoSlug(originUrl(projectDir));
  const base = projectDir.split('/').filter(Boolean).pop() ?? 'unknown';
  return {
    repo: slug ?? `local/${base}`,
    branch: currentBranch(projectDir),
    commitSha: currentCommitSha(projectDir),
  };
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
