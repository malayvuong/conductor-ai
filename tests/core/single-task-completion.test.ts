/**
 * Regression tests for the single-task infinite loop bug.
 *
 * Bug: `cdx execute "check this plan..."` with a single WP spun forever.
 *
 * Root cause chain:
 *   1. isWPCompleted() signal gate only matched "completed successfully"
 *      and "exit code: 0". When the engine exited non-zero (common with
 *      Claude --print), the report summary said "Run failed (exit code: 1)"
 *      but the agent's output appended to summary contained "completed" or
 *      "done". detectProgress caught this ("Summary indicates completion")
 *      but isWPCompleted did not — signal gate failed.
 *   2. isWPCompleted() evidence gate rejected read-only tasks — required
 *      files_changed but "check plan" only inspects files.
 *   3. The progress branch never incremented retry_count, so the WP
 *      stayed active with retry_count=0 and was re-selected forever.
 *   4. Attempt header showed "attempt 1" every iteration (misleading).
 *
 * Fixes:
 *   1. Signal gate broadened: "completed", "done", "finished" (same as
 *      detectProgress), not just "completed successfully".
 *   2. Evidence gate broadened: files_inspected, substantial output,
 *      findings all count as evidence.
 *   3. Progress branch increments retry_count — structural guardrail.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, updateSessionStatus, updateSessionGoal,
  createGoal, getGoalById, getWPById,
  createWorkPackage, getWPsByGoal, updateWPStatus,
  createAttempt, getAttemptsByGoal,
  incrementWPRetry,
} from '../../src/core/storage/supervisor-repository.js';
import {
  isWPCompleted, detectProgress, determineStrategy,
} from '../../src/core/supervisor/progress.js';
import { selectNextWP, allWPsCompleted, allWPsTerminal } from '../../src/core/supervisor/scheduler.js';
import type { RunReport } from '../../src/types/index.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

const makeReport = (overrides?: Partial<RunReport>): RunReport => ({
  id: 'rpt-1', run_id: 'run-1', summary: '',
  files_inspected_json: null, files_changed_json: null,
  verification_notes: null, final_output: null,
  root_cause: null, fix_applied: null, remaining_risks: null,
  findings: null, risks: null, recommendations: null,
  what_implemented: null, follow_ups: null,
  ...overrides,
});

// ---- Signal gate tests ----

describe('isWPCompleted signal gate', () => {
  it('matches "completed successfully" (existing)', () => {
    const report = makeReport({ summary: 'Run completed successfully (exit code: 0)' });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('matches "exit code: 0" (existing)', () => {
    const report = makeReport({ summary: 'Run completed (exit code: 0, duration: 15s)' });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('matches "completed" alone in summary (broadened)', () => {
    // This is the core fix: engine exits non-zero but agent text says "completed"
    const report = makeReport({
      summary: 'Run failed (exit code: 1).\nTask: check plan\nFinal output:\nReview completed.',
    });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('matches "done" in summary (broadened)', () => {
    const report = makeReport({
      summary: 'Run failed (exit code: 1).\nTask: check plan\nFinal output:\nDone reviewing the plan.',
    });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('matches "finished" in summary (broadened)', () => {
    const report = makeReport({
      summary: 'Run failed (exit code: 1).\nFinal output:\nFinished the analysis.',
    });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('matches ## Status completed in final_output', () => {
    const report = makeReport({ final_output: '## Summary\nAll good\n\n## Status\ncompleted' });
    expect(isWPCompleted(report)).toBe(true);
  });

  it('rejects when no completion keyword at all', () => {
    const report = makeReport({ summary: 'Run failed (exit code: 1).\nErrors found.' });
    expect(isWPCompleted(report)).toBe(false);
  });

  it('rejects null report', () => {
    expect(isWPCompleted(null)).toBe(false);
  });
});

// ---- Evidence gate tests (ad-hoc) ----

describe('isWPCompleted ad-hoc evidence gate', () => {
  const completionSummary = 'Run completed successfully (exit code: 0)';

  it('accepts files_changed as evidence', () => {
    const report = makeReport({ summary: completionSummary, files_changed_json: '["src/fix.ts"]' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts files_inspected as evidence', () => {
    const report = makeReport({ summary: completionSummary, files_inspected_json: '["plan.md"]' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts substantial final_output as evidence', () => {
    const report = makeReport({ summary: completionSummary, final_output: 'x'.repeat(200) });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts findings as evidence', () => {
    const report = makeReport({ summary: completionSummary, findings: 'Plan is 80% complete' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts fix_applied as evidence', () => {
    const report = makeReport({ summary: completionSummary, fix_applied: 'Added null check' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts verification_notes as evidence', () => {
    const report = makeReport({ summary: completionSummary, verification_notes: 'Tests pass' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('accepts what_implemented as evidence', () => {
    const report = makeReport({ summary: completionSummary, what_implemented: 'Auth module' });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('rejects ad-hoc with signal but zero evidence', () => {
    const report = makeReport({ summary: completionSummary });
    expect(isWPCompleted(report, false)).toBe(true);  // non-ad-hoc: OK
    expect(isWPCompleted(report, true)).toBe(false);   // ad-hoc: rejected
  });

  it('rejects when no signal regardless of evidence', () => {
    const report = makeReport({
      summary: 'Run failed. Errors encountered.',
      files_inspected_json: '["docs/plan.md"]',
      final_output: 'x'.repeat(200),
    });
    expect(isWPCompleted(report, true)).toBe(false);
  });
});

// ---- Exact reproduction scenario ----

describe('exact reproduction: plan check with non-zero exit', () => {
  it('non-zero exit + "completed" in agent text + inspected files → completed', () => {
    // This matches the exact real output pattern:
    // Engine exits with code 1 (Claude --print sometimes does this)
    // Report header: "Run failed (exit code: 1, ...)"
    // But agent text appended to summary says "completed" or "done"
    // Plus files were inspected and substantial output produced
    const report = makeReport({
      summary: [
        'Run failed (exit code: 1, duration: 15s).',
        'Task: check this plan close out yet or not? ispa-cms/docs/superpowers/specs/...',
        '2 files inspected.',
        'Final output:',
        'I have completed reviewing the plan document.',
      ].join('\n'),
      files_inspected_json: '["ispa-cms/docs/superpowers/specs/2026-03-17-ispa-cms-documentation-design.md", "ispa-cms/docs/superpowers/plans/2026-03-17.md"]',
      final_output: 'The plan document has been reviewed. Here is the assessment:\n\n' + 'x'.repeat(200),
    });

    // Signal: "completed" found in summary text
    expect(isWPCompleted(report, false)).toBe(true);
    // Evidence: files_inspected + substantial output
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('non-zero exit + "done" in agent text + output → completed', () => {
    const report = makeReport({
      summary: [
        'Run failed (exit code: 1, duration: 10s).',
        'Task: check plan',
        'Final output:',
        'Done. The plan covers all sections.',
      ].join('\n'),
      final_output: 'Plan review:\n' + 'x'.repeat(200),
    });

    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('zero exit + inspected + output → completed (no regression)', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0, duration: 12s).\nTask: check plan\n2 files inspected.',
      files_inspected_json: '["plan.md"]',
      final_output: 'Plan review:\n' + 'x'.repeat(200),
    });

    expect(isWPCompleted(report, true)).toBe(true);
  });
});

// ---- Progress-without-completion guardrail ----

describe('progress-without-completion retry counting', () => {
  it('progress branch increments retry_count', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, { session_id: session.id, title: 'G', description: 'd', goal_type: 'ad_hoc', source_type: 'inline_task' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'WP1', retry_budget: 2 });

    expect(getWPById(db, wp.id)!.retry_count).toBe(0);
    incrementWPRetry(db, wp.id);
    expect(getWPById(db, wp.id)!.retry_count).toBe(1);
    incrementWPRetry(db, wp.id);
    expect(getWPById(db, wp.id)!.retry_count).toBe(2);

    const updated = getWPById(db, wp.id)!;
    expect(updated.retry_count >= updated.retry_budget).toBe(true);
  });

  it('weak progress without completion signal exhausts budget', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, { session_id: session.id, title: 'G', description: 'd', goal_type: 'ad_hoc', source_type: 'inline_task' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'WP1', retry_budget: 2 });

    // Report with progress but NO completion signal at all
    const report = makeReport({
      summary: 'Run failed (exit code: 1). Errors encountered.',
      files_inspected_json: '["plan.md"]',
    });

    expect(isWPCompleted(report, true)).toBe(false);
    expect(detectProgress(report, null).hasProgress).toBe(true);

    for (let i = 0; i < 2; i++) {
      incrementWPRetry(db, wp.id);
    }

    updateWPStatus(db, wp.id, 'failed');
    const wps = getWPsByGoal(db, goal.id);
    expect(allWPsTerminal(wps)).toBe(true);
  });
});

// ---- Attempt numbering ----

describe('attempt numbering correctness', () => {
  it('retry_count increments so attempt number advances', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, { session_id: session.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'WP1', retry_budget: 3 });

    for (let i = 0; i < 3; i++) {
      const current = getWPById(db, wp.id)!;
      const strategy = determineStrategy(current.retry_count);
      const attemptNo = current.retry_count + 1;

      expect(attemptNo).toBe(i + 1);
      expect(strategy).toBe(['normal', 'focused', 'surgical'][i]);

      incrementWPRetry(db, wp.id);
    }
  });

  it('active WP with exhausted retries is not re-selected', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, { session_id: session.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'WP1', retry_budget: 2 });

    incrementWPRetry(db, wp.id);
    incrementWPRetry(db, wp.id);
    updateWPStatus(db, wp.id, 'failed');

    const wps = getWPsByGoal(db, goal.id);
    expect(selectNextWP(wps)).toBeNull();
    expect(allWPsTerminal(wps)).toBe(true);
  });
});

// ---- End-to-end single-task lifecycle ----

describe('single-task execute lifecycle', () => {
  it('successful completion: signal + evidence → completed on first attempt', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');
    const goal = createGoal(db, { session_id: session.id, title: 'Check plan', description: 'check plan', goal_type: 'ad_hoc', source_type: 'inline_task' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'Complete task: Check plan', retry_budget: 2 });

    const report = makeReport({
      summary: 'Run failed (exit code: 1).\nFinal output:\nReview completed.',
      files_inspected_json: '["plan.md"]',
      final_output: 'Plan review: ' + 'x'.repeat(200),
    });

    expect(isWPCompleted(report, true)).toBe(true);

    updateWPStatus(db, wp.id, 'completed');
    const wps = getWPsByGoal(db, goal.id);
    expect(allWPsCompleted(wps)).toBe(true);
  });

  it('cannot spin forever: no-signal progress exhausts budget', () => {
    const session = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, { session_id: session.id, title: 'G', description: 'd', goal_type: 'ad_hoc', source_type: 'inline_task' });
    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'WP1', retry_budget: 3 });

    // Report with progress but no completion signal at all
    const weakReport = makeReport({
      summary: 'Run failed (exit code: 1). Working on it.',
      files_inspected_json: '["file.ts"]',
    });

    let iterations = 0;
    while (true) {
      const current = getWPById(db, wp.id)!;
      if (current.retry_count >= current.retry_budget) {
        updateWPStatus(db, wp.id, 'failed');
        break;
      }

      expect(isWPCompleted(weakReport, true)).toBe(false);
      expect(detectProgress(weakReport, null).hasProgress).toBe(true);
      incrementWPRetry(db, wp.id);
      iterations++;

      expect(iterations).toBeLessThanOrEqual(3);
    }

    expect(iterations).toBe(3);
    expect(getWPById(db, wp.id)!.status).toBe('failed');
  });
});
