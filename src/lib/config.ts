import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

// Tokentrail's runtime config: extension knobs that let teams customize
// attribution without forking the source. All keys are optional; missing
// fields fall back to the built-in defaults.
//
// Resolution order (first match wins):
//   1. $TOKENTRAIL_CONFIG (explicit absolute path)
//   2. <cwd>/.tokentrail.json (project-local — gitignored by default)
//   3. ~/.config/tokentrail/config.json (user-level)
//   4. defaults only
//
// "extra" prefixes mean APPEND to the defaults. To replace a default
// entirely you'd have to fork — that's intentional, so common branch
// names like `main` keep working even if a user's config file is
// truncated or out of date.

export type RawBranchPattern = {
  pattern: string;
  /** Prefix applied to the slugified tail to build the feature_key. */
  keyPrefix?: string;
  /** Prefix applied to the humanized tail to build the feature_name. */
  namePrefix?: string;
};

export type CompiledBranchPattern = {
  pattern: RegExp;
  keyPrefix: string;
  namePrefix: string;
};

export type FeatureOverride = {
  featureKey: string;
  featureName: string;
};

export type SourceBudgets = { claude: number | null; copilot: number | null; cursor: number | null };

export type TokentrailConfig = {
  /** Extra branch names treated as mainline (added to default main/master/develop/staging). */
  extraMainlineBranches: string[];
  /**
   * Extra branch-prefix patterns. Each pattern's first capture group is the
   * tail; the resulting feature_key is `<keyPrefix><slug(tail)>` and the
   * feature_name is `<namePrefix><humanize(tail)>`.
   */
  extraBranchPatterns: CompiledBranchPattern[];
  /** Extra parent directory names that hold a user's project repos (added to default ['Projects']). */
  extraProjectsParentDirs: string[];
  /**
   * Manual (repo, branch) → feature overrides. Highest-priority signal in
   * attribution; use for cases that PR title / labels / branch prefix all
   * fail to capture.
   */
  featureOverrides: Record<string, FeatureOverride>;
  /** Where this config was loaded from (informational; null = defaults only). */
  source: string | null;
  /** Override path to Cursor's ai-code-tracking.db. Null = default location. */
  cursorTrackingDbPath: string | null;
  /** Override path to Cursor's globalStorage state.vscdb. Null = default. */
  cursorStateDbPath: string | null;
  /** Manually-pasted WorkosCursorSessionToken cookie value. Null = derive locally. */
  cursorSessionCookie: string | null;
  /** When false, skip the cursor.com network call entirely (local Source B still runs). */
  cursorCloudSpend: boolean;
  /** Override path to Copilot CLI's ~/.copilot/session-store.db. Null = default (honors $COPILOT_HOME). */
  copilotStorePath: string | null;
  /** Monthly spend budget in USD for burn-rate/forecast. Null = no budget set (feature off). */
  monthlyBudgetUsd: number | null;
  /** Day-of-month (1-28) the budget cycle resets. Default 1. Clamped to 1-28 to avoid short-month drift. */
  budgetCycleStartDay: number;
  /** Optional per-harness monthly caps. Each null = no cap for that source. */
  sourceBudgets: SourceBudgets;
};

const EMPTY_CONFIG: TokentrailConfig = {
  extraMainlineBranches: [],
  extraBranchPatterns: [],
  extraProjectsParentDirs: [],
  featureOverrides: {},
  source: null,
  cursorTrackingDbPath: null,
  cursorStateDbPath: null,
  cursorSessionCookie: null,
  cursorCloudSpend: true,
  copilotStorePath: null,
  monthlyBudgetUsd: null,
  budgetCycleStartDay: 1,
  sourceBudgets: { claude: null, copilot: null, cursor: null },
};

let cached: TokentrailConfig | null = null;

export function getConfig(): TokentrailConfig {
  if (cached) return cached;
  cached = loadConfig();
  return cached;
}

/** Clear the in-process cache. Tests should call this between cases. */
export function resetConfigCache(): void {
  cached = null;
}

function loadConfig(): TokentrailConfig {
  const path = resolveConfigPath();
  if (!path) return EMPTY_CONFIG;
  return loadConfigFrom(path);
}

export function loadConfigFrom(path: string): TokentrailConfig {
  const raw = readFileSync(path, 'utf-8').trim();
  if (raw.length === 0) return { ...EMPTY_CONFIG, source: path };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[tokentrail] failed to parse config at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return normalize(parsed, path);
}

function resolveConfigPath(): string | null {
  if (process.env.TOKENTRAIL_CONFIG) {
    const explicit = resolve(process.env.TOKENTRAIL_CONFIG);
    if (existsSync(explicit)) return explicit;
    console.warn(`[tokentrail] TOKENTRAIL_CONFIG points at ${explicit} but the file does not exist; using defaults.`);
    return null;
  }
  const projectLocal = resolve(process.cwd(), '.tokentrail.json');
  if (existsSync(projectLocal)) return projectLocal;
  const userLevel = join(homedir(), '.config', 'tokentrail', 'config.json');
  if (existsSync(userLevel)) return userLevel;
  return null;
}

function positiveOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function normalizeSourceBudgets(v: unknown): SourceBudgets {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return { claude: positiveOrNull(o.claude), copilot: positiveOrNull(o.copilot), cursor: positiveOrNull(o.cursor) };
}

