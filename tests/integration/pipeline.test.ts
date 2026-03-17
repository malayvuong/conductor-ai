import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createTask, updateTaskNormalized, updateTaskStatus,
  createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, getRunLogs, saveReport, getReportByRunId,
  createHeartbeat, getHeartbeatsByRunId, getTaskById,
} from '../../src/core/storage/repository.js';
import { runProcess } from '../../src/core/runner/process.js';
import { HeartbeatMonitor } from '../../src/core/heartbeat/monitor.js';
import { generateReport } from '../../src/core/report/generator.js';
import { normalizeTask } from '../../src/core/task/normalizer.js';
import type Database from 'better-sqlite3';
import type { Run, RunStatus } from '../../src/types/index.js';

describe('Pipeline integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('runs full pipeline: task → run → logs → report', async () => {
    // 1. Create task
    const task = createTask(db, {
      raw_input: 'fix the login bug',
      workspace_path: '/tmp',
      engine: 'claude',
    });
    expect(task.status).toBe('created');

    // 2. Normalize
    const normalized = normalizeTask({
      raw_input: task.raw_input,
      workspace_path: task.workspace_path,
      engine: task.engine,
    });
    updateTaskNormalized(db, task.id, normalized.task_type, JSON.stringify(normalized));
    expect(normalized.task_type).toBe('debug_fix');

    // 3. Create run
    const run = createRun(db, {
      task_id: task.id,
      engine: 'claude',
      command: 'echo',
      args_json: JSON.stringify(['hello from engine']),
      prompt_final: 'test prompt',
    });

    updateTaskStatus(db, task.id, 'running');
    updateRunStarted(db, run.id);

    // 4. Execute with echo (simulates engine output)
    const result = await runProcess(
      { executable: 'echo', args: ['hello from engine'], env: {} },
      {
        cwd: '/tmp',
        onLine: (stream, line) => {
          appendRunLog(db, run.id, stream, line);
        },
        onPid: (pid) => {
          updateRunPid(db, run.id, pid);
        },
      }
    );

    expect(result.exitCode).toBe(0);

    // 5. Verify logs persisted
    const logs = getRunLogs(db, run.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].line).toContain('hello from engine');
    expect(logs[0].stream_type).toBe('stdout');

    // 6. Finalize run
    const status: RunStatus = result.exitCode === 0 ? 'completed' : 'failed';
    updateRunFinished(db, run.id, status, result.exitCode);
    updateTaskStatus(db, task.id, status);

    // 7. Generate and save report
    const updatedTask = getTaskById(db, task.id)!;
    const updatedRun: Run = {
      ...run,
      status,
      exit_code: result.exitCode,
      finished_at: new Date().toISOString(),
    };
    const reportData = generateReport(updatedTask, updatedRun, logs);
    saveReport(db, { run_id: run.id, ...reportData });

    // 8. Verify report
    const report = getReportByRunId(db, run.id);
    expect(report).toBeDefined();
    expect(report!.summary).toContain('completed successfully');

    // 9. Verify task status
    const finalTask = getTaskById(db, task.id)!;
    expect(finalTask.status).toBe('completed');
  });

  it('captures cwd in spawned process', async () => {
    const lines: string[] = [];

    const result = await runProcess(
      { executable: 'pwd', args: [], env: {} },
      {
        cwd: '/tmp',
        onLine: (_stream, line) => lines.push(line),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines[0]).toMatch(/\/tmp$/);
  });

  it('pipes stdin to spawned process', async () => {
    const lines: string[] = [];

    const result = await runProcess(
      { executable: 'cat', args: [], env: {}, stdin: 'prompt text here' },
      {
        onLine: (_stream, line) => lines.push(line),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines[0]).toBe('prompt text here');
  });

  it('persists system logs alongside stdout/stderr', async () => {
    const task = createTask(db, {
      raw_input: 'test task',
      workspace_path: '/tmp',
      engine: 'claude',
    });

    const run = createRun(db, {
      task_id: task.id,
      engine: 'claude',
      command: 'echo',
      args_json: '[]',
      prompt_final: 'test',
    });

    // System log
    appendRunLog(db, run.id, 'system', 'engine=claude cwd=/tmp prompt_len=100');
    // Stdout log
    appendRunLog(db, run.id, 'stdout', 'engine output line');

    const logs = getRunLogs(db, run.id);
    expect(logs.length).toBe(2);
    expect(logs[0].stream_type).toBe('system');
    expect(logs[1].stream_type).toBe('stdout');
  });

  it('heartbeat persists events to db', async () => {
    const task = createTask(db, {
      raw_input: 'test',
      workspace_path: '/tmp',
      engine: 'claude',
    });

    const run = createRun(db, {
      task_id: task.id,
      engine: 'claude',
      command: 'echo',
      args_json: '[]',
      prompt_final: 'test',
    });

    createHeartbeat(db, {
      run_id: run.id,
      status: 'alive',
      summary: 'Running',
      no_output_seconds: 5,
    });

    createHeartbeat(db, {
      run_id: run.id,
      status: 'suspected_stuck',
      summary: 'No output for 65s',
      no_output_seconds: 65,
    });

    const beats = getHeartbeatsByRunId(db, run.id);
    expect(beats.length).toBe(2);
    expect(beats[0].status).toBe('alive');
    expect(beats[1].status).toBe('suspected_stuck');
  });
});
