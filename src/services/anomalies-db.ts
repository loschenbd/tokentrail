import type DatabaseType from 'better-sqlite3';
import { detectAnomalies, type AnomalyInput } from './anomalies.js';

// Pull the inputs detectAnomalies needs from feature_rollups + sessions, run
// detection, and upsert into the anomalies table. Active rows (dismissed_at
// IS NULL) for the same UNIQUE key get overwritten; dismissed rows are left
// untouched.
export function computeAndPersistAnomalies(db: DatabaseType.Database): {
  active: number;
  preserved: number;
} {
  const input = buildAnomalyInput(db);
  const detected = detectAnomalies(input);

  // Wipe active rows; preserve dismissed ones (which keep their id).
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM anomalies WHERE dismissed_at IS NULL`).run();
    const upsert = db.prepare(`
      INSERT INTO anomalies (kind, date, feature_key, session_id, amount, baseline, multiplier, reason)
      VALUES (@kind, @date, @feature_key, @session_id, @amount, @baseline, @multiplier, @reason)
      ON CONFLICT(kind, date, COALESCE(feature_key, ''), COALESCE(session_id, '')) DO UPDATE SET
        amount     = excluded.amount,
        baseline   = excluded.baseline,
        multiplier = excluded.multiplier,
        reason     = excluded.reason
      WHERE anomalies.dismissed_at IS NULL
    `);
    for (const a of detected) {
      upsert.run({
        kind: a.kind,
        date: a.date,
        feature_key: a.feature_key,
        session_id: a.session_id,
        amount: a.amount,
        baseline: a.baseline,
        multiplier: Number.isFinite(a.multiplier) ? a.multiplier : 9999,
        reason: a.reason,
      });
    }
  });
  tx();

  const active = (db.prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NULL`).get() as { n: number }).n;
  const preserved = (db.prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NOT NULL`).get() as { n: number }).n;
  return { active, preserved };
}

function buildAnomalyInput(db: DatabaseType.Database): AnomalyInput {
  // Daily totals: sum cost across all rollups per date.
  const dailyTotals = db
    .prepare(`SELECT date, SUM(total_cost_usd) AS total FROM feature_rollups GROUP BY date ORDER BY date`)
    .all() as Array<{ date: string; total: number }>;

  // Per-feature weekly: this-week (last 7 days) vs prior-week (8-14 days ago).
  const featureWeekly = db
    .prepare(`
      WITH bounds AS (
        SELECT date('now', '-13 days') AS prior_start,
               date('now', '-7 days')  AS prior_end,
               date('now', '-6 days')  AS this_start,
               date('now')             AS this_end
      )
      SELECT
        feature_key                                                                  AS featureKey,
        COALESCE(SUM(CASE WHEN date >= (SELECT prior_start FROM bounds) AND date <  (SELECT this_start FROM bounds) THEN total_cost_usd ELSE 0 END), 0) AS priorWeek,
        COALESCE(SUM(CASE WHEN date >= (SELECT this_start  FROM bounds) AND date <= (SELECT this_end   FROM bounds) THEN total_cost_usd ELSE 0 END), 0) AS thisWeek
      FROM feature_rollups
      GROUP BY feature_key
      HAVING thisWeek > 0 OR priorWeek > 0
    `)
    .all() as Array<{ featureKey: string; priorWeek: number; thisWeek: number }>;

  // Sessions: trailing 30 days, with cost + branch + override flag.
  // Note: e.branch is bare-column under GROUP BY; SQLite returns one arbitrary
  // branch per session, which is fine for the labeled-branch suppression check —
  // any matched branch is enough.
  const sessions = db
    .prepare(`
      SELECT
        s.session_id                                AS sessionId,
        date(s.first_seen_at)                       AS date,
        COALESCE(SUM(e.estimated_cost_usd), 0)      AS cost,
        e.branch                                    AS branch,
        CASE WHEN s.feature_override IS NOT NULL THEN 1 ELSE 0 END AS hasOverride
      FROM sessions s
      LEFT JOIN usage_events e ON e.session_id = s.session_id
      WHERE date(s.first_seen_at) >= date('now', '-30 days')
      GROUP BY s.session_id
    `)
    .all() as Array<{
      sessionId: string;
      date: string;
      cost: number;
      branch: string | null;
      hasOverride: 0 | 1;
    }>;

  // Labeled work-unit branches: any work_unit that came from a manual label
  // (i.e. feature_key matches a sessions.feature_override).
  const labeledRows = db
    .prepare(`
      SELECT DISTINCT branch
      FROM work_units
      WHERE feature_key IN (SELECT DISTINCT feature_override FROM sessions WHERE feature_override IS NOT NULL)
        AND branch IS NOT NULL
    `)
    .all() as Array<{ branch: string }>;
  const labeledWorkUnitBranches = new Set(labeledRows.map((r) => r.branch));

  return {
    dailyTotals,
    featureWeekly,
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      date: s.date,
      cost: s.cost,
      branch: s.branch,
      hasOverride: s.hasOverride === 1,
    })),
    labeledWorkUnitBranches,
  };
}
