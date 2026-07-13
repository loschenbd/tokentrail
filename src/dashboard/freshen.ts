import { runIngest } from '../commands/ingest.js';
import { runRollup } from '../commands/rollup.js';
import { getDb } from '../db/db.js';

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
        await runRollup();
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
