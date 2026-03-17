import { describe, it, expect } from 'vitest';
import { detectProgress, determineStrategy, isWPCompleted, detectHardBlocker } from '../../src/core/supervisor/progress.js';
import type { RunReport } from '../../src/types/index.js';

const makeReport = (overrides?: Partial<RunReport>): RunReport => ({
  id: 'rpt-1', run_id: 'run-1', summary: '',
  files_inspected_json: null, files_changed_json: null,
  verification_notes: null, final_output: null,
  root_cause: null, fix_applied: null, remaining_risks: null,
  findings: null, risks: null, recommendations: null,
  what_implemented: null, follow_ups: null,
  ...overrides,
});

describe('detectProgress', () => {
  it('detects progress when files changed', () => {
    const report = makeReport({ files_changed_json: '["src/auth.ts"]' });
    const result = detectProgress(report, null);
    expect(result.hasProgress).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.indicators).toContain('1 files changed');
  });

  it('detects progress from findings', () => {
    const report = makeReport({ findings: 'SQL injection found' });
    const result = detectProgress(report, null);
    expect(result.hasProgress).toBe(true);
    expect(result.indicators).toContain('Findings produced');
  });

  it('detects progress from fix applied', () => {
    const report = makeReport({ fix_applied: 'Added null check' });
    const result = detectProgress(report, null);
    expect(result.hasProgress).toBe(true);
    expect(result.indicators).toContain('Fix applied');
  });

  it('detects progress from summary completion keywords', () => {
    const report = makeReport({ summary: 'Run completed successfully (exit code: 0)' });
    const result = detectProgress(report, null);
    expect(result.hasProgress).toBe(true);
    expect(result.indicators).toContain('Summary indicates completion');
  });

  it('no progress when report is empty', () => {
    const report = makeReport({});
    const result = detectProgress(report, null);
    expect(result.hasProgress).toBe(false);
  });

  it('no progress when report is null', () => {
    const result = detectProgress(null, null);
    expect(result.hasProgress).toBe(false);
    expect(result.indicators).toContain('No report');
  });

  it('detects new files vs previous snapshot', () => {
    const report = makeReport({
      files_inspected_json: '["src/new.ts", "src/old.ts"]',
    });
    const snapshot = {
      related_files: '["src/old.ts"]',
    } as any;

    const result = detectProgress(report, snapshot);
    expect(result.hasProgress).toBe(true);
    expect(result.indicators).toContain('1 new files touched');
  });
});

describe('determineStrategy', () => {
  it('normal for first attempt', () => {
    expect(determineStrategy(0)).toBe('normal');
  });
  it('focused for second attempt', () => {
    expect(determineStrategy(1)).toBe('focused');
  });
  it('surgical for third attempt', () => {
    expect(determineStrategy(2)).toBe('surgical');
  });
  it('recovery for fourth+', () => {
    expect(determineStrategy(3)).toBe('recovery');
    expect(determineStrategy(5)).toBe('recovery');
  });
});

describe('isWPCompleted', () => {
  it('true when summary says completed successfully', () => {
    const report = makeReport({ summary: 'Run completed successfully (exit code: 0)' });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('true when final_output has ## Status completed', () => {
    const report = makeReport({ final_output: '## Summary\nDone\n\n## Status\ncompleted' });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('false when no completion signal', () => {
    const report = makeReport({ summary: 'Run failed (exit code: 1)' });
    expect(isWPCompleted(report)).toBe(false);
  });

  it('false for null report', () => {
    expect(isWPCompleted(null)).toBe(false);
  });
});

describe('detectHardBlocker', () => {
  it('detects permission denied', () => {
    const report = makeReport({ summary: 'Permission denied when writing to /etc/config' });
    const result = detectHardBlocker(report);
    expect(result).not.toBeNull();
    expect(result!.isHard).toBe(true);
    expect(result!.detail).toBe('Permission denied');
  });

  it('detects destructive action', () => {
    const report = makeReport({ final_output: 'This requires a destructive action on the database' });
    const result = detectHardBlocker(report);
    expect(result!.isHard).toBe(true);
  });

  it('returns null when no hard blocker', () => {
    const report = makeReport({ summary: 'Run completed' });
    expect(detectHardBlocker(report)).toBeNull();
  });

  it('returns null for null report', () => {
    expect(detectHardBlocker(null)).toBeNull();
  });
});
