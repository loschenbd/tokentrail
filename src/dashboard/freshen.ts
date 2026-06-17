import { runIngest } from '../commands/ingest.js';
import { runRollup } from '../commands/rollup.js';
import { getDb } from '../db/db.js';

// Debounce window: at most one freshen per FRESHEN_DEBOUNCE_MS window.
// 30s is short enough that the menubar feels live (it polls every 60s)
// without compounding cost from rapid /today + /api/today calls.
const FRESHEN_DEBOUNCE_MS = 30_000;

let lastFreshenedAt = 0;
let inFlight: Promise<void> | null = null;

// Run ingest + rollup before serving a today-scoped request so the user
// always sees fresh totals even when the post-session rollup hook hasn't
// fired (e.g. long-running Claude Code sessions, or no session has ended
// since the last data was logged). Cheap when nothing's stale: ingest is
// a no-op if no JSONL has changed, rollup only runs when ingest pulled
// new events or feature_rollups is already behind usage_events.
//
// Failures don't block the request — we serve stale data and log.
export async function freshenIfStale(): Promise<void> {
  const now = Date.now();
  if (now - lastFreshenedAt < FRESHEN_DEBOUNCE_MS) return;
  if (inFlight) {
    await inFlight;
    return;
  }
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
  await inFlight;
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
