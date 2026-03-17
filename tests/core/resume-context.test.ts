import { describe, it, expect } from 'vitest';
import { selectBestRun, buildResumeContext } from '../../src/core/resume/context.js';
import type { Run, RunReport } from '../../src/types/index.js';

const makeRun = (overrides?: Partial<Run>): Run => ({
  id: 'run-1', task_id: 'task-1', engine: 'claude', command: 'claude',
  args_json: '[]', prompt_final: 'prompt', status: 'completed',
  pid: 123, started_at: '2026-03-17T10:00:00Z', finished_at: '2026-03-17T10:05:00Z',
  exit_code: 0, resumed_from_run_id: null, cost_usd: null, duration_seconds: null,
  ...overrides,
});

const makeReport = (overrides?: Partial<RunReport>): RunReport => ({
  id: 'rpt-1', run_id: 'run-1', summary: 'Run completed.',
  files_inspected_json: null, files_changed_json: null,
  verification_notes: null, final_output: null,
  root_cause: null, fix_applied: null, remaining_risks: null,
  findings: null, risks: null, recommendations: null,
  what_implemented: null, follow_ups: null,
  ...overrides,
});

// ---- selectBestRun ----

describe('selectBestRun', () => {
  it('picks completed run with report over failed run', () => {
    const completedRun = makeRun({ id: 'completed', status: 'completed' });
    const failedRun = makeRun({ id: 'failed', status: 'failed' });

    const reports: Record<string, RunReport> = {
      completed: makeReport({ run_id: 'completed', summary: 'Done' }),
      failed: makeReport({ run_id: 'failed', summary: 'Failed' }),
    };

    const result = selectBestRun(
      [failedRun, completedRun],
      (id) => reports[id],
    );

    expect(result).not.toBeNull();
    expect(result!.run.id).toBe('completed');
  });

  it('picks failed run with report over run without report', () => {
    const failedWithReport = makeRun({ id: 'failed-rpt', status: 'failed' });
    const completedNoReport = makeRun({ id: 'completed-no', status: 'completed' });

    const reports: Record<string, RunReport> = {
      'failed-rpt': makeReport({ run_id: 'failed-rpt', summary: 'Partial results', findings: 'Found issue' }),
    };

    const result = selectBestRun(
      [completedNoReport, failedWithReport],
      (id) => reports[id],
    );

    expect(result!.run.id).toBe('failed-rpt');
  });

  it('returns null when no runs have reports', () => {
    const run1 = makeRun({ id: 'r1' });
    const run2 = makeRun({ id: 'r2' });

    const result = selectBestRun([run1, run2], () => undefined);
    expect(result).toBeNull();
  });

  it('returns null for empty runs array', () => {
    const result = selectBestRun([], () => undefined);
    expect(result).toBeNull();
  });

  it('skips report with no usable content', () => {
    const run1 = makeRun({ id: 'r1', status: 'completed' });
    const run2 = makeRun({ id: 'r2', status: 'completed' });

    const reports: Record<string, RunReport> = {
      r1: makeReport({ run_id: 'r1', summary: '' }),  // empty summary
      r2: makeReport({ run_id: 'r2', summary: 'Has content', findings: 'Found stuff' }),
    };

    const result = selectBestRun([run1, run2], (id) => reports[id]);
    expect(result!.run.id).toBe('r2');
  });
});

// ---- buildResumeContext ----

describe('buildResumeContext', () => {
  it('scan_review: includes findings, risks, recommendations, files_inspected', () => {
    const run = makeRun();
    const report = makeReport({
      summary: 'Scanned auth module',
      findings: 'SQL injection found',
      risks: 'Data breach possible',
      recommendations: 'Add input sanitization',
      files_inspected_json: JSON.stringify(['/app/auth.ts', '/app/db.ts']),
      // These should NOT appear for scan_review
      root_cause: 'should be ignored',
      fix_applied: 'should be ignored',
    });

    const ctx = buildResumeContext(run, report, 'scan_review');

    const labels = ctx.sections.map(s => s.label);
    expect(labels).toContain('Previous run summary');
    expect(labels).toContain('Findings from previous run');
    expect(labels).toContain('Risks identified');
    expect(labels).toContain('Recommendations');
    expect(labels).toContain('Files inspected previously');
    // Must NOT include debug_fix fields
    expect(labels).not.toContain('Previous root cause');
    expect(labels).not.toContain('Previous fix applied');
    expect(ctx.quality).toBe('full');
  });

  it('debug_fix: includes root_cause, fix_applied, files_changed, verification, remaining_risks', () => {
    const run = makeRun();
    const report = makeReport({
      summary: 'Fixed login bug',
      root_cause: 'Null check missing',
      fix_applied: 'Added null check',
      files_changed_json: JSON.stringify(['/app/auth.ts']),
      verification_notes: '10 tests passed',
      remaining_risks: 'Edge case with empty email',
    });

    const ctx = buildResumeContext(run, report, 'debug_fix');

    const labels = ctx.sections.map(s => s.label);
    expect(labels).toContain('Previous root cause');
    expect(labels).toContain('Previous fix applied');
    expect(labels).toContain('Files changed');
    expect(labels).toContain('Verification');
    expect(labels).toContain('Remaining risks');
    expect(labels).not.toContain('Findings from previous run');
    expect(ctx.quality).toBe('full');
  });

  it('implement_feature: includes what_implemented, files_changed, follow_ups', () => {
    const run = makeRun();
    const report = makeReport({
      summary: 'Added user profile',
      what_implemented: 'Profile page with avatar',
      files_changed_json: JSON.stringify(['/app/profile.ts']),
      follow_ups: 'Add image compression',
    });

    const ctx = buildResumeContext(run, report, 'implement_feature');

    const labels = ctx.sections.map(s => s.label);
    expect(labels).toContain('What was implemented');
    expect(labels).toContain('Files changed');
    expect(labels).toContain('Follow-up notes');
    expect(labels).not.toContain('Previous root cause');
    expect(labels).not.toContain('Findings from previous run');
    expect(ctx.quality).toBe('full');
  });

  it('limited quality when report has no useful content', () => {
    const run = makeRun({ status: 'failed' });
    const report = makeReport({ summary: '' });

    const ctx = buildResumeContext(run, report, 'scan_review');
    expect(ctx.quality).toBe('limited');
  });

  it('partial quality when only summary/final_output exist', () => {
    const run = makeRun();
    const report = makeReport({
      summary: 'Did some work',
      final_output: 'Analysis complete but nothing structured.',
    });

    const ctx = buildResumeContext(run, report, 'scan_review');
    expect(ctx.quality).toBe('partial');
  });

  it('handles null report gracefully', () => {
    const run = makeRun({ status: 'failed', exit_code: 1 });
    const ctx = buildResumeContext(run, undefined, 'debug_fix');

    expect(ctx.quality).toBe('limited');
    expect(ctx.sections.length).toBe(1);
    expect(ctx.sections[0].content).toContain('failed');
  });

  it('includes final_output as last section when present', () => {
    const run = makeRun();
    const report = makeReport({
      summary: 'Done',
      findings: 'Found stuff',
      final_output: 'Detailed analysis report...',
    });

    const ctx = buildResumeContext(run, report, 'scan_review');
    const lastSection = ctx.sections[ctx.sections.length - 1];
    expect(lastSection.label).toBe('Final output from previous run');
    expect(lastSection.content).toContain('Detailed analysis');
  });
});
