import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createTask, createRun, updateRunFinished, listRuns, listTasks,
  getRunById, updateTaskNormalized,
} from '../../src/core/storage/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ---- cost_usd + duration_seconds ----

describe('cost and duration on runs', () => {
  it('stores cost_usd and duration_seconds via updateRunFinished', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    updateRunFinished(db, run.id, 'completed', 0, 0.5257, 237.5);

    const updated = getRunById(db, run.id)!;
    expect(updated.cost_usd).toBe(0.5257);
    expect(updated.duration_seconds).toBe(237.5);
    expect(updated.status).toBe('completed');
    expect(updated.exit_code).toBe(0);
  });

  it('stores null cost when not provided', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    updateRunFinished(db, run.id, 'failed', 1);

    const updated = getRunById(db, run.id)!;
    expect(updated.cost_usd).toBeNull();
    expect(updated.duration_seconds).toBeNull();
  });

  it('run has null cost/duration by default', () => {
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    expect(run.cost_usd).toBeNull();
    expect(run.duration_seconds).toBeNull();
  });
});

// ---- listRuns ----

describe('listRuns', () => {
  it('lists all runs', () => {
    const t1 = createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    const t2 = createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'codex' });
    createRun(db, { task_id: t1.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    createRun(db, { task_id: t2.id, engine: 'codex', command: 'codex', args_json: '[]', prompt_final: 'p2' });

    const runs = listRuns(db);
    expect(runs).toHaveLength(2);
  });

  it('filters by task_id', () => {
    const t1 = createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    const t2 = createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'codex' });
    createRun(db, { task_id: t1.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    createRun(db, { task_id: t1.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p2' });
    createRun(db, { task_id: t2.id, engine: 'codex', command: 'codex', args_json: '[]', prompt_final: 'p3' });

    const runs = listRuns(db, { task_id: t1.id });
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.task_id === t1.id)).toBe(true);
  });

  it('filters by status', () => {
    const t = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const r1 = createRun(db, { task_id: t.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    const r2 = createRun(db, { task_id: t.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p2' });
    updateRunFinished(db, r1.id, 'completed', 0);
    updateRunFinished(db, r2.id, 'failed', 1);

    const completed = listRuns(db, { status: 'completed' });
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(r1.id);
  });

  it('filters by engine', () => {
    const t = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    createRun(db, { task_id: t.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    createRun(db, { task_id: t.id, engine: 'codex', command: 'codex', args_json: '[]', prompt_final: 'p2' });

    const claudeRuns = listRuns(db, { engine: 'claude' });
    expect(claudeRuns).toHaveLength(1);
    expect(claudeRuns[0].engine).toBe('claude');
  });

  it('combines multiple filters', () => {
    const t = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const r1 = createRun(db, { task_id: t.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p1' });
    const r2 = createRun(db, { task_id: t.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p2' });
    const r3 = createRun(db, { task_id: t.id, engine: 'codex', command: 'codex', args_json: '[]', prompt_final: 'p3' });
    updateRunFinished(db, r1.id, 'completed', 0);
    updateRunFinished(db, r2.id, 'failed', 1);
    updateRunFinished(db, r3.id, 'completed', 0);

    const result = listRuns(db, { engine: 'claude', status: 'completed' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(r1.id);
  });

  it('returns empty for no matches', () => {
    const runs = listRuns(db, { status: 'completed' });
    expect(runs).toHaveLength(0);
  });
});

// ---- listTasks with filters ----

describe('listTasks with filters', () => {
  it('filters by status', () => {
    const t1 = createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    const t2 = createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'claude' });
    updateTaskNormalized(db, t1.id, 'debug_fix', '{}');
    updateTaskNormalized(db, t2.id, 'scan_review', '{}');

    // Both are 'created' by default
    const created = listTasks(db, { status: 'created' });
    expect(created).toHaveLength(2);

    const running = listTasks(db, { status: 'running' });
    expect(running).toHaveLength(0);
  });

  it('filters by engine', () => {
    createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'codex' });

    const claude = listTasks(db, { engine: 'claude' });
    expect(claude).toHaveLength(1);
    expect(claude[0].engine).toBe('claude');
  });

  it('combines status and engine filters', () => {
    createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'codex' });

    const result = listTasks(db, { status: 'created', engine: 'codex' });
    expect(result).toHaveLength(1);
    expect(result[0].engine).toBe('codex');
  });

  it('returns all when no filters', () => {
    createTask(db, { raw_input: 'task1', workspace_path: '/tmp', engine: 'claude' });
    createTask(db, { raw_input: 'task2', workspace_path: '/tmp', engine: 'codex' });

    const all = listTasks(db);
    expect(all).toHaveLength(2);
  });
});
