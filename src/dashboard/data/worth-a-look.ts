import type DatabaseType from 'better-sqlite3';

export type WorthALookVM = {
  items: Array<{
    id: number;
    kind: string;
    date: string;
    featureKey: string | null;
    sessionId: string | null;
    amount: number;
    reason: string;
    multiplier: number;
  }>;
};

export function buildWorthALook(db: DatabaseType.Database): WorthALookVM {
  const items = db
    .prepare(`
      SELECT id, kind, date,
             feature_key AS featureKey,
             session_id  AS sessionId,
             ROUND(amount, 2)     AS amount,
             ROUND(multiplier, 2) AS multiplier,
             reason
      FROM anomalies
      WHERE dismissed_at IS NULL
      ORDER BY date DESC, multiplier DESC
    `)
    .all() as WorthALookVM['items'];
  return { items };
}
