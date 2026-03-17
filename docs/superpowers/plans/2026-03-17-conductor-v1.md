# Conductor V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working CLI supervisor for AI coding CLIs (Claude, Codex) that takes natural-language tasks, generates prompts, runs the selected engine, streams logs, monitors heartbeat, and produces structured reports — all persisted locally with SQLite.

**Architecture:** CLI-first, non-interactive. User runs `conductor run --engine claude --path /... --task "..."`. The app normalizes the task, builds a prompt from templates, spawns the engine CLI via `child_process.spawn`, streams stdout/stderr to terminal and SQLite, monitors heartbeat, and generates a final report. All data stored in local SQLite via `better-sqlite3`.

**Tech Stack:** Node.js 22+, TypeScript, commander (CLI), zod (validation), better-sqlite3 (persistence), child_process.spawn (process runner)

---

## File Structure

```
conductor/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry point, commander setup
│   │   └── commands/
│   │       ├── run.ts            # `conductor run` command
│   │       ├── tasks.ts          # `conductor tasks` command
│   │       ├── logs.ts           # `conductor logs` command
│   │       ├── report.ts         # `conductor report` command
│   │       └── resume.ts         # `conductor resume` command
│   ├── core/
│   │   ├── task/
│   │   │   └── normalizer.ts     # Parse raw input → normalized task object
│   │   ├── prompt/
│   │   │   └── builder.ts        # Build final prompt from template + variables
│   │   ├── engine/
│   │   │   ├── types.ts          # EngineAdapter interface
│   │   │   ├── claude.ts         # Claude CLI adapter
│   │   │   └── codex.ts          # Codex CLI adapter
│   │   ├── runner/
│   │   │   └── process.ts        # Spawn process, capture output, manage lifecycle
│   │   ├── heartbeat/
│   │   │   └── monitor.ts        # Periodic heartbeat, stuck detection
│   │   ├── report/
│   │   │   └── generator.ts      # Generate structured report from run data
│   │   └── storage/
│   │       ├── schema.ts         # SQL DDL statements
│   │       ├── db.ts             # DB singleton, init, migrations
│   │       └── repository.ts     # All CRUD operations (tasks, runs, logs, heartbeats, reports)
│   ├── types/
│   │   └── index.ts              # Shared TypeScript types (Task, Run, RunLog, etc.)
│   └── utils/
│       ├── logger.ts             # Simple console logger with timestamps
│       └── lookup.ts             # Shared short-ID prefix lookup helpers
├── prompts/
│   ├── claude/
│   │   ├── debug_fix.md          # Claude prompt template for debug/fix tasks
│   │   ├── scan_review.md        # Claude prompt template for scan/review tasks
│   │   ├── implement_feature.md  # Claude prompt template for new feature tasks
│   │   └── verify_only.md        # Claude prompt template for verification tasks
│   └── codex/
│       ├── debug_fix.md          # Codex prompt template for debug/fix tasks
│       ├── scan_review.md        # Codex prompt template for scan/review tasks
│       ├── implement_feature.md  # Codex prompt template for new feature tasks
│       └── verify_only.md        # Codex prompt template for verification tasks
├── data/                         # Runtime data (gitignored)
│   └── .gitkeep
├── tests/
│   ├── core/
│   │   ├── normalizer.test.ts
│   │   ├── prompt-builder.test.ts
│   │   ├── engine-claude.test.ts
│   │   ├── engine-codex.test.ts
│   │   ├── process-runner.test.ts
│   │   ├── heartbeat.test.ts
│   │   └── report-generator.test.ts
│   └── storage/
│       └── repository.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Chunk 1: Bootstrap & Storage (Tasks 1–2)

### Task 1: Bootstrap Node/TypeScript CLI Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli/index.ts`
- Create: `src/cli/commands/run.ts`
- Create: `src/cli/commands/tasks.ts`
- Create: `src/cli/commands/logs.ts`
- Create: `src/cli/commands/report.ts`
- Create: `src/utils/logger.ts`
- Create: `data/.gitkeep`

- [ ] **Step 1: Initialize package.json**

```bash
cd /Users/malayvuong/Sites/2026/conductor
npm init -y
```

Then update `package.json`:

```json
{
  "name": "conductor",
  "version": "0.1.0",
  "description": "Supervisor for AI coding CLIs",
  "type": "module",
  "main": "dist/cli/index.js",
  "bin": {
    "conductor": "dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install commander zod better-sqlite3
npm install -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

- [ ] **Step 5: Create simple logger utility**

Create `src/utils/logger.ts`:

```ts
const timestamp = (): string => new Date().toISOString();

export const log = {
  info: (msg: string) => console.log(`[${timestamp()}] ${msg}`),
  error: (msg: string) => console.error(`[${timestamp()}] ERROR: ${msg}`),
  debug: (msg: string) => {
    if (process.env.DEBUG) console.log(`[${timestamp()}] DEBUG: ${msg}`);
  },
};
```

- [ ] **Step 6: Create CLI entry point with commander**

Create `src/cli/index.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerReportCommand } from './commands/report.js';

const program = new Command();

program
  .name('conductor')
  .description('Supervisor for AI coding CLIs')
  .version('0.1.0');

registerRunCommand(program);
registerTasksCommand(program);
registerLogsCommand(program);
registerReportCommand(program);

program.parse();
```

- [ ] **Step 7: Create command stubs**

Create `src/cli/commands/run.ts`:

```ts
import { Command } from 'commander';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .requiredOption('--engine <engine>', 'Engine to use (claude, codex)')
    .requiredOption('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      console.log('Run command called with:', opts);
    });
}
```

Create `src/cli/commands/tasks.ts`:

```ts
import { Command } from 'commander';

export function registerTasksCommand(program: Command): void {
  program
    .command('tasks')
    .description('List all tasks')
    .action(async () => {
      console.log('Tasks command called');
    });
}
```

Create `src/cli/commands/logs.ts`:

```ts
import { Command } from 'commander';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <runId>')
    .description('View logs for a run')
    .action(async (runId: string) => {
      console.log('Logs command called for run:', runId);
    });
}
```

Create `src/cli/commands/report.ts`:

```ts
import { Command } from 'commander';

export function registerReportCommand(program: Command): void {
  program
    .command('report <runId>')
    .description('View report for a run')
    .action(async (runId: string) => {
      console.log('Report command called for run:', runId);
    });
}
```

- [ ] **Step 8: Create data directory with .gitkeep**

```bash
mkdir -p data
touch data/.gitkeep
```

- [ ] **Step 9: Update .gitignore**

Append to `.gitignore`:

```
# Conductor runtime data
data/*.db
data/logs/
dist/
```

- [ ] **Step 10: Verify it works**

```bash
npm run dev -- --help
npm run dev -- run --help
npm run dev -- tasks
npm run dev -- logs test123
npm run dev -- report test123
```

Expected: Help text shows all commands. Each command prints its stub message.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/ data/.gitkeep .gitignore
git commit -m "chore: bootstrap conductor node/typescript cli project"
```

---

### Task 2: SQLite Storage Layer

**Files:**
- Create: `src/types/index.ts`
- Create: `src/core/storage/schema.ts`
- Create: `src/core/storage/db.ts`
- Create: `src/core/storage/repository.ts`
- Create: `tests/storage/repository.test.ts`

- [ ] **Step 1: Define shared TypeScript types**

Create `src/types/index.ts`:

```ts
export type TaskType = 'debug_fix' | 'scan_review' | 'implement_feature' | 'verify_only';
export type TaskStatus = 'created' | 'running' | 'completed' | 'failed';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type StreamType = 'stdout' | 'stderr' | 'system';
export type HeartbeatStatus = 'alive' | 'idle' | 'suspected_stuck';

export interface Task {
  id: string;
  raw_input: string;
  workspace_path: string;
  engine: string;
  task_type: TaskType | null;
  normalized_json: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  task_id: string;
  engine: string;
  command: string;
  args_json: string;
  prompt_final: string;
  status: RunStatus;
  pid: number | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
}

export interface RunLog {
  id: number;
  run_id: string;
  seq: number;
  timestamp: string;
  stream_type: StreamType;
  line: string;
}

export interface HeartbeatEvent {
  id: number;
  run_id: string;
  timestamp: string;
  status: HeartbeatStatus;
  summary: string;
  no_output_seconds: number;
}

export interface RunReport {
  id: string;
  run_id: string;
  summary: string;
  root_cause: string | null;
  fix_applied: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  remaining_risks: string | null;
}
```

- [ ] **Step 2: Create SQL schema**

Create `src/core/storage/schema.ts`:

```ts
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
  exit_code INTEGER
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
  root_cause TEXT,
  fix_applied TEXT,
  files_changed_json TEXT,
  verification_notes TEXT,
  remaining_risks TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id);
CREATE INDEX IF NOT EXISTS idx_heartbeat_events_run_id ON heartbeat_events(run_id);
CREATE INDEX IF NOT EXISTS idx_run_reports_run_id ON run_reports(run_id);
`;
```

- [ ] **Step 3: Create DB initialization module**

Create `src/core/storage/db.ts`:

```ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_SQL } from './schema.js';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'conductor.db');

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;

  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA_SQL);

  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** For tests: create an in-memory DB */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}
