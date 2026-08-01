import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getConfig } from '../lib/config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseType;

// One model turn recorded by the GitHub Copilot CLI in
// ~/.copilot/session-store.db (table assistant_usage_events, joined to
// sessions for attribution). See docs/plans/copilot-ingest-plan.md §2a.
export type CopilotUsage = {
  /** assistant_usage_events.id — a global AUTOINCREMENT; stable per DB, our watermark + dedup seed. */
  rowId: number;
  sessionId: string;
  turnIndex: number | null;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Pre-computed cost in nano AI Units (1 AIU = 1 credit = $0.01). Null on some rows. */
  totalNanoAiu: number | null;
  requestMultiplier: number | null;
  initiator: string | null;
  /** From the sessions row — where the CLI ran; used for repo/branch attribution. */
  cwd: string | null;
  repository: string | null;
  branch: string | null;
};

// Schema versions this reader was written against (schema_version table). An
// unrecognized version still attempts the read — the column set may be
// unchanged — but logs a warning so a breaking CLI update is visible. The
// try/catch below is the real guard against column drift.
const KNOWN_SCHEMA_VERSIONS = new Set([6]);

export function copilotStorePath(): string {
  const override = getConfig().copilotStorePath;
  if (override) return override;
  const home = process.env.COPILOT_HOME
    ? join(process.env.COPILOT_HOME, 'session-store.db')
    : join(homedir(), '.copilot', 'session-store.db');
  return home;
}

// Read-only, immutable open so we never contend with a running Copilot CLI and
// never mutate the foreign DB. Any failure (missing file, schema drift, lock)
// degrades to [] with a logged warning — Copilot is never fatal, mirroring the
// Cursor reader.
export function readUsageEvents(dbPath: string, sinceRowId: number): CopilotUsage[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseType.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const verRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    if (verRow && !KNOWN_SCHEMA_VERSIONS.has(Number(verRow.version))) {
      console.warn(
        `Copilot: session-store.db schema_version ${verRow.version} is untested ` +
          `(known: ${[...KNOWN_SCHEMA_VERSIONS].join(', ')}). Attempting read anyway.`
      );
    }

    const rows = db
      .prepare(
        `SELECT e.id                          AS row_id,
                e.session_id                  AS session_id,
                e.turn_index                  AS turn_index,
                e.model                       AS model,
                COALESCE(e.input_tokens, 0)   AS input_tokens,
                COALESCE(e.output_tokens, 0)  AS output_tokens,
                COALESCE(e.cache_read_tokens, 0)  AS cache_read_tokens,
                COALESCE(e.cache_write_tokens, 0) AS cache_write_tokens,
                COALESCE(e.reasoning_tokens, 0)   AS reasoning_tokens,
                e.total_nano_aiu              AS total_nano_aiu,
                e.request_multiplier          AS request_multiplier,
                e.initiator                   AS initiator,
                e.created_at                  AS created_at,
                s.cwd                         AS cwd,
                s.repository                  AS repository,
                s.branch                      AS branch
         FROM assistant_usage_events e
         LEFT JOIN sessions s ON s.id = e.session_id
         WHERE e.id > ?
         ORDER BY e.id ASC`
      )
      .all(sinceRowId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      rowId: Number(r.row_id),
      sessionId: String(r.session_id),
      turnIndex: r.turn_index == null ? null : Number(r.turn_index),
      timestamp: toIso(r.created_at),
      model: String(r.model),
      inputTokens: Number(r.input_tokens) || 0,
      outputTokens: Number(r.output_tokens) || 0,
      cacheReadTokens: Number(r.cache_read_tokens) || 0,
      cacheWriteTokens: Number(r.cache_write_tokens) || 0,
      reasoningTokens: Number(r.reasoning_tokens) || 0,
      totalNanoAiu: r.total_nano_aiu == null ? null : Number(r.total_nano_aiu),
      requestMultiplier: r.request_multiplier == null ? null : Number(r.request_multiplier),
      initiator: r.initiator == null ? null : String(r.initiator),
      cwd: r.cwd == null ? null : String(r.cwd),
      repository: r.repository == null ? null : String(r.repository),
      branch: r.branch == null ? null : String(r.branch),
    }));
  } catch (err) {
    console.warn(
      `Copilot: could not read ${dbPath} (${(err as Error).message}). Skipping Copilot ingest.`
    );
    return [];
  } finally {
    db?.close();
  }
}

// Copilot writes created_at via SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS"
// (UTC, no zone). Normalize to an ISO-8601 Z string to match usage_events.
function toIso(raw: unknown): string {
  const s = raw == null ? '' : String(raw);
  if (s === '') return new Date(0).toISOString();
  if (s.includes('T')) return s; // already ISO-ish
  return s.replace(' ', 'T') + 'Z';
}
