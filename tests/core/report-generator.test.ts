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
  exit_code: 0, resumed_from_run_id: null, cost_usd: null, duration_seconds: null,
  ...overrides,
});

const log = (seq: number, stream_type: string, line: string): RunLog => ({
  id: seq, run_id: 'run-1', seq, timestamp: '', stream_type: stream_type as any, line,
});

/** Helper: create an assistant text event log line */
function textEvent(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

/** Helper: create a tool_use event log line */
function toolEvent(name: string, input: Record<string, any> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}

// ---- File separation: inspected vs changed ----

describe('generateReport — file separation', () => {
  it('Read → files_inspected, not files_changed', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/app/src/auth.ts' })),
    ]);

    expect(report.files_inspected_json).not.toBeNull();
    expect(JSON.parse(report.files_inspected_json!)).toContain('/app/src/auth.ts');
    expect(report.files_changed_json).toBeNull();
  });

  it('Edit/Write → files_changed, not files_inspected', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Edit', { file_path: '/app/src/auth.ts' })),
      log(2, 'stdout', toolEvent('Write', { file_path: '/app/src/new.ts' })),
    ]);

    expect(report.files_changed_json).not.toBeNull();
    const changed = JSON.parse(report.files_changed_json!);
    expect(changed).toContain('/app/src/auth.ts');
    expect(changed).toContain('/app/src/new.ts');
  });

  it('scan with only Read/Grep → files_inspected populated, files_changed null', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review', raw_input: 'review security' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Read', { file_path: '/app/a.ts' })),
        log(2, 'stdout', toolEvent('Grep', { path: '/app/b.ts' })),
      ],
    );

    const inspected = JSON.parse(report.files_inspected_json!);
    expect(inspected).toContain('/app/a.ts');
    expect(inspected).toContain('/app/b.ts');
    expect(report.files_changed_json).toBeNull();
  });

  it('Bash counts as inspection, not mutation', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review' }),
      makeRun(),
      [log(1, 'stdout', toolEvent('Bash', { command: 'npm test' }))],
    );
    expect(report.files_changed_json).toBeNull();
  });

  it('extracts all tool_use blocks from multi-block messages', () => {
    const multi = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/app/read.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/app/edit.ts' } },
        ],
      },
    });

    const report = generateReport(makeTask(), makeRun(), [log(1, 'stdout', multi)]);
    expect(JSON.parse(report.files_inspected_json!)).toContain('/app/read.ts');
    expect(JSON.parse(report.files_changed_json!)).toContain('/app/edit.ts');
  });
});

// ---- Task-type branching: section-based extraction ----

describe('generateReport — task-type branching', () => {
  it('scan_review: extracts findings/risks/recommendations from markdown sections', () => {
    const finalReport = textEvent([
      '## Summary',
      'Scanned the auth module for vulnerabilities.',
      '## Findings',
      '1. SQL injection in user query endpoint',
      '2. Missing CSRF tokens',
      '## Risks',
      'Unauthenticated access to admin routes is possible.',
      '## Recommendations',
      'Add input sanitization to all query parameters.',
    ].join('\n'));

    const report = generateReport(
      makeTask({ task_type: 'scan_review', raw_input: 'security review' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Read', { file_path: '/app/auth.ts' })),
        log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'file contents' })),
        log(3, 'stdout', finalReport), // post-tool = main agent report
      ],
    );

    expect(report.findings).toContain('SQL injection');
    expect(report.risks).toContain('Unauthenticated access');
    expect(report.recommendations).toContain('input sanitization');
    // Must NOT have debug_fix or implement_feature fields
    expect(report.root_cause).toBeNull();
    expect(report.fix_applied).toBeNull();
    expect(report.what_implemented).toBeNull();
    expect(report.verification_notes).toBeNull();
  });

  it('debug_fix: extracts root_cause/fix_applied from markdown sections', () => {
    const finalReport = textEvent([
      '## Root Cause',
      'Missing null check in validateUser() when email is undefined.',
      '## Fix Applied',
      'Added null check before accessing user.email in auth.ts.',
      '## Remaining Risks',
      'Other fields on user object may also be nullable.',
    ].join('\n'));

    const report = generateReport(
      makeTask({ task_type: 'debug_fix' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Edit', { file_path: '/app/auth.ts' })),
        log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
        log(3, 'stdout', finalReport),
      ],
    );

    expect(report.root_cause).toContain('Missing null check');
    expect(report.fix_applied).toContain('Added null check');
    expect(report.remaining_risks).toContain('nullable');
    expect(report.findings).toBeNull();
    expect(report.recommendations).toBeNull();
    expect(report.what_implemented).toBeNull();
  });

  it('implement_feature: extracts what_implemented/follow_ups from sections', () => {
    const finalReport = textEvent([
      '## Implementation Summary',
      'Added user profile page with avatar upload and bio editing.',
      '## Follow-up',
      'Add image compression for uploaded avatars.',
    ].join('\n'));

    const report = generateReport(
      makeTask({ task_type: 'implement_feature', raw_input: 'add user profile' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Write', { file_path: '/app/profile.ts' })),
        log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
        log(3, 'stdout', finalReport),
      ],
    );

    expect(report.what_implemented).toContain('user profile page');
    expect(report.follow_ups).toContain('image compression');
    expect(report.root_cause).toBeNull();
    expect(report.findings).toBeNull();
  });
});

