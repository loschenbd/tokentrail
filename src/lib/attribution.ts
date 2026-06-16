import { FEATURE_OVERRIDES } from '../../config/feature-map.js';

export type AttributionInput = {
  repo: string;
  branch: string;
  prLabels?: ReadonlyArray<string>;
  prTitle?: string | null;
};

export type Attribution = {
  featureKey: string;
  featureName: string;
  source:
    | 'override'
    | 'pr-label'
    | 'pr-title'
    | 'branch-prefix'
    | 'mainline'
    | 'branch-slug';
};

const MAINLINE = new Set(['main', 'master', 'develop', 'staging']);

// Labels we should ignore as feature signal — too generic to be meaningful.
const GENERIC_LABELS = new Set([
  'bug',
  'enhancement',
  'feature',
  'good first issue',
  'help wanted',
  'duplicate',
  'invalid',
  'question',
  'wontfix',
  'documentation',
  'dependencies',
  'chore',
  'ci',
  'ready for review',
  'in progress',
  'wip',
]);

const BRANCH_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  key: (slug: string) => string;
  name: (slug: string) => string;
}> = [
  {
    pattern: /^(?:feature|feat)\/(.+)$/i,
    key: (s) => slugify(s),
    name: (s) => humanize(s),
  },
  {
    pattern: /^(?:fix|bugfix|hotfix)\/(.+)$/i,
    key: (s) => `fix-${slugify(s)}`,
    name: (s) => `Fix: ${humanize(s)}`,
  },
  {
    pattern: /^chore\/(.+)$/i,
    key: (s) => `chore-${slugify(s)}`,
    name: (s) => `Chore: ${humanize(s)}`,
  },
  {
    pattern: /^(?:spike|research)\/(.+)$/i,
    key: (s) => `research-${slugify(s)}`,
    name: (s) => `Research: ${humanize(s)}`,
  },
  {
    pattern: /^(?:deps|dependabot)\/.+$/i,
    key: () => 'deps-update',
    name: () => 'Dependency updates',
  },
];

export function attribute(input: AttributionInput): Attribution {
  // 1. Manual override
  const overrideKey = `${input.repo}:${input.branch}`;
  const override = FEATURE_OVERRIDES[overrideKey];
  if (override) {
    return {
      featureKey: override.featureKey,
      featureName: override.featureName,
      source: 'override',
    };
  }

  // 2. PR label (non-generic only)
  for (const label of input.prLabels ?? []) {
    const normalized = label.trim().toLowerCase();
    if (!normalized) continue;
    if (GENERIC_LABELS.has(normalized)) continue;
    return {
      featureKey: slugify(label),
      featureName: label,
      source: 'pr-label',
    };
  }

  // 3. PR title
  if (input.prTitle && input.prTitle.trim().length > 0) {
    return {
      featureKey: slugify(input.prTitle),
      featureName: input.prTitle.trim(),
      source: 'pr-title',
    };
  }

  // 4. Branch prefix patterns
  for (const { pattern, key, name } of BRANCH_PATTERNS) {
    const m = input.branch.match(pattern);
    if (m) {
      const tail = m[1] ?? '';
      return {
        featureKey: key(tail),
        featureName: name(tail),
        source: 'branch-prefix',
      };
    }
  }

  // 5. Mainline fallback — scope by repo so two repos' main branches don't
  // collapse into one giant bucket. Falls back to a global key only when
  // the repo is empty (shouldn't happen, but be defensive).
  if (MAINLINE.has(input.branch.toLowerCase())) {
    const branchLower = input.branch.toLowerCase();
    if (input.repo) {
      const repoSlug = slugify(input.repo);
      const repoLabel = input.repo.split('/').pop() ?? input.repo;
      return {
        featureKey: `mainline-${repoSlug}-${branchLower}`,
        featureName: `${repoLabel} (${input.branch})`,
        source: 'mainline',
      };
    }
    return {
      featureKey: `mainline-${branchLower}`,
      featureName: `Mainline (${input.branch})`,
      source: 'mainline',
    };
  }

  // 6. Default: slugified branch name
  return {
    featureKey: slugify(input.branch),
    featureName: humanize(input.branch),
    source: 'branch-slug',
  };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

function humanize(s: string): string {
  const cleaned = s.replace(/[-_/]+/g, ' ').trim();
  if (!cleaned) return 'Untitled';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
