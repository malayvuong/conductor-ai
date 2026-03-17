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

export function listTasks(db: Database.Database, filters?: { status?: string; engine?: string }): Task[] {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters?.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters?.engine) { conditions.push('engine = ?'); params.push(filters.engine); }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM tasks${where} ORDER BY created_at DESC`).all(...params) as Task[];
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
  resumed_from_run_id?: string | null;
}

export function createRun(db: Database.Database, input: CreateRunInput): Run {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, task_id, engine, command, args_json, prompt_final, status, resumed_from_run_id)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
  ).run(id, input.task_id, input.engine, input.command, input.args_json, input.prompt_final, input.resumed_from_run_id ?? null);
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

export function updateRunFinished(
  db: Database.Database, id: string, status: RunStatus, exitCode: number | null,
  costUsd?: number | null, durationSeconds?: number | null,
): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, cost_usd = ?, duration_seconds = ? WHERE id = ?')
    .run(status, new Date().toISOString(), exitCode, costUsd ?? null, durationSeconds ?? null, id);
}

export function listRuns(db: Database.Database, filters?: { task_id?: string; status?: string; engine?: string }): Run[] {
  const conditions: string[] = [];
  const params: any[] = [];
  if (filters?.task_id) { conditions.push('task_id = ?'); params.push(filters.task_id); }
  if (filters?.status) { conditions.push('status = ?'); params.push(filters.status); }
  if (filters?.engine) { conditions.push('engine = ?'); params.push(filters.engine); }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM runs${where} ORDER BY started_at DESC`).all(...params) as Run[];
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
  files_inspected_json: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  final_output: string | null;
  root_cause: string | null;
  fix_applied: string | null;
  remaining_risks: string | null;
  findings: string | null;
  risks: string | null;
  recommendations: string | null;
  what_implemented: string | null;
  follow_ups: string | null;
}

export function saveReport(db: Database.Database, input: SaveReportInput): RunReport {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO run_reports (id, run_id, summary, files_inspected_json, files_changed_json, verification_notes, final_output, root_cause, fix_applied, remaining_risks, findings, risks, recommendations, what_implemented, follow_ups)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.run_id, input.summary,
    input.files_inspected_json, input.files_changed_json,
    input.verification_notes, input.final_output,
    input.root_cause, input.fix_applied, input.remaining_risks,
    input.findings, input.risks, input.recommendations,
    input.what_implemented, input.follow_ups,
  );
  return getReportByRunId(db, input.run_id)!;
}

export function getReportByRunId(db: Database.Database, runId: string): RunReport | undefined {
  return db.prepare('SELECT * FROM run_reports WHERE run_id = ?').get(runId) as RunReport | undefined;
}
