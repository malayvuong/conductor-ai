export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  raw_input TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  engine TEXT NOT NULL,
  task_type TEXT,
  normalized_json TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  engine TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  args_json TEXT NOT NULL DEFAULT '[]',
  prompt_final TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  pid INTEGER,
  started_at TEXT,
  finished_at TEXT,
  exit_code INTEGER,
  resumed_from_run_id TEXT REFERENCES runs(id),
  cost_usd REAL,
  duration_seconds REAL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  stream_type TEXT NOT NULL,
  line TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS heartbeat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  no_output_seconds REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  summary TEXT NOT NULL DEFAULT '',
  files_inspected_json TEXT,
  files_changed_json TEXT,
  verification_notes TEXT,
  final_output TEXT,
  root_cause TEXT,
  fix_applied TEXT,
  remaining_risks TEXT,
  findings TEXT,
  risks TEXT,
  recommendations TEXT,
  what_implemented TEXT,
  follow_ups TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_heartbeat_events_run_id ON heartbeat_events(run_id);
CREATE INDEX IF NOT EXISTS idx_run_reports_run_id ON run_reports(run_id);
`;

/**
 * Migrate existing run_reports tables to add new columns.
 * Safe to call on fresh DBs (columns already exist from CREATE TABLE).
 */
export function migrateSchema(db: import('better-sqlite3').Database): void {
  migrateReportColumns(db);
  // Add new columns to runs table
  const runColumns = [
    'resumed_from_run_id TEXT REFERENCES runs(id)',
    'cost_usd REAL',
    'duration_seconds REAL',
  ];
  for (const col of runColumns) {
    try { db.exec(`ALTER TABLE runs ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
}

function migrateReportColumns(db: import('better-sqlite3').Database): void {
  const newColumns = [
    'files_inspected_json TEXT',
    'final_output TEXT',
    'findings TEXT',
    'risks TEXT',
    'recommendations TEXT',
    'what_implemented TEXT',
    'follow_ups TEXT',
  ];
  for (const col of newColumns) {
    try {
      db.exec(`ALTER TABLE run_reports ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
}
