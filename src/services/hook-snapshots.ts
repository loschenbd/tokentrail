import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { parseRepoSlug } from './git.js';

export function hookLogPath(): string {
  const dir = process.env.TRACKER_LOG_DIR ?? join(homedir(), '.claude-cost-tracker');
  return join(dir, 'session-hooks.jsonl');
}

type StopSnapshot = {
  sessionId: string;
  timestamp: string;
  repo: string | null;
  branch: string | null;
  commitSha: string | null;
};

// Walk the Stop-hook log and return the most recent snapshot per session_id.
// Sessions write a hook entry every time they end, but only the latest one
// is interesting for attribution.
export async function loadLatestHookSnapshots(): Promise<Map<string, StopSnapshot>> {
  const out = new Map<string, StopSnapshot>();
  const path = hookLogPath();
  if (!existsSync(path)) return out;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    if (row.type !== 'stop') continue;

    const payload = isRecord(row.payload) ? row.payload : {};
    const sessionId =
      asString(payload.session_id) ??
      asString(payload.sessionId) ??
      asString(row.session_id);
    if (!sessionId) continue;

    const snap: StopSnapshot = {
      sessionId,
      timestamp: asString(row.timestamp) ?? new Date().toISOString(),
      repo: parseRepoSlug(asString(row.remote)),
      branch: asString(row.branch),
      commitSha: asString(row.commit_sha),
    };
    const prev = out.get(sessionId);
    if (!prev || snap.timestamp >= prev.timestamp) {
      out.set(sessionId, snap);
    }
  }
  return out;
}

// Update usage_events rows for sessions where the hook captured a stronger
// branch signal than the ingest-time HEAD. Only rewrites rows whose
// (repo, branch) is null OR matches HEAD's default ("main"/"master"/etc),
// to avoid clobbering precise data.
export function applyHookSnapshots(
  db: DatabaseType.Database,
  snapshots: Map<string, StopSnapshot>
): { updated: number; sessionsCovered: number } {
  if (snapshots.size === 0) return { updated: 0, sessionsCovered: 0 };

  // The trailing IS NOT clause skips rows the SET would leave unchanged.
  // Without it, sessions whose hook branch is itself a mainline name match
  // the WHERE forever and re-write identical values every ingest cycle —
  // SQLite counts those as changes and flushes them to the WAL.
  const update = db.prepare(`
    UPDATE usage_events
    SET repo = COALESCE(@repo, repo),
        branch = @branch,
        commit_sha = COALESCE(@commit_sha, commit_sha)
    WHERE session_id = @session_id
      AND (
        branch IS NULL
        OR branch = ''
        OR LOWER(branch) IN ('main','master','develop','staging')
      )
      AND (
        branch IS NOT @branch
        OR repo IS NOT COALESCE(@repo, repo)
        OR commit_sha IS NOT COALESCE(@commit_sha, commit_sha)
      )
  `);

  let updated = 0;
  let sessionsCovered = 0;
  const tx = db.transaction(() => {
    for (const snap of snapshots.values()) {
      if (!snap.branch) continue;
      const result = update.run({
        repo: snap.repo,
        branch: snap.branch,
        commit_sha: snap.commitSha,
        session_id: snap.sessionId,
      });
      if (result.changes > 0) {
        updated += result.changes;
        sessionsCovered++;
      }
    }
  });
  tx();
  return { updated, sessionsCovered };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
