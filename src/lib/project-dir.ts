import { homedir } from 'node:os';
import { slugify } from './attribution.js';

// Derive a stable feature key + human label from a project directory path,
// used when no git repo context exists for a session.
//
// Examples (HOME = /Users/ben):
//   /Users/ben                         → { key: 'outside:home',
//                                          name: 'Outside repos · home' }
//   /Users/ben/Documents/Claude        → { key: 'outside:documents-claude',
//                                          name: 'Outside repos · Documents/Claude' }
//   /Users/ben/Projects                → { key: 'outside:projects-root',
//                                          name: 'Outside repos · Projects root' }
//   /opt/some-tool                     → { key: 'outside:opt-some-tool',
//                                          name: 'Outside repos · opt/some-tool' }

export type ProjectDirBucket = {
  featureKey: string;
  featureName: string;
};

export function bucketFromProjectDir(projectDir: string): ProjectDirBucket {
  const home = homedir();
  let path = projectDir.trim();
  if (!path) return { featureKey: 'untracked', featureName: 'Untracked sessions' };

  // Strip the user's home prefix so paths read cleanly.
  if (path === home) {
    return { featureKey: 'outside:home', featureName: 'Outside repos · home' };
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
    return { featureKey: 'outside:root', featureName: 'Outside repos · /' };
  }

  // Special case: bare "Projects" — the parent dir of all your repos.
  if (segments.length === 1 && /^projects?$/i.test(segments[0] ?? '')) {
    return {
      featureKey: 'outside:projects-root',
      featureName: 'Outside repos · Projects root',
    };
  }

  const tail = segments.slice(-2).join('/');
  const slug = slugify(tail);
  return {
    featureKey: `outside:${slug}`,
    featureName: `Outside repos · ${tail}`,
  };
}