```

- [ ] **Step 4: Write the failing tests for repository**

Create `tests/storage/repository.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createTask,
  getTaskById,
  listTasks,
  updateTaskStatus,
  createRun,
  getRunById,
  getRunsByTaskId,
  updateRunStatus,
  updateRunPid,
  updateRunFinished,
  appendRunLog,
  getRunLogs,
  createHeartbeat,
  getHeartbeatsByRunId,
  saveReport,
  getReportByRunId,
} from '../../src/core/storage/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('tasks', () => {
  it('creates and retrieves a task', () => {
    const task = createTask(db, {
      raw_input: 'fix the login bug',
      workspace_path: '/tmp/project',
      engine: 'claude',
    });
    expect(task.id).toBeDefined();
    expect(task.raw_input).toBe('fix the login bug');
    expect(task.status).toBe('created');

    const fetched = getTaskById(db, task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(task.id);
  });

  it('lists tasks', () => {
    createTask(db, { raw_input: 'task 1', workspace_path: '/tmp/a', engine: 'claude' });
    createTask(db, { raw_input: 'task 2', workspace_path: '/tmp/b', engine: 'codex' });
    const tasks = listTasks(db);
    expect(tasks).toHaveLength(2);
  });

  it('updates task status', () => {
    const task = createTask(db, { raw_input: 'task', workspace_path: '/tmp', engine: 'claude' });
    updateTaskStatus(db, task.id, 'running');
    const updated = getTaskById(db, task.id);
    expect(updated!.status).toBe('running');
  });
});

describe('runs', () => {
  it('creates and retrieves a run', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, {
      task_id: task.id,
      engine: 'claude',
      command: 'claude',
      args_json: '["--print"]',
      prompt_final: 'Fix the bug',
    });
    expect(run.id).toBeDefined();
    expect(run.status).toBe('queued');

    const fetched = getRunById(db, run.id);
    expect(fetched).toBeDefined();
    expect(fetched!.task_id).toBe(task.id);
  });

  it('gets runs by task id', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p2' });
    const runs = getRunsByTaskId(db, task.id);
    expect(runs).toHaveLength(2);
  });

  it('updates run status and pid', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });
    updateRunStatus(db, run.id, 'running');
    updateRunPid(db, run.id, 12345);
    const updated = getRunById(db, run.id);
    expect(updated!.status).toBe('running');
    expect(updated!.pid).toBe(12345);
  });

  it('updates run finished state', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });
    updateRunFinished(db, run.id, 'completed', 0);
    const updated = getRunById(db, run.id);
    expect(updated!.status).toBe('completed');
    expect(updated!.exit_code).toBe(0);
    expect(updated!.finished_at).toBeDefined();
  });
});

describe('run_logs', () => {
  it('appends and retrieves logs', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    appendRunLog(db, run.id, 'stdout', 'line 1');
    appendRunLog(db, run.id, 'stdout', 'line 2');
    appendRunLog(db, run.id, 'stderr', 'error line');

    const logs = getRunLogs(db, run.id);
    expect(logs).toHaveLength(3);
    expect(logs[0].seq).toBe(1);
    expect(logs[1].seq).toBe(2);
    expect(logs[2].stream_type).toBe('stderr');
  });
});

describe('heartbeats', () => {
  it('creates and retrieves heartbeats', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    createHeartbeat(db, { run_id: run.id, status: 'alive', summary: 'processing', no_output_seconds: 0 });
    createHeartbeat(db, { run_id: run.id, status: 'idle', summary: 'waiting', no_output_seconds: 30 });

    const heartbeats = getHeartbeatsByRunId(db, run.id);
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[1].no_output_seconds).toBe(30);
  });
});