// ---- No hallucination ----

describe('generateReport — no hallucination', () => {
  it('returns null for all structured fields when no markdown report exists', () => {
    const report = generateReport(
      makeTask({ task_type: 'debug_fix' }),
      makeRun(),
      [log(1, 'stdout', textEvent('I fixed the bug'))],
    );

    // Short text with no markdown structure → no sections extracted
    expect(report.root_cause).toBeNull();
    expect(report.fix_applied).toBeNull();
    expect(report.remaining_risks).toBeNull();
    expect(report.final_output).toBeNull();
  });

  it('scan_review: root_cause/fix_applied always null even if markdown has those headers', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review' }),
      makeRun(),
      [
        log(1, 'stdout', textEvent([
          '## Root Cause',
          'Something wrong.',
          '## Fix Applied',
          'Fixed it.',
        ].join('\n'))),
      ],
    );

    // scan_review never fills debug_fix fields
    expect(report.root_cause).toBeNull();
    expect(report.fix_applied).toBeNull();
  });

  it('debug_fix: findings/recommendations always null', () => {
    const report = generateReport(
      makeTask({ task_type: 'debug_fix' }),
      makeRun(),
      [
        log(1, 'stdout', textEvent([
          '## Findings',
          'Found issues.',
          '## Recommendations',
          'Fix them.',
        ].join('\n'))),
      ],
    );

    expect(report.findings).toBeNull();
    expect(report.recommendations).toBeNull();
  });

  it('returns null for everything with no logs', () => {
    const report = generateReport(makeTask(), makeRun(), []);
    expect(report.root_cause).toBeNull();
    expect(report.fix_applied).toBeNull();
    expect(report.files_inspected_json).toBeNull();
    expect(report.files_changed_json).toBeNull();
    expect(report.final_output).toBeNull();
  });
});

// ---- Final output extraction ----

describe('generateReport — final_output', () => {
  it('captures last markdown-structured text block as final_output', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
      log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'contents' })),
      log(3, 'stdout', textEvent([
        '## Summary',
        'The auth module has been reviewed and two critical issues were found.',
        '## Details',
        'SQL injection and missing CSRF tokens need to be addressed immediately.',
      ].join('\n'))),
    ]);

    expect(report.final_output).toContain('## Summary');
    expect(report.final_output).toContain('SQL injection');
  });

  it('prefers markdown block over plain long text', () => {
    const longPlain = 'x'.repeat(300); // long but no structure
    const shortMarkdown = '## Result\nFound 2 issues in the codebase that need fixing.';

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
      log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
      log(3, 'stdout', textEvent(longPlain)),  // no markdown
      log(4, 'stdout', textEvent(shortMarkdown)),  // has markdown
    ]);

    expect(report.final_output).toContain('## Result');
    expect(report.final_output).not.toContain('xxx');
  });

  it('falls back to long text (>=200 chars) if no markdown', () => {
    const longText = 'I have completed the full analysis. ' + 'The code looks good. '.repeat(15);

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
      log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
      log(3, 'stdout', textEvent(longText)),
    ]);

    expect(report.final_output).toContain('completed the full analysis');
  });

  it('null when all post-tool text is short and unstructured', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
      log(2, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
      log(3, 'stdout', textEvent('Done')),
    ]);

    expect(report.final_output).toBeNull();
  });

  it('sub-agent text during tool activity does NOT become final_output', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review', raw_input: 'audit' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Agent', { prompt: 'analyze auth' })),
        log(2, 'stdout', textEvent([
          '## Sub-agent Report',
          'Found 3 critical issues in authentication module.',
          'Details: SQL injection, broken sessions, missing CORS.',
        ].join('\n'))),
        log(3, 'stdout', JSON.stringify({ type: 'tool_result', content: 'done' })),
        log(4, 'stdout', textEvent([
          '## Summary',
          'Based on my analysis, there are three critical security vulnerabilities.',
          '## Findings',
          'SQL injection in user query, broken session handling, missing CORS.',
        ].join('\n'))),
      ],
    );

    // final_output is main agent (post-tool), not sub-agent (during tool)
    expect(report.final_output).toContain('Based on my analysis');
    expect(report.final_output).not.toContain('Sub-agent Report');
  });
});

