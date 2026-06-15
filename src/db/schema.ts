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
];
