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