// ---- Sub-agent isolation ----

describe('generateReport — sub-agent isolation', () => {
  it('sub-agent [DONE] does NOT appear in summary Result line', () => {
    const subResult = JSON.stringify({
      type: 'result', subtype: 'success', duration_ms: 5000, total_cost_usd: 0.02,
    });
    const mainResult = JSON.stringify({
      type: 'result', subtype: 'success', duration_ms: 45000, total_cost_usd: 0.15,
    });

    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', subResult),
      log(2, 'stdout', mainResult),
    ]);

    expect(report.summary).toContain('45s');
    expect(report.summary).toContain('$0.1500');
    expect(report.summary).not.toContain('$0.0200');
  });

  it('summary only shows post-tool text', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review', raw_input: 'review code' }),
      makeRun(),
      [
        log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
        log(2, 'stdout', textEvent('Sub-agent found issues')),  // during tools
        log(3, 'stdout', JSON.stringify({ type: 'tool_result', content: 'ok' })),
        log(4, 'stdout', textEvent('Scan complete')),  // post-tool
      ],
    );

    expect(report.summary).toContain('Scan complete');
    expect(report.summary).not.toContain('Sub-agent found');
  });
});

// ---- Verification ----

describe('generateReport — verification', () => {
  it('extracts concrete test count from tool_result', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', JSON.stringify({ type: 'tool_result', content: '86 tests passed in 1.2s' })),
    ]);
    expect(report.verification_notes).toContain('86 tests passed');
  });

  it('rejects table formatting', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', JSON.stringify({ type: 'tool_result', content: '| Status | Pass |\n|--------|------|' })),
    ]);
    expect(report.verification_notes).toBeNull();
  });

  it('rejects vague mentions', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', textEvent('The code is passing through the validator')),
    ]);
    expect(report.verification_notes).toBeNull();
  });

  it('scan_review: verification is suppressed', () => {
    const report = generateReport(
      makeTask({ task_type: 'scan_review' }),
      makeRun(),
      [log(1, 'stdout', JSON.stringify({ type: 'tool_result', content: '10 tests passed' }))],
    );
    expect(report.verification_notes).toBeNull();
  });
});

// ---- Summary basics ----

describe('generateReport — summary', () => {
  it('includes file counts', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', toolEvent('Read', { file_path: '/a.ts' })),
      log(2, 'stdout', toolEvent('Edit', { file_path: '/b.ts' })),
    ]);

    expect(report.summary).toContain('completed successfully');
    expect(report.summary).toContain('fix login bug');
    expect(report.summary).toContain('1 files inspected');
    expect(report.summary).toContain('1 files changed');
  });

  it('includes errors in failed run', () => {
    const report = generateReport(
      makeTask({ status: 'failed' }),
      makeRun({ status: 'failed', exit_code: 1 }),
      [log(1, 'stderr', 'Error: something went wrong')],
    );
    expect(report.summary).toContain('failed');
    expect(report.summary).toContain('something went wrong');
  });

  it('works with no logs', () => {
    const report = generateReport(makeTask(), makeRun(), []);
    expect(report.summary).toContain('completed successfully');
  });

  it('works with plain text (non-JSON) logs', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'stdout', 'Investigating login handler...'),
      log(2, 'stdout', 'Found null check missing'),
    ]);
    expect(report.summary).toContain('completed successfully');
    expect(report.summary).not.toContain('{');
  });

  it('handles mixed log streams', () => {
    const report = generateReport(makeTask(), makeRun(), [
      log(1, 'system', 'engine=claude cwd=/tmp'),
      log(2, 'stdout', JSON.stringify({ type: 'system', subtype: 'hook_started' })),
      log(3, 'stdout', textEvent('Working on it')),
      log(4, 'stderr', 'Warning: deprecated API'),
      log(5, 'stdout', JSON.stringify({ type: 'rate_limit_event' })),
    ]);
    expect(report.summary).toContain('completed successfully');
    expect(report.summary).not.toContain('hook_started');
    expect(report.summary).not.toContain('rate_limit');
  });
});
