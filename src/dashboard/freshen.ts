import { spawn } from 'node:child_process';
import { runIngest } from '../commands/ingest.js';
import { runRollup } from '../commands/rollup.js';
import { getDb } from '../db/db.js';

// The full-history rollup allocates native SQLite scratch (a GROUP BY +
// GROUP_CONCAT over every event) that better-sqlite3 frees but the OS
// allocator keeps resident — so running it in the long-lived daemon
// ratchets RSS to a plateau it never releases. Running it in a short-lived
// child process returns that memory to the OS on exit. Falls back to an
// in-process rollup whenever the child can't be spawned (dev/tsx runs where
// argv[1] is a .ts file, or any spawn error), so correctness never depends
// on the subprocess path succeeding.
const ROLLUP_SUBPROCESS_TIMEOUT_MS = 60_000;

async function runRollupIsolated(): Promise<void> {
  const entry = process.argv[1];
  // Take the subprocess path for any normal invocation node can re-exec —
  // the packaged daemon's entry is the Homebrew bin symlink
  // (`/opt/homebrew/bin/tokentrail`, no extension) or a dist `.js`, both of
  // which `node <entry>` runs directly. Only skip tsx/ts-node dev runs, where
  // argv[1] is a `.ts` file node can't run without a loader. Any spawn error
  // still falls through to the in-process rollup below.
  if (entry && !entry.endsWith('.ts')) {
    try {
      await spawnRollup(entry);
      return;
    } catch (err) {
      console.error(
        '[dashboard] isolated rollup failed, running in-process:',
        err instanceof Error ? err.message : err
      );
    }
  }
  await runRollup({ cluster: false });
}

function spawnRollup(entry: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Inherit env so TRACKER_DB_PATH (set in the daemon's launchd plist)
    // points the child at the same database. WAL + busy_timeout=5000 (set
    // in migrations on every connection) make the concurrent write safe.
    const child = spawn(process.execPath, [entry, 'rollup', '--no-cluster'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      if (stderr.length < 2000) stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('rollup subprocess timed out'));
    }, ROLLUP_SUBPROCESS_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`rollup subprocess exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Debounce window: at most one freshen per FRESHEN_DEBOUNCE_MS window.
// 30s is short enough that the menubar feels live (it polls every 60s)
// without compounding cost from rapid /today + /api/today calls.
const FRESHEN_DEBOUNCE_MS = 30_000;

let lastFreshenedAt = 0;
let inFlight: Promise<void> | null = null;

// Kick off ingest + rollup in the background so the next today-scoped
// request reads fresh data. Returns synchronously — never blocks the
// caller. We can't await this on the request thread: a no-op cycle is
// ~50ms (stat + watermark check per file), but a cycle with active
// sessions reads their appended tails and re-runs the rollup, which can
// take a second or two. The SwiftBar plugin gives up after 2s, so
// awaiting here makes the menubar look broken.
//
// runRollup deliberately recomputes ALL history (~60ms at 35k events):
// hook backfills and work-unit refreshes inside ingest can reattribute
// events on old dates, so scoping the rollup to "dates with new events"
// would leave stale rows behind.
//
// Tradeoff: the first request after a long quiet period sees the
// previous freshen's data (potentially one menubar tick stale). The
// next request sees the new data. For a polling client this is fine.
//
// Failures are caught — we log and let the next tick try again.
export function freshenIfStale(): void {
  // Commit/PR enrichment rides the same request path but on its own hourly
  // throttle — evaluate it before the ingest debounce so it isn't gated by it.
  enrichIfStale();

  const now = Date.now();
  if (now - lastFreshenedAt < FRESHEN_DEBOUNCE_MS) return;
  if (inFlight) return;
  lastFreshenedAt = now;
  inFlight = (async () => {
    try {
      const ingest = await runIngest();
      const stale = isRollupBehindEvents();
      if (ingest.newEvents > 0 || stale) {
        // Isolated + cluster-free: the rollup runs in a short-lived child so
        // its native memory is reclaimed on exit, and a passive poll can
        // never trigger an LLM call. Clustering runs on the explicit refresh
        // paths (run-all, the infer-mainline button) instead.
        await runRollupIsolated();
      }
    } catch (err) {
      console.error('[dashboard] freshen failed:', err);
    } finally {
      inFlight = null;
    }
  })();
}

// Commit + PR enrichment (a `git log` per new session; GitHub calls for PRs)
// is heavier than ingest and only needs to trail the live data loosely, so it
// runs on its own hourly throttle rather than every freshen. This is what keeps
// the per-session "N commits · M PRs" counts current — ingest+rollup alone
// never touch session_commits / session_prs, so without this they freeze at
// whenever the backfill was last run by hand.
const ENRICH_THROTTLE_MS = 60 * 60_000;

let lastEnrichedAt = 0;
let enrichInFlight = false;

// Pure throttle decision, exported for testing. Due when nothing is in flight
// and either it has never run (lastAt === 0) or a full throttle window passed.
export function enrichmentDue(
  now: number,
  lastAt: number,
  inFlight: boolean,
  throttleMs: number = ENRICH_THROTTLE_MS
): boolean {
  if (inFlight) return false;
  if (lastAt === 0) return true; // never run this process → due immediately
  return now - lastAt >= throttleMs;
}

// Fire-and-forget the commit + PR backfills in short-lived children (so their
// verbose per-call logging and any native memory stay out of the long-lived
// daemon), chained so commits (local, fast) finish before prs (GitHub). Updated
// counts appear on the next request after the children exit. No-ops in tsx dev
// runs (argv[1] is a .ts file node can't re-exec) and when a run is in flight.
function enrichIfStale(): void {
  const now = Date.now();
  if (!enrichmentDue(now, lastEnrichedAt, enrichInFlight)) return;
  const entry = process.argv[1];
  if (!entry || entry.endsWith('.ts')) return;
  lastEnrichedAt = now;
  enrichInFlight = true;
  spawnBackfill(entry, ['commits', '--backfill'], () => {
    spawnBackfill(entry, ['prs', '--backfill'], () => {
      enrichInFlight = false;
    });
  });
}

function spawnBackfill(entry: string, args: string[], onDone: () => void): void {
  try {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', (e) => {
      console.error(`[dashboard] enrich ${args[0]} spawn error:`, e.message);
      onDone();
    });
    child.on('exit', () => onDone());
  } catch (err) {
    console.error('[dashboard] enrich spawn failed:', err);
    onDone();
  }
}

function isRollupBehindEvents(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM usage_events
         WHERE created_at > COALESCE(
           (SELECT MAX(updated_at) FROM feature_rollups),
           '1970-01-01'
         )
       ) AS stale`
    )
    .get() as { stale: number };
  return row.stale === 1;
}