describe('reports', () => {
  it('saves and retrieves a report', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    saveReport(db, {
      run_id: run.id,
      summary: 'Fixed the bug',
      root_cause: 'Missing null check',
      fix_applied: 'Added null check in handler',
      files_changed_json: '["src/handler.ts"]',
      verification_notes: 'Tests pass',
      remaining_risks: null,
    });

    const report = getReportByRunId(db, run.id);
    expect(report).toBeDefined();
    expect(report!.summary).toBe('Fixed the bug');
    expect(report!.root_cause).toBe('Missing null check');
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — module `../../src/core/storage/repository.js` not found.

- [ ] **Step 6: Implement repository module**

Create `src/core/storage/repository.ts`:

```ts
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Task, Run, RunLog, HeartbeatEvent, RunReport, TaskStatus, RunStatus, StreamType, HeartbeatStatus } from '../../types/index.js';

// ---- Tasks ----

interface CreateTaskInput {
  raw_input: string;
  workspace_path: string;
  engine: string;
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, raw_input, workspace_path, engine, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'created', ?, ?)`
  ).run(id, input.raw_input, input.workspace_path, input.engine, now, now);
  return getTaskById(db, id)!;
}

export function getTaskById(db: Database.Database, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function listTasks(db: Database.Database): Task[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[];
}

export function updateTaskStatus(db: Database.Database, id: string, status: TaskStatus): void {
  db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

export function updateTaskNormalized(db: Database.Database, id: string, taskType: string, normalizedJson: string): void {
  db.prepare('UPDATE tasks SET task_type = ?, normalized_json = ?, updated_at = ? WHERE id = ?')
    .run(taskType, normalizedJson, new Date().toISOString(), id);
}

// ---- Runs ----

interface CreateRunInput {
  task_id: string;
  engine: string;
  command: string;
  args_json: string;
  prompt_final: string;
}

export function createRun(db: Database.Database, input: CreateRunInput): Run {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, task_id, engine, command, args_json, prompt_final, status)
     VALUES (?, ?, ?, ?, ?, ?, 'queued')`
  ).run(id, input.task_id, input.engine, input.command, input.args_json, input.prompt_final);
  return getRunById(db, id)!;
}

export function getRunById(db: Database.Database, id: string): Run | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
}

export function getRunsByTaskId(db: Database.Database, taskId: string): Run[] {
  return db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC').all(taskId) as Run[];
}

export function updateRunStatus(db: Database.Database, id: string, status: RunStatus): void {
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
}

export function updateRunPid(db: Database.Database, id: string, pid: number): void {
  db.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, id);
}

export function updateRunStarted(db: Database.Database, id: string): void {
  db.prepare('UPDATE runs SET status = ?, started_at = ? WHERE id = ?')
    .run('running', new Date().toISOString(), id);
}

export function updateRunFinished(db: Database.Database, id: string, status: RunStatus, exitCode: number | null): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, exit_code = ? WHERE id = ?')
    .run(status, new Date().toISOString(), exitCode, id);
}

// ---- Run Logs ----

export function appendRunLog(db: Database.Database, runId: string, streamType: StreamType, line: string): void {
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM run_logs WHERE run_id = ?').get(runId) as { max_seq: number };
  const seq = maxSeq.max_seq + 1;
  db.prepare(
    `INSERT INTO run_logs (run_id, seq, stream_type, line) VALUES (?, ?, ?, ?)`
  ).run(runId, seq, streamType, line);
}

export function getRunLogs(db: Database.Database, runId: string): RunLog[] {
  return db.prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY seq ASC').all(runId) as RunLog[];
}

// ---- Heartbeats ----

interface CreateHeartbeatInput {
  run_id: string;
  status: HeartbeatStatus;
  summary: string;
  no_output_seconds: number;
}

export function createHeartbeat(db: Database.Database, input: CreateHeartbeatInput): void {
  db.prepare(
    `INSERT INTO heartbeat_events (run_id, status, summary, no_output_seconds) VALUES (?, ?, ?, ?)`
  ).run(input.run_id, input.status, input.summary, input.no_output_seconds);
}

export function getHeartbeatsByRunId(db: Database.Database, runId: string): HeartbeatEvent[] {
  return db.prepare('SELECT * FROM heartbeat_events WHERE run_id = ? ORDER BY timestamp ASC').all(runId) as HeartbeatEvent[];
}

// ---- Reports ----

interface SaveReportInput {
  run_id: string;
  summary: string;
  root_cause: string | null;
  fix_applied: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  remaining_risks: string | null;
}

export function saveReport(db: Database.Database, input: SaveReportInput): RunReport {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO run_reports (id, run_id, summary, root_cause, fix_applied, files_changed_json, verification_notes, remaining_risks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.run_id, input.summary, input.root_cause, input.fix_applied, input.files_changed_json, input.verification_notes, input.remaining_risks);
  return getReportByRunId(db, input.run_id)!;
}

export function getReportByRunId(db: Database.Database, runId: string): RunReport | undefined {
  return db.prepare('SELECT * FROM run_reports WHERE run_id = ?').get(runId) as RunReport | undefined;
}
```

- [ ] **Step 7: Run tests to verify they pass**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 8: Wire `tasks` command to list from DB**

Update `src/cli/commands/tasks.ts`:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { listTasks } from '../../core/storage/repository.js';

export function registerTasksCommand(program: Command): void {
  program
    .command('tasks')
    .description('List all tasks')
    .action(async () => {
      const db = getDb();
      const tasks = listTasks(db);
      if (tasks.length === 0) {
        console.log('No tasks yet.');
        return;
      }
      for (const t of tasks) {
        const shortId = t.id.slice(0, 8);
        console.log(`[${shortId}] ${t.status.padEnd(10)} ${t.engine.padEnd(8)} ${t.raw_input.slice(0, 60)}`);
      }
    });
}
```

- [ ] **Step 9: Verify tasks command works**

```bash
npm run dev -- tasks
```

Expected: "No tasks yet."

- [ ] **Step 10: Commit**

```bash
git add src/ tests/ package.json package-lock.json tsconfig.json vitest.config.ts data/.gitkeep .gitignore
git commit -m "feat: add sqlite storage and core schema for tasks runs logs and reports"
```

---

## Chunk 2: Task Normalizer & Prompt Builder (Tasks 3–4)

### Task 3: Task Normalizer

**Files:**
- Create: `src/core/task/normalizer.ts`
- Create: `tests/core/normalizer.test.ts`

- [ ] **Step 1: Write failing tests for normalizer**

Create `tests/core/normalizer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTask, classifyTaskType } from '../../src/core/task/normalizer.js';

describe('classifyTaskType', () => {
  it('detects debug_fix from Vietnamese keywords', () => {
    expect(classifyTaskType('sửa lỗi login không load được')).toBe('debug_fix');
    expect(classifyTaskType('fix the broken handler')).toBe('debug_fix');
    expect(classifyTaskType('không load data, kiểm tra và sửa')).toBe('debug_fix');
  });

  it('detects scan_review', () => {
    expect(classifyTaskType('review code quality in auth module')).toBe('scan_review');
    expect(classifyTaskType('kiểm tra toàn bộ API endpoints')).toBe('scan_review');
    expect(classifyTaskType('scan for security issues')).toBe('scan_review');
  });

  it('detects implement_feature', () => {
    expect(classifyTaskType('thêm tính năng export CSV')).toBe('implement_feature');
    expect(classifyTaskType('add dark mode toggle')).toBe('implement_feature');
    expect(classifyTaskType('implement pagination for users list')).toBe('implement_feature');
  });

  it('detects verify_only', () => {
    expect(classifyTaskType('verify the deployment works')).toBe('verify_only');
    expect(classifyTaskType('chạy test và xác nhận kết quả')).toBe('verify_only');
    expect(classifyTaskType('validate the output format')).toBe('verify_only');
  });

  it('defaults to debug_fix for ambiguous input', () => {
    expect(classifyTaskType('something is wrong with the app')).toBe('debug_fix');
  });
});

describe('normalizeTask', () => {
  it('produces normalized object', () => {
    const result = normalizeTask({
      raw_input: 'trong base-admin, phần cms-management không load data; hãy sửa',
      workspace_path: '/tmp/project',
      engine: 'claude',
    });

    expect(result.task_type).toBe('debug_fix');
    expect(result.raw_input).toBe('trong base-admin, phần cms-management không load data; hãy sửa');
    expect(result.workspace_path).toBe('/tmp/project');
    expect(result.engine).toBe('claude');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/core/normalizer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement normalizer**

Create `src/core/task/normalizer.ts`:

```ts
import type { TaskType } from '../../types/index.js';

interface NormalizeInput {
  raw_input: string;
  workspace_path: string;
  engine: string;
}

interface NormalizedTask {
  raw_input: string;
  workspace_path: string;
  engine: string;
  task_type: TaskType;
}

const DEBUG_FIX_PATTERNS = [
  /sửa/i, /fix/i, /lỗi/i, /bug/i, /error/i, /broken/i,
  /không\s*(load|chạy|hoạt động|hiện|work)/i, /crash/i, /fail/i,
];

const SCAN_REVIEW_PATTERNS = [
  /review/i, /scan/i, /kiểm\s*tra/i, /audit/i, /check/i, /inspect/i,
  /analyze/i, /phân\s*tích/i,
];

const IMPLEMENT_PATTERNS = [
  /thêm/i, /add/i, /implement/i, /create/i, /build/i, /tạo/i,
  /tính\s*năng/i, /feature/i, /new/i,
];

const VERIFY_PATTERNS = [
  /verify/i, /xác\s*nhận/i, /test\s+only/i, /chạy\s+test/i,
  /validate/i, /confirm/i,
];

export function classifyTaskType(input: string): TaskType {
  // Priority order: debug_fix > scan_review > implement > verify > default
  for (const pattern of DEBUG_FIX_PATTERNS) {
    if (pattern.test(input)) return 'debug_fix';
  }
  for (const pattern of SCAN_REVIEW_PATTERNS) {
    if (pattern.test(input)) return 'scan_review';
  }
  for (const pattern of IMPLEMENT_PATTERNS) {
    if (pattern.test(input)) return 'implement_feature';
  }
  for (const pattern of VERIFY_PATTERNS) {
    if (pattern.test(input)) return 'verify_only';
  }
  // Default
  return 'debug_fix';
}

export function normalizeTask(input: NormalizeInput): NormalizedTask {
  const task_type = classifyTaskType(input.raw_input);
  return {
    raw_input: input.raw_input,
    workspace_path: input.workspace_path,
    engine: input.engine,
    task_type,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/core/normalizer.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Wire normalizer into `run` command**

Update `src/cli/commands/run.ts` to create task + normalize + save to DB:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { createTask, updateTaskNormalized } from '../../core/storage/repository.js';
import { normalizeTask } from '../../core/task/normalizer.js';
import { log } from '../../utils/logger.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .requiredOption('--engine <engine>', 'Engine to use (claude, codex)')
    .requiredOption('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      const db = getDb();

      // Create task
      const task = createTask(db, {
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      log.info(`Task created: ${task.id.slice(0, 8)}`);

      // Normalize
      const normalized = normalizeTask({
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      updateTaskNormalized(db, task.id, normalized.task_type, JSON.stringify(normalized));
      log.info(`Task type: ${normalized.task_type}`);

      // TODO: prompt builder, engine adapter, runner (next phases)
      console.log('\nNormalized task:', JSON.stringify(normalized, null, 2));
    });
}
```

- [ ] **Step 6: Verify end-to-end**

```bash
npm run dev -- run --engine claude --path /tmp/test --task "sửa lỗi login"
npm run dev -- tasks
```

Expected: Task is created, normalized, visible in `tasks` list.

- [ ] **Step 7: Commit**

```bash
git add src/core/task/ tests/core/normalizer.test.ts src/cli/commands/run.ts
git commit -m "feat: add task normalization and basic task type classification"
```

---

### Task 4: Prompt Template Builder

**Files:**
- Create: `src/core/prompt/builder.ts`
- Create: `tests/core/prompt-builder.test.ts`
- Create: `prompts/claude/debug_fix.md`
- Create: `prompts/claude/scan_review.md`
- Create: `prompts/codex/debug_fix.md`
- Create: `prompts/codex/scan_review.md`

- [ ] **Step 1: Create prompt templates**

Create `prompts/claude/debug_fix.md`:

```markdown
You are working in the directory: {{workspace_path}}

## Task
{{raw_input}}

## Instructions
1. Investigate the issue described above
2. Find the root cause
3. Implement a fix
4. Verify the fix works
5. Summarize what you found and what you changed

## Output Format
When done, provide a summary with:
- Root cause
- What was fixed
- Files changed
- Verification steps taken
- Any remaining risks
```

Create `prompts/claude/scan_review.md`:

```markdown
You are working in the directory: {{workspace_path}}

## Task
{{raw_input}}

## Instructions
1. Scan and review the code related to the task above
2. Identify issues, bugs, or improvements
3. Provide a detailed report

## Output Format
When done, provide a report with:
- Issues found
- Severity of each issue
- Recommended fixes
- Any risks or concerns
```

Create `prompts/codex/debug_fix.md`:

```markdown
Working directory: {{workspace_path}}

Task: {{raw_input}}

Find the root cause, fix it, and verify. Provide a summary of changes.
```

Create `prompts/codex/scan_review.md`:

```markdown
Working directory: {{workspace_path}}

Task: {{raw_input}}

Review the code, identify issues, and provide a detailed report.
```

Create `prompts/claude/implement_feature.md`:

```markdown
You are working in the directory: {{workspace_path}}

## Task
{{raw_input}}

## Instructions
1. Understand the feature requirements described above
2. Plan the implementation approach
3. Implement the feature
4. Add or update tests as needed
5. Verify everything works

## Output Format
When done, provide a summary with:
- What was implemented
- Files created or changed
- Tests added
- Any remaining work
```

Create `prompts/claude/verify_only.md`:

```markdown
You are working in the directory: {{workspace_path}}

## Task
{{raw_input}}

## Instructions
1. Run the relevant tests or verification steps
2. Check that the described behavior works correctly
3. Report your findings

## Output Format
When done, provide:
- Verification results
- Pass/fail status
- Any issues found
```

Create `prompts/codex/implement_feature.md`:

```markdown
Working directory: {{workspace_path}}

Task: {{raw_input}}

Implement the feature, add tests, and verify. Provide a summary of changes.
```

Create `prompts/codex/verify_only.md`:

```markdown
Working directory: {{workspace_path}}

Task: {{raw_input}}

Run verification and tests. Report pass/fail status and any issues found.
```

- [ ] **Step 2: Write failing tests for prompt builder**

Create `tests/core/prompt-builder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/core/prompt/builder.js';

describe('buildPrompt', () => {
  it('builds prompt from template with variable substitution', () => {
    const result = buildPrompt({
      engine: 'claude',
      task_type: 'debug_fix',
      variables: {
        workspace_path: '/Users/test/project',
        raw_input: 'fix the login bug',
      },
    });

    expect(result).toContain('/Users/test/project');
    expect(result).toContain('fix the login bug');
    expect(result).toContain('Root cause');
  });

  it('builds prompt for codex engine', () => {
    const result = buildPrompt({
      engine: 'codex',
      task_type: 'scan_review',
      variables: {
        workspace_path: '/tmp/project',
        raw_input: 'review all API endpoints',
      },
    });

    expect(result).toContain('/tmp/project');
    expect(result).toContain('review all API endpoints');
  });

  it('throws on unknown engine', () => {
    expect(() => buildPrompt({
      engine: 'unknown',
      task_type: 'debug_fix',
      variables: { workspace_path: '/tmp', raw_input: 'test' },
    })).toThrow();
  });

  it('throws on unknown task_type', () => {
    expect(() => buildPrompt({
      engine: 'claude',
      task_type: 'unknown_type' as any,
      variables: { workspace_path: '/tmp', raw_input: 'test' },
    })).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/core/prompt-builder.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Implement prompt builder**

Create `src/core/prompt/builder.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { TaskType } from '../../types/index.js';

interface BuildPromptInput {
  engine: string;
  task_type: TaskType | string;
  variables: Record<string, string>;
}

function getPromptsDir(): string {
  // Walk up from current file to find prompts/ directory
  // In dev: src/core/prompt/builder.ts → 3 levels up → prompts/
  // In dist: dist/core/prompt/builder.js → 3 levels up → prompts/
  let dir = path.dirname(new URL(import.meta.url).pathname);
  // Go up to project root
  for (let i = 0; i < 3; i++) {
    dir = path.dirname(dir);
  }
  return path.join(dir, 'prompts');
}

export function buildPrompt(input: BuildPromptInput): string {
  const promptsDir = getPromptsDir();
  const templatePath = path.join(promptsDir, input.engine, `${input.task_type}.md`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }

  let template = fs.readFileSync(templatePath, 'utf-8');

  for (const [key, value] of Object.entries(input.variables)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- tests/core/prompt-builder.test.ts
```

Expected: All PASS.

- [ ] **Step 6: Wire prompt builder into `run` command**

Update `src/cli/commands/run.ts` — add after normalization:

```ts
import { buildPrompt } from '../../core/prompt/builder.js';
```

In the action handler, after the normalize section:

```ts
      // Build prompt
      const promptFinal = buildPrompt({
        engine: opts.engine,
        task_type: normalized.task_type,
        variables: {
          workspace_path: opts.path,
          raw_input: opts.task,
        },
      });
      log.info(`Prompt built (${promptFinal.length} chars)`);
      console.log('\n--- Prompt ---');
      console.log(promptFinal);
      console.log('--- End Prompt ---\n');
```

- [ ] **Step 7: Verify end-to-end**

```bash
npm run dev -- run --engine claude --path /tmp/test --task "sửa lỗi login không load"
```

Expected: Shows normalized task + generated prompt with variables filled in.

- [ ] **Step 8: Commit**

```bash
git add src/core/prompt/ tests/core/prompt-builder.test.ts prompts/ src/cli/commands/run.ts
git commit -m "feat: add prompt template builder for debug and review tasks"
```

---

## Chunk 3: Engine Adapters & Process Runner (Tasks 5–6)

### Task 5: Engine Adapter Abstraction

**Files:**
- Create: `src/core/engine/types.ts`
- Create: `src/core/engine/claude.ts`
- Create: `src/core/engine/codex.ts`
- Create: `tests/core/engine-claude.test.ts`
- Create: `tests/core/engine-codex.test.ts`

- [ ] **Step 1: Define engine adapter interface**

Create `src/core/engine/types.ts`:

```ts
export interface EngineCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface EngineAdapter {
  name: string;
  buildCommand(input: EngineCommandInput): EngineCommand;
  validateExecutable(): boolean;
}

export interface EngineCommandInput {
  prompt: string;
  workspacePath: string;
}
```

- [ ] **Step 2: Write failing tests for Claude adapter**

Create `tests/core/engine-claude.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/core/engine/claude.js';

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('claude');
  });

  it('builds command with prompt and workspace path', () => {
    const cmd = adapter.buildCommand({
      prompt: 'Fix the bug in login handler',
      workspacePath: '/Users/test/project',
    });

    expect(cmd.executable).toBe('claude');
    expect(cmd.args).toContain('--print');
    expect(cmd.args.some(a => a.includes('Fix the bug'))).toBe(true);
  });
});
```

- [ ] **Step 3: Write failing tests for Codex adapter**

Create `tests/core/engine-codex.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../../src/core/engine/codex.js';

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('codex');
  });

  it('builds command with prompt and workspace path', () => {
    const cmd = adapter.buildCommand({
      prompt: 'Review the API endpoints',
      workspacePath: '/Users/test/project',
    });

    expect(cmd.executable).toBe('codex');
    expect(cmd.args.some(a => a.includes('Review the API'))).toBe(true);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
npm test -- tests/core/engine-claude.test.ts tests/core/engine-codex.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Implement Claude adapter**

Create `src/core/engine/claude.ts`:

```ts
import { execSync } from 'node:child_process';
import type { EngineAdapter, EngineCommand, EngineCommandInput } from './types.js';

export class ClaudeAdapter implements EngineAdapter {
  name = 'claude';

  buildCommand(input: EngineCommandInput): EngineCommand {
    return {
      executable: 'claude',
      args: [
        '--print',
        '--dangerously-skip-permissions',
        input.prompt,
      ],
      env: {},
    };
  }

  validateExecutable(): boolean {
    try {
      execSync('which claude', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 6: Implement Codex adapter**

Create `src/core/engine/codex.ts`:

```ts
import { execSync } from 'node:child_process';
import type { EngineAdapter, EngineCommand, EngineCommandInput } from './types.js';

export class CodexAdapter implements EngineAdapter {
  name = 'codex';

  buildCommand(input: EngineCommandInput): EngineCommand {
    return {
      executable: 'codex',
      args: [
        '--quiet',
        '--auto-edit',
        input.prompt,
      ],
      env: {},
    };
  }

  validateExecutable(): boolean {
    try {
      execSync('which codex', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 7: Create engine factory**

Add to `src/core/engine/types.ts` (append):

```ts
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

const adapters: Record<string, () => EngineAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
};

export function getEngine(name: string): EngineAdapter {
  const factory = adapters[name];
  if (!factory) {
    throw new Error(`Unknown engine: ${name}. Available: ${Object.keys(adapters).join(', ')}`);
  }
  return factory();
}
```

- [ ] **Step 8: Run tests to verify they pass**

```bash
npm test -- tests/core/engine-claude.test.ts tests/core/engine-codex.test.ts
```

Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/engine/ tests/core/engine-claude.test.ts tests/core/engine-codex.test.ts
git commit -m "feat: add engine adapter abstraction for claude and codex cli"
```

---

### Task 6: Process Runner

**Files:**
- Create: `src/core/runner/process.ts`
- Create: `tests/core/process-runner.test.ts`
- Modify: `src/cli/commands/run.ts`

- [ ] **Step 1: Write failing tests for process runner**

Create `tests/core/process-runner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/core/runner/process.js';
import type { EngineCommand } from '../../src/core/engine/types.js';

describe('runProcess', () => {
  it('runs a simple command and captures output', async () => {
    const lines: { stream: string; line: string }[] = [];

    const result = await runProcess(
      { executable: 'echo', args: ['hello world'], env: {} },
      {
        onLine: (stream, line) => lines.push({ stream, line }),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].line).toContain('hello world');
  });

  it('captures stderr', async () => {
    const lines: { stream: string; line: string }[] = [];

    const result = await runProcess(
      { executable: 'sh', args: ['-c', 'echo error >&2'], env: {} },
      {
        onLine: (stream, line) => lines.push({ stream, line }),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines.some(l => l.stream === 'stderr' && l.line.includes('error'))).toBe(true);
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await runProcess(
      { executable: 'sh', args: ['-c', 'exit 1'], env: {} },
      { onLine: () => {} }
    );

    expect(result.exitCode).toBe(1);
  });

  it('reports pid', async () => {
    let capturedPid: number | undefined;

    await runProcess(
      { executable: 'echo', args: ['test'], env: {} },
      {
        onLine: () => {},
        onPid: (pid) => { capturedPid = pid; },
      }
    );

    expect(capturedPid).toBeDefined();
    expect(capturedPid).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/core/process-runner.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement process runner**

Create `src/core/runner/process.ts`:

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineCommand } from '../engine/types.js';

export interface ProcessCallbacks {
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
  onPid?: (pid: number) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  pid: number | undefined;
}

export function runProcess(
  command: EngineCommand,
  callbacks: ProcessCallbacks,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: undefined, // Will be set by caller if needed
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      callbacks.onPid?.(child.pid);
    }

    const stdoutRl = createInterface({ input: child.stdout! });
    const stderrRl = createInterface({ input: child.stderr! });

    stdoutRl.on('line', (line) => callbacks.onLine('stdout', line));
    stderrRl.on('line', (line) => callbacks.onLine('stderr', line));

    child.on('error', (err) => {
      reject(new Error(`Failed to start process: ${err.message}`));
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code,
        pid: child.pid,
      });
    });
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/core/process-runner.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Wire everything into `run` command — full flow**

Rewrite `src/cli/commands/run.ts` to orchestrate the full flow:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import {
  createTask, updateTaskNormalized, updateTaskStatus,
  createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog,
} from '../../core/storage/repository.js';
import { normalizeTask } from '../../core/task/normalizer.js';
import { buildPrompt } from '../../core/prompt/builder.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { log } from '../../utils/logger.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .requiredOption('--engine <engine>', 'Engine to use (claude, codex)')
    .requiredOption('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      const db = getDb();

      // 1. Create task
      const task = createTask(db, {
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      log.info(`Task created: ${task.id.slice(0, 8)}`);

      // 2. Normalize
      const normalized = normalizeTask({
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      updateTaskNormalized(db, task.id, normalized.task_type, JSON.stringify(normalized));
      log.info(`Task type: ${normalized.task_type}`);

      // 3. Build prompt
      const promptFinal = buildPrompt({
        engine: opts.engine,
        task_type: normalized.task_type,
        variables: {
          workspace_path: opts.path,
          raw_input: opts.task,
        },
      });
      log.info(`Prompt built (${promptFinal.length} chars)`);

      // 4. Get engine adapter
      const engine = getEngine(opts.engine);
      if (!engine.validateExecutable()) {
        log.error(`Engine executable '${opts.engine}' not found in PATH`);
        updateTaskStatus(db, task.id, 'failed');
        process.exit(1);
      }

      // 5. Build command
      const command = engine.buildCommand({
        prompt: promptFinal,
        workspacePath: opts.path,
      });

      // 6. Create run record
      const run = createRun(db, {
        task_id: task.id,
        engine: opts.engine,
        command: command.executable,
        args_json: JSON.stringify(command.args),
        prompt_final: promptFinal,
      });
      log.info(`Run created: ${run.id.slice(0, 8)}`);

      // 7. Execute
      updateTaskStatus(db, task.id, 'running');
      updateRunStarted(db, run.id);

      log.info('Starting engine process...');
      console.log('');

      try {
        const result = await runProcess(command, {
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            const prefix = stream === 'stderr' ? '[ERR] ' : '';
            console.log(`${prefix}${line}`);
          },
          onPid: (pid) => {
            updateRunPid(db, run.id, pid);
            log.info(`Process started with PID: ${pid}`);
          },
        });

        // 8. Finalize
        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode);
        updateTaskStatus(db, task.id, status);

        console.log('');
        log.info(`Run finished with exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
        log.info(`Status: ${status}`);
      } catch (err: any) {
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 6: Test end-to-end with a real echo command (dry run)**

```bash
# Quick smoke test with echo instead of real engine
npm run dev -- run --engine claude --path /tmp/test --task "hello test"
```

If `claude` CLI is installed, this will actually run. If not, it will fail with a useful error.

- [ ] **Step 7: Commit**

```bash
git add src/core/runner/ tests/core/process-runner.test.ts src/cli/commands/run.ts src/core/engine/types.ts
git commit -m "feat: add process runner with live stdout stderr streaming"
```

---

## Chunk 4: Logs & Heartbeat (Tasks 7–8)

### Task 7: Log Pipeline & Viewing

**Files:**
- Create: `src/utils/lookup.ts`
- Modify: `src/cli/commands/logs.ts`
- Modify: `src/cli/commands/run.ts` (already wired in Task 6)

- [ ] **Step 1: Create shared lookup helpers**

Create `src/utils/lookup.ts`:

```ts
import type Database from 'better-sqlite3';
import { getRunById, getTaskById } from '../core/storage/repository.js';

export function findRunByPrefix(db: Database.Database, prefix: string): any {
  const exact = getRunById(db, prefix);
  if (exact) return exact;

  const all = db.prepare('SELECT * FROM runs WHERE id LIKE ? LIMIT 2').all(`${prefix}%`);
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    console.error(`Ambiguous run ID prefix: ${prefix}. Multiple matches.`);
    process.exit(1);
  }
  return null;
}

export function findTaskByPrefix(db: Database.Database, prefix: string): any {
  const exact = getTaskById(db, prefix);
  if (exact) return exact;

  const all = db.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 2').all(`${prefix}%`);
  if (all.length === 1) return all[0];
  if (all.length > 1) {
    console.error(`Ambiguous task ID prefix: ${prefix}. Multiple matches.`);
    process.exit(1);
  }
  return null;
}
```

- [ ] **Step 2: Implement logs command**

Update `src/cli/commands/logs.ts`:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { getRunLogs } from '../../core/storage/repository.js';
import { findRunByPrefix } from '../../utils/lookup.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <runId>')
    .description('View logs for a run')
    .option('--tail <n>', 'Show last N lines', '0')
    .option('--stream <type>', 'Filter by stream type (stdout, stderr)')
    .action(async (runId: string, opts) => {
      const db = getDb();

      // Support short IDs
      const run = findRunByPrefix(db, runId);
      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      let logs = getRunLogs(db, run.id);

      if (opts.stream) {
        logs = logs.filter(l => l.stream_type === opts.stream);
      }

      const tail = parseInt(opts.tail, 10);
      if (tail > 0) {
        logs = logs.slice(-tail);
      }

      if (logs.length === 0) {
        console.log('No logs found.');
        return;
      }

      for (const entry of logs) {
        const prefix = entry.stream_type === 'stderr' ? '[ERR] ' : '';
        console.log(`${entry.seq.toString().padStart(5)} ${prefix}${entry.line}`);
      }

      console.log(`\n--- ${logs.length} lines ---`);
    });
}
```

- [ ] **Step 2: Verify it works**

After a run has been executed:

```bash
npm run dev -- logs <runId>
npm run dev -- logs <runId> --tail 10
npm run dev -- logs <runId> --stream stderr
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/logs.ts src/utils/lookup.ts
git commit -m "feat: persist run logs and add log viewing command"
```

---

### Task 8: Heartbeat Monitor

**Files:**
- Create: `src/core/heartbeat/monitor.ts`
- Create: `tests/core/heartbeat.test.ts`
- Modify: `src/cli/commands/run.ts`

- [ ] **Step 1: Write failing tests for heartbeat**

Create `tests/core/heartbeat.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatMonitor } from '../../src/core/heartbeat/monitor.js';

describe('HeartbeatMonitor', () => {
  let events: { status: string; noOutputSeconds: number }[];

  beforeEach(() => {
    events = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits alive heartbeat when output is recent', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 30,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, noOutputSeconds });
      },
    });

    monitor.start();
    monitor.recordOutput('some log line');

    vi.advanceTimersByTime(1000);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('alive');
    expect(events[0].noOutputSeconds).toBeLessThan(5);

    monitor.stop();
  });

  it('emits suspected_stuck when no output for too long', () => {
    const monitor = new HeartbeatMonitor({
      intervalMs: 1000,
      stuckThresholdSeconds: 5,
      onHeartbeat: (status, summary, noOutputSeconds) => {
        events.push({ status, noOutputSeconds });
      },
    });

    monitor.start();
    // No recordOutput call

    vi.advanceTimersByTime(6000);
    const stuckEvents = events.filter(e => e.status === 'suspected_stuck');
    expect(stuckEvents.length).toBeGreaterThan(0);

    monitor.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/core/heartbeat.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement heartbeat monitor**

Create `src/core/heartbeat/monitor.ts`:

```ts
import type { HeartbeatStatus } from '../../types/index.js';

export interface HeartbeatConfig {
  intervalMs: number;
  stuckThresholdSeconds: number;
  onHeartbeat: (status: HeartbeatStatus, summary: string, noOutputSeconds: number) => void;
}

export class HeartbeatMonitor {
  private config: HeartbeatConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOutputAt: number = Date.now();
  private lastLine: string = '';

  constructor(config: HeartbeatConfig) {
    this.config = config;
  }

  start(): void {
    this.lastOutputAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  recordOutput(line: string): void {
    this.lastOutputAt = Date.now();
    this.lastLine = line.slice(0, 100);
  }

  private tick(): void {
    const noOutputSeconds = (Date.now() - this.lastOutputAt) / 1000;

    let status: HeartbeatStatus;
    let summary: string;

    if (noOutputSeconds > this.config.stuckThresholdSeconds) {
      status = 'suspected_stuck';
      summary = `No output for ${Math.round(noOutputSeconds)}s`;
    } else if (noOutputSeconds > this.config.stuckThresholdSeconds / 2) {
      status = 'idle';
      summary = `Idle ${Math.round(noOutputSeconds)}s. Last: ${this.lastLine}`;
    } else {
      status = 'alive';
      summary = this.lastLine || 'Running';
    }

    this.config.onHeartbeat(status, summary, noOutputSeconds);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/core/heartbeat.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Wire heartbeat into `run` command**

In `src/cli/commands/run.ts`, add imports:

```ts
import { HeartbeatMonitor } from '../../core/heartbeat/monitor.js';
import { createHeartbeat } from '../../core/storage/repository.js';
```

In the action handler, before calling `runProcess`, start the heartbeat:

```ts
      // Start heartbeat
      const heartbeat = new HeartbeatMonitor({
        intervalMs: 15000, // 15 seconds
        stuckThresholdSeconds: 60,
        onHeartbeat: (status, summary, noOutputSeconds) => {
          createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
          if (status === 'suspected_stuck') {
            log.error(`⚠ Suspected stuck: no output for ${Math.round(noOutputSeconds)}s`);
          }
        },
      });
      heartbeat.start();
```

In the `onLine` callback, add:

```ts
            heartbeat.recordOutput(line);
```

After `runProcess` completes (in both success and catch blocks):

```ts
        heartbeat.stop();
```

- [ ] **Step 6: Verify end-to-end**

Run a task and observe heartbeat messages appearing periodically.

- [ ] **Step 7: Commit**

```bash
git add src/core/heartbeat/ tests/core/heartbeat.test.ts src/cli/commands/run.ts
git commit -m "feat: add heartbeat tracking and basic stuck suspicion detection"
```

---

## Chunk 5: Report, Resume & Hardening (Tasks 9–11)

### Task 9: Report Generator

**Files:**
- Create: `src/core/report/generator.ts`
- Create: `tests/core/report-generator.test.ts`
- Modify: `src/cli/commands/report.ts`
- Modify: `src/cli/commands/run.ts`

- [ ] **Step 1: Write failing tests for report generator**

Create `tests/core/report-generator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateReport } from '../../src/core/report/generator.js';
import type { Task, Run, RunLog } from '../../src/types/index.js';

describe('generateReport', () => {
  it('generates a structured report from run data', () => {
    const task: Task = {
      id: 'task-1', raw_input: 'fix login bug', workspace_path: '/tmp',
      engine: 'claude', task_type: 'debug_fix', normalized_json: '{}',
      status: 'completed', created_at: '', updated_at: '',
    };

    const run: Run = {
      id: 'run-1', task_id: 'task-1', engine: 'claude', command: 'claude',
      args_json: '[]', prompt_final: 'Fix the login bug', status: 'completed',
      pid: 123, started_at: '2026-03-17T10:00:00Z', finished_at: '2026-03-17T10:05:00Z',
      exit_code: 0,
    };

    const logs: RunLog[] = [
      { id: 1, run_id: 'run-1', seq: 1, timestamp: '', stream_type: 'stdout', line: 'Investigating login handler...' },
      { id: 2, run_id: 'run-1', seq: 2, timestamp: '', stream_type: 'stdout', line: 'Found null check missing in auth.ts' },
      { id: 3, run_id: 'run-1', seq: 3, timestamp: '', stream_type: 'stdout', line: 'Fixed: added null check' },
      { id: 4, run_id: 'run-1', seq: 4, timestamp: '', stream_type: 'stdout', line: 'Tests pass' },
    ];

    const report = generateReport(task, run, logs);

    expect(report.summary).toBeDefined();
    expect(report.summary.length).toBeGreaterThan(0);
  });

  it('handles failed runs', () => {
    const task: Task = {
      id: 'task-1', raw_input: 'fix something', workspace_path: '/tmp',
      engine: 'claude', task_type: 'debug_fix', normalized_json: '{}',
      status: 'failed', created_at: '', updated_at: '',
    };

    const run: Run = {
      id: 'run-1', task_id: 'task-1', engine: 'claude', command: 'claude',
      args_json: '[]', prompt_final: 'prompt', status: 'failed',
      pid: 123, started_at: '2026-03-17T10:00:00Z', finished_at: '2026-03-17T10:01:00Z',
      exit_code: 1,
    };

    const logs: RunLog[] = [
      { id: 1, run_id: 'run-1', seq: 1, timestamp: '', stream_type: 'stderr', line: 'Error: something went wrong' },
    ];

    const report = generateReport(task, run, logs);
    expect(report.summary).toContain('failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/core/report-generator.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement report generator**

Create `src/core/report/generator.ts`:

```ts
import type { Task, Run, RunLog } from '../../types/index.js';

interface ReportData {
  summary: string;
  root_cause: string | null;
  fix_applied: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  remaining_risks: string | null;
}

export function generateReport(task: Task, run: Run, logs: RunLog[]): ReportData {
  const duration = run.started_at && run.finished_at
    ? formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
    : 'unknown';

  const stdoutLines = logs.filter(l => l.stream_type === 'stdout').map(l => l.line);
  const stderrLines = logs.filter(l => l.stream_type === 'stderr').map(l => l.line);

  const isFailed = run.status === 'failed' || (run.exit_code !== null && run.exit_code !== 0);

  // Extract file changes from log lines (simple heuristic)
  const fileChanges = extractFileChanges(stdoutLines);

  // Build summary
  let summary: string;
  if (isFailed) {
    const lastErrors = stderrLines.slice(-5).join('\n');
    summary = `Run failed (exit code: ${run.exit_code}, duration: ${duration}).\n\nTask: ${task.raw_input}\n\nLast errors:\n${lastErrors || '(no stderr output)'}`;
  } else {
    const tailLines = stdoutLines.slice(-10).join('\n');
    summary = `Run completed successfully (exit code: 0, duration: ${duration}).\n\nTask: ${task.raw_input}\n\nFinal output:\n${tailLines || '(no stdout output)'}`;
  }

  // Try to extract structured info from logs
  const rootCause = extractPattern(stdoutLines, /(?:root\s*cause|found|issue|problem)[:\s]+(.*)/i);
  const fixApplied = extractPattern(stdoutLines, /(?:fix(?:ed)?|changed|updated|added)[:\s]+(.*)/i);
  const verification = extractPattern(stdoutLines, /(?:test(?:s)?|verif(?:y|ied)|pass(?:es|ing)?)[:\s]+(.*)/i);

  return {
    summary,
    root_cause: rootCause,
    fix_applied: fixApplied,
    files_changed_json: fileChanges.length > 0 ? JSON.stringify(fileChanges) : null,
    verification_notes: verification,
    remaining_risks: null,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function extractFileChanges(lines: string[]): string[] {
  const files = new Set<string>();
  const filePattern = /(?:modified|created|changed|edited|updated|wrote)\s+[`']?([^\s`']+\.[a-z]{1,10})[`']?/gi;
  for (const line of lines) {
    let match;
    while ((match = filePattern.exec(line)) !== null) {
      files.add(match[1]);
    }
  }
  return Array.from(files);
}

function extractPattern(lines: string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- tests/core/report-generator.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Implement report command**

Update `src/cli/commands/report.ts`:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { getReportByRunId } from '../../core/storage/repository.js';
import { findRunByPrefix } from '../../utils/lookup.js';

export function registerReportCommand(program: Command): void {
  program
    .command('report <runId>')
    .description('View report for a run')
    .action(async (runId: string) => {
      const db = getDb();

      const run = findRunByPrefix(db, runId);
      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      const report = getReportByRunId(db, run.id);
      if (!report) {
        console.error(`No report found for run: ${run.id.slice(0, 8)}`);
        process.exit(1);
      }

      console.log('=== Run Report ===');
      console.log(`Run: ${run.id.slice(0, 8)}`);
      console.log(`Engine: ${run.engine}`);
      console.log(`Status: ${run.status}`);
      console.log(`Exit Code: ${run.exit_code}`);
      console.log('');
      console.log('--- Summary ---');
      console.log(report.summary);

      if (report.root_cause) {
        console.log('\n--- Root Cause ---');
        console.log(report.root_cause);
      }
      if (report.fix_applied) {
        console.log('\n--- Fix Applied ---');
        console.log(report.fix_applied);
      }
      if (report.files_changed_json) {
        console.log('\n--- Files Changed ---');
        const files = JSON.parse(report.files_changed_json);
        for (const f of files) console.log(`  - ${f}`);
      }
      if (report.verification_notes) {
        console.log('\n--- Verification ---');
        console.log(report.verification_notes);
      }
      if (report.remaining_risks) {
        console.log('\n--- Remaining Risks ---');
        console.log(report.remaining_risks);
      }
    });
}
```

- [ ] **Step 6: Wire report generation into `run` command**

In `src/cli/commands/run.ts`, add the report import at the top:

```ts
import { generateReport } from '../../core/report/generator.js';
```

And merge `saveReport, getRunLogs, getTaskById` into the existing repository import (from Task 6):

```ts
import {
  createTask, updateTaskNormalized, updateTaskStatus,
  createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, saveReport, getRunLogs, getTaskById,
} from '../../core/storage/repository.js';
```

After `runProcess` completes successfully (before the final log messages), add:

```ts
        // Generate report
        const allLogs = getRunLogs(db, run.id);
        const updatedTask = getTaskById(db, task.id)!;
        const updatedRun: Run = {
          ...run,
          status: status as RunStatus,
          exit_code: result.exitCode,
          finished_at: new Date().toISOString(),
        };
        const reportData = generateReport(updatedTask, updatedRun, allLogs);
        saveReport(db, { run_id: run.id, ...reportData });
        log.info(`Report saved. View with: conductor report ${run.id.slice(0, 8)}`);
```

Also add to the imports at the top of `run.ts`:

```ts
import type { Run, RunStatus } from '../../types/index.js';
```

- [ ] **Step 7: Verify end-to-end**

```bash
npm run dev -- run --engine claude --path /tmp/test --task "test task"
npm run dev -- report <runId>
```

- [ ] **Step 8: Commit**

```bash
git add src/core/report/ tests/core/report-generator.test.ts src/cli/commands/report.ts src/cli/commands/run.ts
git commit -m "feat: generate final structured run reports from execution results"
```

---

### Task 10: Resume Flow

**Files:**
- Create: `src/cli/commands/resume.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Create resume command**

Create `src/cli/commands/resume.ts`:

```ts
import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import {
  getRunsByTaskId, getRunLogs, getReportByRunId,
  createRun, updateTaskStatus, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, createHeartbeat, saveReport,
} from '../../core/storage/repository.js';
import { buildPrompt } from '../../core/prompt/builder.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { HeartbeatMonitor } from '../../core/heartbeat/monitor.js';
import { generateReport } from '../../core/report/generator.js';
import { findTaskByPrefix } from '../../utils/lookup.js';
import { log } from '../../utils/logger.js';
import type { Task, Run, RunStatus } from '../../types/index.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume <taskId>')
    .description('Resume a task with context from previous runs')
    .action(async (taskId: string) => {
      const db = getDb();

      // Find task (support short ID)
      const task = findTaskByPrefix(db, taskId);
      if (!task) {
        console.error(`Task not found: ${taskId}`);
        process.exit(1);
      }

      // Get previous runs
      const prevRuns = getRunsByTaskId(db, task.id);
      if (prevRuns.length === 0) {
        console.error('No previous runs found for this task.');
        process.exit(1);
      }

      // Build context summary from last run
      const lastRun = prevRuns[0];
      const lastReport = getReportByRunId(db, lastRun.id);
      const lastLogs = getRunLogs(db, lastRun.id);
      const logTail = lastLogs.slice(-20).map(l => l.line).join('\n');

      const previousContext = [
        `## Previous Run Summary`,
        `Status: ${lastRun.status}`,
        `Exit code: ${lastRun.exit_code}`,
        lastReport ? `Report: ${lastReport.summary}` : '',
        `\n## Last 20 log lines:\n${logTail}`,
      ].filter(Boolean).join('\n');

      // Build new prompt with resume context
      const resumePrompt = [
        buildPrompt({
          engine: task.engine,
          task_type: task.task_type || 'debug_fix',
          variables: {
            workspace_path: task.workspace_path,
            raw_input: task.raw_input,
          },
        }),
        '\n---\n',
        '## Context from previous attempt\n',
        previousContext,
        '\n\nPlease continue from where the previous run left off. Focus on what remains to be done.',
      ].join('\n');

      log.info(`Resuming task: ${task.id.slice(0, 8)}`);
      log.info(`Previous runs: ${prevRuns.length}`);

      // Get engine
      const engine = getEngine(task.engine);
      const command = engine.buildCommand({
        prompt: resumePrompt,
        workspacePath: task.workspace_path,
      });

      // Create new run
      const run = createRun(db, {
        task_id: task.id,
        engine: task.engine,
        command: command.executable,
        args_json: JSON.stringify(command.args),
        prompt_final: resumePrompt,
      });

      updateTaskStatus(db, task.id, 'running');
      updateRunStarted(db, run.id);

      const heartbeat = new HeartbeatMonitor({
        intervalMs: 15000,
        stuckThresholdSeconds: 60,
        onHeartbeat: (status, summary, noOutputSeconds) => {
          createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
          if (status === 'suspected_stuck') {
            log.error(`⚠ Suspected stuck: no output for ${Math.round(noOutputSeconds)}s`);
          }
        },
      });
      heartbeat.start();

      try {
        const result = await runProcess(command, {
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            heartbeat.recordOutput(line);
            const prefix = stream === 'stderr' ? '[ERR] ' : '';
            console.log(`${prefix}${line}`);
          },
          onPid: (pid) => {
            updateRunPid(db, run.id, pid);
          },
        });

        heartbeat.stop();

        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode);
        updateTaskStatus(db, task.id, status);

        const allLogs = getRunLogs(db, run.id);
        const updatedTask = { ...task, status } as Task;
        const updatedRun: Run = {
          ...run,
          status: status as RunStatus,
          exit_code: result.exitCode,
          finished_at: new Date().toISOString(),
        };
        const reportData = generateReport(updatedTask, updatedRun, allLogs);
        saveReport(db, { run_id: run.id, ...reportData });

        log.info(`Resume run finished. Exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
      } catch (err: any) {
        heartbeat.stop();
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
```

- [ ] **Step 2: Register resume command in CLI**

Update `src/cli/index.ts` — add:

```ts
import { registerResumeCommand } from './commands/resume.js';
```

And:

```ts
registerResumeCommand(program);
```

- [ ] **Step 3: Verify**

```bash
npm run dev -- resume --help
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/resume.ts src/cli/index.ts
git commit -m "feat: add basic resume flow using summarized previous run context"
```

---

### Task 11: Hardening

**Files:**
- Modify: `src/cli/commands/run.ts`
- Modify: `src/core/runner/process.ts`

- [ ] **Step 1: Add path validation to run command**

Add `fs` import at the top of `src/cli/commands/run.ts` (alongside existing imports):

```ts
import fs from 'node:fs';
```

Then, at the start of the action handler, add validation:

```ts
      // Validate path exists
      if (!fs.existsSync(opts.path)) {
        log.error(`Workspace path does not exist: ${opts.path}`);
        process.exit(1);
      }

      // Validate engine name
      const validEngines = ['claude', 'codex'];
      if (!validEngines.includes(opts.engine)) {
        log.error(`Unknown engine: ${opts.engine}. Available: ${validEngines.join(', ')}`);
        process.exit(1);
      }
```

- [ ] **Step 2: Add timeout and cwd support to process runner**

Rewrite `src/core/runner/process.ts` fully (replaces Task 6 version):

```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineCommand } from '../engine/types.js';

export interface ProcessCallbacks {
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
  onPid?: (pid: number) => void;
}

export interface ProcessOptions extends ProcessCallbacks {
  timeoutMs?: number;
  cwd?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  pid: number | undefined;
}

export function runProcess(
  command: EngineCommand,
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      options.onPid?.(child.pid);
    }

    const stdoutRl = createInterface({ input: child.stdout! });
    const stderrRl = createInterface({ input: child.stderr! });

    stdoutRl.on('line', (line) => options.onLine('stdout', line));
    stderrRl.on('line', (line) => options.onLine('stderr', line));

    // Timeout handling
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        exitCode: code,
        pid: child.pid,
      });
    });
  });
}
```

Note: The `ProcessCallbacks` type is preserved for backward compatibility — existing callers passing `ProcessCallbacks` will work because `ProcessOptions` extends it. Tests from Task 6 continue to work since `ProcessCallbacks` is a valid `ProcessOptions` (the extra fields are optional).

- [ ] **Step 3: Add Ctrl+C handling to run command**

In `src/cli/commands/run.ts`, before `runProcess` call:

```ts
      // Handle Ctrl+C gracefully
      let childPid: number | undefined;
      const cleanup = () => {
        if (childPid) {
          try { process.kill(childPid, 'SIGTERM'); } catch {}
        }
        heartbeat.stop();
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.info('Run interrupted by user');
        process.exit(130);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
```

Update the `onPid` callback to set `childPid`:

```ts
          onPid: (pid) => {
            childPid = pid;
            updateRunPid(db, run.id, pid);
            log.info(`Process started with PID: ${pid}`);
          },
```

After runProcess completes, remove listeners:

```ts
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: All tests PASS.

- [ ] **Step 5: Verify full end-to-end flow**

```bash
# Full flow test
npm run dev -- run --engine claude --path /Users/malayvuong/Sites/2026/conductor --task "kiểm tra cấu trúc project"

# View results
npm run dev -- tasks
npm run dev -- logs <runId>
npm run dev -- report <runId>
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/run.ts src/core/runner/process.ts
git commit -m "fix: harden runner validation timeout and failure handling"
```

---

## Definition of Done

V1 is done when this flow works end-to-end:

```bash
conductor run \
  --engine claude \
  --path /Users/malayvuong/Sites/2026/ispa-cms-workspace \
  --task "trong base-admin, phần cms-management không load data; hãy kiểm tra nguyên nhân, sửa, verify và báo cáo"
```

And you can view results with:

```bash
conductor tasks
conductor logs <runId>
conductor report <runId>
conductor resume <taskId>
```
