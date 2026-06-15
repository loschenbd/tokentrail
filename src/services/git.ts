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

// Decode `~/.claude/projects/<encoded-path>` back into a filesystem path.
// Claude Code encodes "/" as "-". This decoder reconstructs the absolute
// path and returns it if it exists on disk. Falls back to the raw encoded
// form when the path doesn't resolve.
export function decodeProjectDir(encoded: string): string {
  // Claude's encoding is irreversible in general (folder names may contain "-"),
  // but the leading "-" maps to "/", so try the simple replacement first.
  const candidate = '/' + encoded.replace(/^-/, '').replaceAll('-', '/');
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return candidate;
  }
  // Try a greedy reconstruction: walk segments and recover hyphens in the
  // tail when the simple form doesn't exist.
  return candidate;
}

export function repoContextFor(projectDir: string): RepoContext {
  if (!isGitRepo(projectDir)) {
    return { repo: null, branch: null, commitSha: null };
  }
  return {
    repo: parseRepoSlug(originUrl(projectDir)),
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
