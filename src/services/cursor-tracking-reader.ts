import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getConfig } from '../lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

export type CursorScoredCommit = {
  commitHash: string;
  branch: string;
  aiLines: number;
  composerLines: number;
  tabLines: number;
  humanLines: number;
  aiPct: number | null;
  committedAt: string | null;
  message: string | null;
  scoredAt: number;
};

export function cursorTrackingDbPath(): string {
  const override = getConfig().cursorTrackingDbPath;
  if (override) return override;
  return join(homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

// Read-only, immutable open so we never contend with a running Cursor and
// never mutate the foreign DB. Any failure (missing file, schema drift,
// lock) degrades to [] with a logged warning — Cursor is never fatal.
export function readScoredCommits(
  dbPath: string,
  sinceScoredAt: number
): CursorScoredCommit[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseType.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT commitHash, branchName, scoredAt,
                COALESCE(composerLinesAdded,0) AS composer,
                COALESCE(tabLinesAdded,0)      AS tab,
                COALESCE(humanLinesAdded,0)    AS human,
                v2AiPercentage, commitMessage, commitDate
         FROM scored_commits
         WHERE scoredAt > ?
         ORDER BY scoredAt ASC`
      )
      .all(sinceScoredAt) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const composer = Number(r.composer) || 0;
      const tab = Number(r.tab) || 0;
      const pctRaw = r.v2AiPercentage;
      const pct = pctRaw == null ? null : Number(pctRaw);
      return {
        commitHash: String(r.commitHash),
        branch: String(r.branchName),
        aiLines: composer + tab,
        composerLines: composer,
        tabLines: tab,
        humanLines: Number(r.human) || 0,
        aiPct: pct != null && Number.isFinite(pct) ? pct : null,
        committedAt: r.commitDate == null ? null : String(r.commitDate),
        message: r.commitMessage == null ? null : String(r.commitMessage),
        scoredAt: Number(r.scoredAt) || 0,
      };
    });
  } catch (err) {
    console.warn(
      `Cursor: could not read ${dbPath} (${(err as Error).message}). Skipping local AI-line ingest.`
    );
    return [];
  } finally {
    db?.close();
  }
}
