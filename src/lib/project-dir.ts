import { homedir } from 'node:os';
import { slugify } from './attribution.js';
import { getConfig, type TokentrailConfig } from './config.js';

// Default list of parent-directory names that hold a user's project repos.
// Extended via config.extraProjectsParentDirs (e.g. ['Code', 'dev', 'src']).
// Match is case-insensitive and allows a trailing 's' (so 'Project'/'Projects').
const DEFAULT_PROJECTS_PARENT_DIRS: ReadonlyArray<string> = ['Projects'];

// Derive a stable feature key + human label from a project directory path,
// used when no git repo context exists for a session.
//
// Examples (HOME = /Users/ben, default config):
//   /Users/ben                         → { key: 'outside:home',
//                                          name: 'Home' }
//   /Users/ben/Projects/anamnesis      → { key: 'outside:projects-anamnesis',
//                                          name: 'Anamnesis' }
//   /Users/ben/Documents/Claude        → { key: 'outside:documents-claude',
//                                          name: 'Documents/Claude' }
//   /Users/ben/Projects                → { key: 'outside:projects-root',
//                                          name: 'Projects (root)' }
//   /opt/some-tool                     → { key: 'outside:opt-some-tool',
//                                          name: 'opt/some-tool' }
//
// With `extraProjectsParentDirs: ['Code']` configured, /Users/ben/Code/foo
// gets the same `outside:projects-foo` treatment.

export type ProjectDirBucket = {
  featureKey: string;
  featureName: string;
};

export function bucketFromProjectDir(
  projectDir: string,
  config: TokentrailConfig = getConfig()
): ProjectDirBucket {
  const home = homedir();
  let path = projectDir.trim();
  if (!path) return { featureKey: 'untracked', featureName: 'Untracked sessions' };

  // Strip the user's home prefix so paths read cleanly.
  if (path === home) {
    return { featureKey: 'outside:home', featureName: 'Home' };
  }
  if (path.startsWith(home + '/')) {
    path = path.slice(home.length + 1);
  } else if (path.startsWith('/')) {
    path = path.slice(1);
  }

  // Take up to the last 2 segments so paths like
  // `Library/Application Support/CodexBar/ClaudeProbe` collapse to
  // `CodexBar/ClaudeProbe` — informative without being mile-long.
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) {
    return { featureKey: 'outside:root', featureName: '/' };
  }

  const parentDirs = [...DEFAULT_PROJECTS_PARENT_DIRS, ...config.extraProjectsParentDirs];

  // Special case: bare "Projects" (or any configured equivalent) — the
  // parent dir of all your repos.
  if (segments.length === 1 && isProjectsParentDir(segments[0], parentDirs)) {
    return {
      featureKey: 'outside:projects-root',
      featureName: 'Projects (root)',
    };
  }

  // Subdirectory of the user's Projects folder — that subdirectory's name
  // is the project's actual title. Use it directly instead of prefixing.
  if (
    segments.length >= 2 &&
    isProjectsParentDir(segments[segments.length - 2], parentDirs)
  ) {
    const name = segments[segments.length - 1]!;
    return {
      featureKey: `outside:projects-${slugify(name)}`,
      featureName: humanizeProjectName(name),
    };
  }

  const tail = segments.slice(-2).join('/');
  const slug = slugify(tail);
  return {
    featureKey: `outside:${slug}`,
    featureName: tail,
  };
}

function isProjectsParentDir(segment: string | undefined, parentDirs: ReadonlyArray<string>): boolean {
  if (!segment) return false;
  const lower = segment.toLowerCase();
  for (const dir of parentDirs) {
    const dirLower = dir.toLowerCase();
    // Allow a trailing-s plural variant for the "Projects" default;
    // exact match for configured extras.
    if (lower === dirLower) return true;
    if (dirLower === 'projects' && lower === 'project') return true;
  }
  return false;
}

function humanizeProjectName(s: string): string {
  const cleaned = s.replace(/[-_]+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned
    .split(' ')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
