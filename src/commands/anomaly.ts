import { getDb } from '../db/db.js';

export function dismissAnomaly(id: number): void {
  const db = getDb();
  const result = db
    .prepare(`UPDATE anomalies SET dismissed_at = datetime('now') WHERE id = ? AND dismissed_at IS NULL`)
    .run(id);
  if (result.changes === 0) {
    console.error(`No active anomaly with id ${id}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Dismissed anomaly ${id}.`);
}

export function listAnomalies(): void {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT id, kind, date, feature_key, session_id, amount, multiplier, reason
      FROM anomalies
      WHERE dismissed_at IS NULL
      ORDER BY date DESC, multiplier DESC
    `)
    .all() as Array<{
      id: number;
      kind: string;
      date: string;
      feature_key: string | null;
      session_id: string | null;
      amount: number;
      multiplier: number;
      reason: string;
    }>;
  if (rows.length === 0) {
    console.log('No active anomalies.');
    return;
  }
  for (const r of rows) {
    console.log(`#${r.id}  [${r.kind}]  ${r.date}  ${r.reason}`);
  }
}
