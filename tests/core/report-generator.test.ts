import { describe, it, expect } from 'vitest';
import { generateReport } from '../../src/core/report/generator.js';
import type { Task, Run, RunLog } from '../../src/types/index.js';

const makeTask = (overrides?: Partial<Task>): Task => ({
  id: 'task-1', raw_input: 'fix login bug', workspace_path: '/tmp',
  engine: 'claude', task_type: 'debug_fix', normalized_json: '{}',
  status: 'completed', created_at: '', updated_at: '',
  ...overrides,
});

const makeRun = (overrides?: Partial<Run>): Run => ({
  id: 'run-1', task_id: 'task-1', engine: 'claude', command: 'claude',
  args_json: '[]', prompt_final: 'prompt', status: 'completed',
  pid: 123, started_at: '2026-03-17T10:00:00Z', finished_at: '2026-03-17T10:05:00Z',
  exit_code: 0,
  ...overrides,
});

const log = (seq: number, stream_type: string, line: string): RunLog => ({
  id: seq, run_id: 'run-1', seq, timestamp: '', stream_type: stream_type as any, line,
});

describe('generateReport', () => {
  it('generates readable summary from plain text logs', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', 'Investigating login handler...'),
      log(2, 'stdout', 'Found null check missing in auth.ts'),
      log(3, 'stdout', 'Fixed: added null check'),
      log(4, 'stdout', 'Tests pass'),
    ]);

    expect(report.summary).toContain('completed successfully');
    expect(report.summary).toContain('fix login bug');
    expect(report.summary).not.toContain('{');  // no raw JSON in summary
  });

  it('handles failed runs with stderr', () => {
    const report = generateReport(
      makeTask({ status: 'failed' }),
      makeRun({ status: 'failed', exit_code: 1 }),
      [log(1, 'stderr', 'Error: something went wrong')],
    );

    expect(report.summary).toContain('failed');
    expect(report.summary).toContain('something went wrong');
  });

  it('generates readable summary from Claude JSON event logs', () => {
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'I found the issue in auth.ts' }] },
    });
    const resultEvent = JSON.stringify({
      type: 'result', subtype: 'success', duration_ms: 15000, total_cost_usd: 0.05,
    });

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'system', 'engine=claude cwd=/tmp'),
      log(2, 'stdout', assistantEvent),
      log(3, 'stdout', resultEvent),
    ]);

    expect(report.summary).toContain('completed successfully');
    expect(report.summary).toContain('I found the issue in auth.ts');
    expect(report.summary).not.toContain('{"type"');  // no raw JSON
  });

  it('extracts files_changed from tool_use events', () => {
    const editEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/app/src/auth.ts' } }],
      },
    });
    const writeEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/app/src/new-file.ts' } }],
      },
    });

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', editEvent),
      log(2, 'stdout', writeEvent),
    ]);

    expect(report.files_changed_json).not.toBeNull();
    const files = JSON.parse(report.files_changed_json!);
    expect(files).toContain('/app/src/auth.ts');
    expect(files).toContain('/app/src/new-file.ts');
  });

  it('extracts root_cause and fix_applied from text events', () => {
    const textEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Root cause: missing null check in validateUser()' },
        ],
      },
    });
    const fixEvent = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Fixed: added null check before accessing user.email' },
        ],
      },
    });

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', textEvent),
      log(2, 'stdout', fixEvent),
    ]);

    expect(report.root_cause).toContain('missing null check');
    expect(report.fix_applied).toContain('added null check');
  });

  it('handles mixed log streams safely', () => {
    const assistantEvent = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Working on it' }] },
    });
    const hookEvent = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    const rateLimitEvent = JSON.stringify({ type: 'rate_limit_event' });

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'system', 'engine=claude cwd=/tmp'),
      log(2, 'stdout', hookEvent),
      log(3, 'stdout', assistantEvent),
      log(4, 'stderr', 'Warning: deprecated API'),
      log(5, 'stdout', rateLimitEvent),
      log(6, 'stdout', 'plain text line'),
    ]);

    expect(report.summary).toContain('completed successfully');
    expect(report.summary).not.toContain('hook_started');
    expect(report.summary).not.toContain('rate_limit');
  });

  it('returns null fields when data is not extractable', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', 'Some generic output'),
    ]);

    // root_cause, fix_applied, verification_notes should be null
    // when text doesn't match patterns
    expect(report.remaining_risks).toBeNull();
  });

  it('still works with no logs at all', () => {
    const report = generateReport(makeTask(), makeRun(), []);
    expect(report.summary).toContain('completed successfully');
    expect(report.files_changed_json).toBeNull();
  });
});