function normalize(raw: unknown, source: string): TokentrailConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`[tokentrail] config at ${source} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    extraMainlineBranches: asStringArray(obj.extraMainlineBranches, 'extraMainlineBranches', source),
    extraBranchPatterns: compileBranchPatterns(obj.extraBranchPatterns, source),
    extraProjectsParentDirs: asStringArray(obj.extraProjectsParentDirs, 'extraProjectsParentDirs', source),
    featureOverrides: asOverrides(obj.featureOverrides, source),
    source,
    cursorTrackingDbPath: typeof obj.cursorTrackingDbPath === 'string' ? obj.cursorTrackingDbPath : null,
    cursorStateDbPath: typeof obj.cursorStateDbPath === 'string' ? obj.cursorStateDbPath : null,
    cursorSessionCookie: typeof obj.cursorSessionCookie === 'string' ? obj.cursorSessionCookie : null,
    cursorCloudSpend: obj.cursorCloudSpend !== false,
    copilotStorePath: typeof obj.copilotStorePath === 'string' ? obj.copilotStorePath : null,
    monthlyBudgetUsd:
      typeof obj.monthlyBudgetUsd === 'number' && obj.monthlyBudgetUsd > 0
        ? obj.monthlyBudgetUsd
        : null,
    budgetCycleStartDay: clampCycleDay(obj.budgetCycleStartDay),
    sourceBudgets: normalizeSourceBudgets(obj.sourceBudgets),
  };
}

// Budget cycle reset day, clamped to 1-28 so it exists in every month.
function clampCycleDay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(28, Math.max(1, Math.trunc(value)));
}

function asStringArray(value: unknown, key: string, source: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`[tokentrail] config ${key} must be a string array (at ${source})`);
  }
  return value as string[];
}

function compileBranchPatterns(value: unknown, source: string): CompiledBranchPattern[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`[tokentrail] config extraBranchPatterns must be an array (at ${source})`);
  }
  return value.map((p, i): CompiledBranchPattern => {
    if (typeof p !== 'object' || p === null) {
      throw new Error(`[tokentrail] extraBranchPatterns[${i}] must be an object (at ${source})`);
    }
    const raw = p as RawBranchPattern;
    if (typeof raw.pattern !== 'string') {
      throw new Error(`[tokentrail] extraBranchPatterns[${i}].pattern must be a string (at ${source})`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(raw.pattern);
    } catch (err) {
      throw new Error(
        `[tokentrail] extraBranchPatterns[${i}].pattern is not a valid regex: ${
          err instanceof Error ? err.message : String(err)
        } (at ${source})`
      );
    }
    return {
      pattern: regex,
      keyPrefix: typeof raw.keyPrefix === 'string' ? raw.keyPrefix : '',
      namePrefix: typeof raw.namePrefix === 'string' ? raw.namePrefix : '',
    };
  });
}

function asOverrides(value: unknown, source: string): Record<string, FeatureOverride> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[tokentrail] featureOverrides must be an object (at ${source})`);
  }
  const out: Record<string, FeatureOverride> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'object' || v === null) {
      throw new Error(`[tokentrail] featureOverrides["${k}"] must be an object with featureKey/featureName (at ${source})`);
    }
    const entry = v as Record<string, unknown>;
    if (typeof entry.featureKey !== 'string' || typeof entry.featureName !== 'string') {
      throw new Error(`[tokentrail] featureOverrides["${k}"] must have string featureKey and featureName (at ${source})`);
    }
    out[k] = {
      featureKey: entry.featureKey,
      featureName: entry.featureName,
    };
  }
  return out;
}

export type BudgetPatch = {
  monthlyBudgetUsd?: number | null;
  budgetCycleStartDay?: number;
  sourceBudgets?: Partial<SourceBudgets>;
};

// Where a write should land: $TOKENTRAIL_CONFIG first if set (returned even
// when that file doesn't exist yet — writes create it), else an existing
// resolvable config file, else the user-level path (created on demand).
// Never invents a project-local file that doesn't already exist.
function configTargetPath(): string {
  if (process.env.TOKENTRAIL_CONFIG) {
    return resolve(process.env.TOKENTRAIL_CONFIG);
  }
  return resolveConfigPath() ?? join(homedir(), '.config', 'tokentrail', 'config.json');
}

// The FIRST config writer. Narrow by design: touches only budget keys, keeps
// every unrelated key verbatim, writes atomically, and busts the cache so the
// next getConfig() reflects the change.
export function saveBudgetConfig(patch: BudgetPatch): { path: string } {
  const path = configTargetPath();
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) current = parsed as Record<string, unknown>;
    }
  }

  if ('monthlyBudgetUsd' in patch) {
    current.monthlyBudgetUsd = patch.monthlyBudgetUsd == null ? null : patch.monthlyBudgetUsd;
  }
  if ('budgetCycleStartDay' in patch && patch.budgetCycleStartDay !== undefined) {
    current.budgetCycleStartDay = Math.min(28, Math.max(1, Math.trunc(patch.budgetCycleStartDay)));
  }
  if (patch.sourceBudgets) {
    const existing = (typeof current.sourceBudgets === 'object' && current.sourceBudgets !== null
      ? current.sourceBudgets : {}) as Record<string, unknown>;
    for (const k of ['claude', 'copilot', 'cursor'] as const) {
      if (k in patch.sourceBudgets) existing[k] = patch.sourceBudgets[k] ?? null;
    }
    current.sourceBudgets = existing;
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
  resetConfigCache();
  return { path };
}
