import { execFile } from 'node:child_process';

// Claude subscription usage limits (the 5-hour and weekly windows), read the
// way Moshi and CodexBar do: Claude Code's own OAuth login from the macOS
// Keychain, sent to Anthropic's undocumented usage endpoint. Read-only by
// design: we never refresh the token. Users report Claude Code's refresh
// tokens behave as single-use (anthropics/claude-code#54443), so a refresh
// from here could strand Claude Code with a dead one and force a re-login.
// An expired token just leaves the last numbers stale until Claude Code
// renews it on its next run.

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

const OK_INTERVAL_MS = 3 * 60_000;          // a fresh reading every 3 min at most
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;  // floor after a 429
const ERROR_RETRY_MS = 5 * 60_000;          // 5xx / unexpected shape
const NETWORK_RETRY_MS = 60_000;            // connect failures are usually our own blocked event loop
const TICK_MS = 30_000;                     // how often the daemon checks whether a refresh is due
const FIRST_WAIT_MS = 1500;                 // the menu bar's request timeout is 2 s
const LOGIN_RETRY_MS = 60_000;              // expired or rejected: re-read the Keychain soon
const NO_LOGIN_RETRY_MS = 10 * 60_000;      // no subscription login on this Mac

const NOTE_EXPIRED = "Claude Code's login has expired. It renews the next time Claude Code runs.";
const NOTE_REJECTED = 'Claude rejected the saved login. It renews the next time Claude Code runs.';
const NOTE_RATE_LIMITED = 'Usage checks are rate-limited. Retrying shortly.';
const NOTE_UNREACHABLE = "Couldn't reach Claude to check usage.";
const NOTE_BAD_SHAPE = "Claude's usage response changed shape.";

export type LimitWindow = {
  label: string;
  pct: number;              // 0–100
  resetsAt: string | null;  // ISO
  severity: string | null;  // Anthropic's own rating ("normal", …) when given
};

export type ClaudeLimits = {
  plan: string | null;            // "Max 20x"
  session: LimitWindow | null;    // the 5-hour window
  weekly: LimitWindow | null;
  models: LimitWindow[];          // per-model weekly caps ("Fable")
  fetchedAt: string | null;       // when these numbers were read; null if never
  stale: boolean;                 // the latest refresh failed; numbers are from fetchedAt
  note: string | null;            // why, when stale
};

export type ClaudeCredentials = { accessToken: string; expiresAt: number | null; plan: string | null };

type UsageWindows = Pick<ClaudeLimits, 'session' | 'weekly' | 'models'>;

export function planLabel(subscriptionType: string | null | undefined, rateLimitTier: string | null | undefined): string | null {
  const sub = (subscriptionType ?? '').trim().toLowerCase();
  if (!sub) return null;
  if (sub === 'max') {
    const mult = /(\d+)x/.exec(rateLimitTier ?? '')?.[1];
    return mult ? `Max ${mult}x` : 'Max';
  }
  return sub[0]!.toUpperCase() + sub.slice(1);
}

export function parseCredentials(raw: string): ClaudeCredentials | null {
  try {
    const o = JSON.parse(raw)?.claudeAiOauth;
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null;
    return {
      accessToken: o.accessToken,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
      plan: planLabel(o.subscriptionType, o.rateLimitTier),
    };
  } catch { return null; }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// Anthropic sends microseconds and an offset ("…:00.162905+00:00"); clients
// get plain millisecond ISO, which every date parser takes.
function iso(v: unknown): string | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function legacyWindow(label: string, v: unknown): LimitWindow | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const pct = num(o.utilization);
  return pct === null ? null : { label, pct, resetsAt: iso(o.resets_at), severity: null };
}

// Prefers the structured `limits` list; falls back to the older five_hour /
// seven_day / seven_day_<model> fields. Null when neither window is present.
export function parseUsage(json: unknown): UsageWindows | null {
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, any>;
  let session: LimitWindow | null = null;
  let weekly: LimitWindow | null = null;
  const models: LimitWindow[] = [];

  if (Array.isArray(o.limits)) {
    for (const l of o.limits) {
      if (typeof l !== 'object' || l === null) continue;
      const pct = num(l.percent);
      if (pct === null) continue;
      const w = (label: string): LimitWindow => ({ label, pct, resetsAt: iso(l.resets_at), severity: str(l.severity) });
      if (l.kind === 'session') session = w('5-hour');
      else if (l.kind === 'weekly_all') weekly = w('Weekly');
      else if (l.kind === 'weekly_scoped') {
        const name = str(l.scope?.model?.display_name);
        if (name) models.push(w(name));
      }
    }
  }
  if (!session && !weekly) {
    session = legacyWindow('5-hour', o.five_hour);
    weekly = legacyWindow('Weekly', o.seven_day);
    for (const [key, label] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']] as const) {
      const m = legacyWindow(label, o[key]);
      if (m) models.push(m);
    }
  }
  if (!session && !weekly) return null;
  return { session, weekly, models };
}

export async function readKeychainCredentials(): Promise<ClaudeCredentials | null> {
  if (process.platform !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseCredentials(stdout)));
  });
}

type FetchResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number; retryAfterMs: number | null; error?: string };

