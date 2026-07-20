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
  if (entry && entry.endsWith('.js')) {
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
