// Idempotent CREATE TABLE statements. Run on every startup via migrations.ts.

export const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS usage_events (
    id                    TEXT PRIMARY KEY,
    session_id            TEXT NOT NULL,
    timestamp             TEXT NOT NULL,
    repo                  TEXT,
    branch                TEXT,
    commit_sha            TEXT,
    model                 TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd    REAL NOT NULL DEFAULT 0,
    source                TEXT NOT NULL DEFAULT 'jsonl',
    created_at            TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_usage_events_session
    ON usage_events (session_id)`,

  `CREATE INDEX IF NOT EXISTS idx_usage_events_repo_branch
    ON usage_events (repo, branch)`,

  `CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
    ON usage_events (timestamp)`,

  `CREATE TABLE IF NOT EXISTS work_units (
    id                    TEXT PRIMARY KEY,
    repo                  TEXT NOT NULL,
    branch                TEXT NOT NULL,
    pr_number             INTEGER,
    pr_title              TEXT,
    pr_labels             TEXT,
    github_issue          INTEGER,
    feature_key           TEXT NOT NULL,
    feature_name          TEXT NOT NULL,
    notion_page_id        TEXT,
    status                TEXT DEFAULT 'active',
    first_seen_at         TEXT NOT NULL,
    last_seen_at          TEXT NOT NULL,
    github_enriched_at    TEXT,
    UNIQUE(repo, branch)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_work_units_feature_key
    ON work_units (feature_key)`,

  `CREATE TABLE IF NOT EXISTS feature_rollups (
    id                    TEXT PRIMARY KEY,
    date                  TEXT NOT NULL,
    feature_key           TEXT NOT NULL,
    feature_name          TEXT NOT NULL,
    repo                  TEXT,
    branches              TEXT,
    total_input_tokens    INTEGER NOT NULL DEFAULT 0,
    total_output_tokens   INTEGER NOT NULL DEFAULT 0,
    total_cost_usd        REAL NOT NULL DEFAULT 0,
    sessions_count        INTEGER NOT NULL DEFAULT 0,
    notion_page_id        TEXT,
    synced_to_notion_at   TEXT,
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, feature_key)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_feature_rollups_date
    ON feature_rollups (date)`,

  // Per-session metadata. Derived from JSONL — title = first user prompt
  // text (truncated). Used by \`tokentrail sessions\` to scan high-cost
  // sessions and decide whether to label them with a feature override.
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    title         TEXT,
    project_dir   TEXT,
    first_seen_at TEXT,
    last_seen_at  TEXT,
    feature_override TEXT
  )`,

  // Commits authored in a session's time window inside its project dir
  // (or the nearest git root). Populated by \`tokentrail commits --backfill\`
  // and exposed in \`tokentrail sessions\` to surface what was being built.
  `CREATE TABLE IF NOT EXISTS session_commits (
    session_id   TEXT NOT NULL,
    commit_sha   TEXT NOT NULL,
    subject      TEXT,
    body         TEXT,
    authored_at  TEXT,
    author_email TEXT,
    branch       TEXT,
    PRIMARY KEY (session_id, commit_sha)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_session_commits_session
    ON session_commits (session_id)`,

  // PRs whose head branch matched a (repo, branch) seen in a session's
  // commits. Populated by \`tokentrail prs --backfill\`. One session can
  // have multiple PRs across repos.
  `CREATE TABLE IF NOT EXISTS session_prs (
    session_id   TEXT NOT NULL,
    repo         TEXT NOT NULL,
    pr_number    INTEGER NOT NULL,
    pr_title     TEXT,
    pr_url       TEXT,
    pr_state     TEXT,
    head_branch  TEXT,
    merged_at    TEXT,
    PRIMARY KEY (session_id, repo, pr_number)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_session_prs_session
    ON session_prs (session_id)`,

  // Anomalies are derived from feature_rollups + usage_events at rollup time.
  // Recomputed from scratch each rollup run except for rows with a non-null
  // dismissed_at, which are preserved.
  `CREATE TABLE IF NOT EXISTS anomalies (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    date            TEXT NOT NULL,
    feature_key     TEXT,
    session_id      TEXT,
    amount          REAL NOT NULL,
    baseline        REAL NOT NULL,
    multiplier      REAL NOT NULL,
    reason          TEXT NOT NULL,
    dismissed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_anomalies_date ON anomalies (date)`,
  `CREATE INDEX IF NOT EXISTS idx_anomalies_active ON anomalies (dismissed_at)`,

  // Expression-based UNIQUE index. SQLite treats NULLs as distinct in plain
  // UNIQUE constraints, which means a dismissed `spike_day` (both feature_key
  // and session_id are NULL) would silently duplicate on the next rollup
  // recompute. COALESCE-to-empty-string is the standard workaround. Any
  // ON CONFLICT clause writing to this table MUST use the same expressions
  // in its conflict target — see src/services/anomalies-db.ts.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_anomalies_dedupe
     ON anomalies (kind, date, COALESCE(feature_key, ''), COALESCE(session_id, ''))`,
];