async function fetchUsage(token: string, fetchImpl: typeof fetch): Promise<FetchResult> {
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA, 'User-Agent': 'tokentrail' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const secs = num(res.headers.get('retry-after'));
      return { ok: false, status: res.status, retryAfterMs: secs === null ? null : secs * 1000 };
    }
    return { ok: true, json: await res.json() };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    return { ok: false, status: 0, retryAfterMs: null, error: e.cause?.code ?? e.name ?? 'error' };
  }
}

// A window whose reset has passed has started over; showing its old
// percentage (from a snapshot we couldn't refresh) would overstate it.
function resetIfPassed(w: LimitWindow | null, now: number): LimitWindow | null {
  if (!w?.resetsAt) return w;
  const t = Date.parse(w.resetsAt);
  return Number.isFinite(t) && t <= now ? { label: w.label, pct: 0, resetsAt: null, severity: null } : w;
}

export type LimitsDeps = {
  readCredentials: () => Promise<ClaudeCredentials | null>;
  fetchImpl: typeof fetch;
  now: () => number;
  log: (msg: string) => void;
};

// Refreshes run on the daemon's own timer, never from a request. A request
// to /api/today also kicks ingest, whose synchronous stretches stall the
// event loop; a fetch started alongside it has its connect attempts time out
// (ETIMEDOUT), and a request-triggered refresh would collide every time.
export class ClaudeLimitsMonitor {
  private current: ClaudeLimits | null = null;
  private nextAttemptAt = 0;
  private inFlight: Promise<void> | null = null;
  private settledOnce = false;
  private rejectedToken: string | null = null;
  private lastLogged: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: LimitsDeps) {}

  /** Checks every TICK_MS whether a refresh is due. Daemon only. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  /** Refreshes if one is due; resolves when any refresh in flight is done. */
  tick(): Promise<void> {
    if (!this.inFlight && this.deps.now() >= this.nextAttemptAt) {
      this.inFlight = this.refresh().finally(() => { this.inFlight = null; this.settledOnce = true; });
    }
    return this.inFlight ?? Promise.resolve();
  }

  // The latest reading. Before the very first refresh has finished it waits
  // briefly, so the menu bar usually has numbers on its first poll, but never
  // long enough to push /api/today past the app's request timeout.
  async snapshot(): Promise<ClaudeLimits | null> {
    if (!this.settledOnce) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.tick(), new Promise((r) => { timer = setTimeout(r, FIRST_WAIT_MS); })]);
      clearTimeout(timer);
    }
    const s = this.current;
    if (!s) return null;
    const now = this.deps.now();
    return { ...s, session: resetIfPassed(s.session, now), weekly: resetIfPassed(s.weekly, now),
      models: s.models.map((m) => resetIfPassed(m, now)!) };
  }

  private async refresh(): Promise<void> {
    const now = this.deps.now();
    let creds: ClaudeCredentials | null = null;
    try { creds = await this.deps.readCredentials(); } catch { creds = null; }
    if (!creds) {
      this.current = null;
      this.nextAttemptAt = now + NO_LOGIN_RETRY_MS;
      return;
    }
    if (creds.expiresAt !== null && creds.expiresAt <= now) return this.fail(creds, NOTE_EXPIRED, now + LOGIN_RETRY_MS);
    if (creds.accessToken === this.rejectedToken) return this.fail(creds, NOTE_REJECTED, now + LOGIN_RETRY_MS);

    const res = await fetchUsage(creds.accessToken, this.deps.fetchImpl);
    if (res.ok) {
      const usage = parseUsage(res.json);
      if (!usage) return this.fail(creds, NOTE_BAD_SHAPE, now + ERROR_RETRY_MS);
      this.current = { plan: creds.plan, ...usage, fetchedAt: new Date(now).toISOString(), stale: false, note: null };
      this.nextAttemptAt = now + OK_INTERVAL_MS;
      this.lastLogged = null;
      return;
    }
    if (res.status === 401 || res.status === 403) {
      this.rejectedToken = creds.accessToken;
      return this.fail(creds, NOTE_REJECTED, now + LOGIN_RETRY_MS);
    }
    if (res.status === 429) {
      return this.fail(creds, NOTE_RATE_LIMITED, now + Math.max(RATE_LIMIT_BACKOFF_MS, res.retryAfterMs ?? 0));
    }
    if (res.status === 0) return this.fail(creds, NOTE_UNREACHABLE, now + NETWORK_RETRY_MS, res.error);
    this.fail(creds, NOTE_UNREACHABLE, now + ERROR_RETRY_MS, `HTTP ${res.status}`);
  }

  // Keep the last good numbers, flag them stale, and log once per new reason.
  private fail(creds: ClaudeCredentials, note: string, nextAttemptAt: number, detail?: string): void {
    const prev = this.current;
    this.current = {
      plan: creds.plan,
      session: prev?.session ?? null,
      weekly: prev?.weekly ?? null,
      models: prev?.models ?? [],
      fetchedAt: prev?.fetchedAt ?? null,
      stale: true,
      note,
    };
    this.nextAttemptAt = nextAttemptAt;
    const line = `Claude limits: ${note}${detail ? ` (${detail})` : ''}`;
    if (line !== this.lastLogged) { this.deps.log(line); this.lastLogged = line; }
  }
}

let monitor: ClaudeLimitsMonitor | null = null;

export function claudeLimitsMonitor(): ClaudeLimitsMonitor {
  monitor ??= new ClaudeLimitsMonitor({
    readCredentials: readKeychainCredentials,
    fetchImpl: fetch,
    now: Date.now,
    log: (msg) => console.warn(msg),
  });
  return monitor;
}
