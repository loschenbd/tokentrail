import type DatabaseType from 'better-sqlite3';
import { hiddenFeatureKeys, anomalyVisiblePredicate, shownAnomalyPredicate } from '../lib/hidden-projects.js';

export type WorthALookVM = {
  showDismissed: boolean;
  dismissedCount: number;
  items: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    multiplier: number;
    dismissed: boolean;
  }>;
};

export type BuildWorthALookOptions = {
  showDismissed: boolean;
  hidden?: string[];
};

export function buildWorthALook(
  db: DatabaseType.Database,
  opts: BuildWorthALookOptions = { showDismissed: false }
): WorthALookVM {
  const hiddenKeys = hiddenFeatureKeys(db, opts.hidden ?? []);
  const visibleSql = anomalyVisiblePredicate(hiddenKeys);

  const dismissedCount = (db
    .prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE dismissed_at IS NOT NULL AND ${visibleSql}`)
    .get() as { n: number }).n;

  // Active rows always; dismissed rows only when requested. ORDER BY
  // `dismissedInt ASC` puts active (0) before dismissed (1) and tie-breaks
  // by date desc then multiplier desc within each group.
  const whereClause = `WHERE ${shownAnomalyPredicate(hiddenKeys, { includeDismissed: opts.showDismissed })}`;
  const items = db
    .prepare(`
      SELECT id, kind, date,
             feature_key AS featureKey,
             session_id  AS sessionId,
             ROUND(amount, 2)     AS amount,
             ROUND(multiplier, 2) AS multiplier,
             reason,
             CASE WHEN dismissed_at IS NULL THEN 0 ELSE 1 END AS dismissedInt
      FROM anomalies
      ${whereClause}
      ORDER BY dismissedInt ASC, date DESC, multiplier DESC
    `)
    .all() as Array<Omit<WorthALookVM['items'][number], 'dismissed'> & { dismissedInt: number }>;

  return {
    showDismissed: opts.showDismissed,
    dismissedCount,
    items: items.map(({ dismissedInt, ...rest }) => ({ ...rest, dismissed: dismissedInt === 1 })),
  };
}
