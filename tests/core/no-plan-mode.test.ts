import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, createGoal, createWorkPackage, getGoalById,
} from '../../src/core/storage/supervisor-repository.js';
import { buildGoalPrompt } from '../../src/core/supervisor/prompt-builder.js';
import { isWPCompleted, detectProgress } from '../../src/core/supervisor/progress.js';
import { createSingleWPPlan } from '../../src/core/supervisor/plan-parser.js';
import type Database from 'better-sqlite3';
import type { RunReport } from '../../src/types/index.js';

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

// ---- Goal creation with source_type ----

describe('goal source_type', () => {
  it('creates goal with source_type plan_file', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Implement CMS',
      description: 'Full CMS',
      goal_type: 'execute_plan',
      source_type: 'plan_file',
      source_file: '/docs/plan.md',
    });

    expect(g.source_type).toBe('plan_file');
    expect(g.source_file).toBe('/docs/plan.md');
    expect(g.goal_type).toBe('execute_plan');
  });

  it('creates goal with source_type inline_task', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Fix login bug',
      description: 'fix bug login API 500 error',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });

    expect(g.source_type).toBe('inline_task');
    expect(g.source_file).toBeNull();
    expect(g.goal_type).toBe('ad_hoc');
  });

  it('defaults source_type to null for legacy goals', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Legacy goal',
      description: 'desc',
    });

    expect(g.source_type).toBeNull();
  });
});

// ---- Prompt builder for ad-hoc tasks ----

describe('prompt-builder ad-hoc mode', () => {
  it('includes Task header for inline_task goals', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp/project', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Fix login bug',
      description: 'fix bug login API 500 error',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    const wp = createWorkPackage(db, {
      goal_id: g.id, seq: 1, title: 'Complete task: Fix login bug',
      description: 'fix bug login API 500 error',
    });

    const prompt = buildGoalPrompt({
      session: s, goal: g, wp, snapshot: null,
      strategy: 'normal', allWPs: [wp],
    });

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('direct task (no plan file)');
    expect(prompt).toContain('Do NOT claim completion without evidence');
    expect(prompt).not.toContain('## Goal');
  });

  it('includes Goal header for plan_file goals', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp/project', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'CMS Implementation',
      description: 'Implement full CMS',
      goal_type: 'execute_plan',
      source_type: 'plan_file',
      source_file: '/docs/plan.md',
    });
    const wp = createWorkPackage(db, {
      goal_id: g.id, seq: 1, title: 'Scan structure',
    });

    const prompt = buildGoalPrompt({
      session: s, goal: g, wp, snapshot: null,
      strategy: 'normal', allWPs: [wp],
    });

    expect(prompt).toContain('## Goal');
    expect(prompt).not.toContain('## Task');
    expect(prompt).not.toContain('direct task');
  });

  it('includes stricter done criteria for ad-hoc', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp/project', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Review module',
      description: 'review education grading flow',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    const wp = createWorkPackage(db, {
      goal_id: g.id, seq: 1, title: 'Complete task',
      description: 'review education grading flow',
    });

    const prompt = buildGoalPrompt({
      session: s, goal: g, wp, snapshot: null,
      strategy: 'normal', allWPs: [wp],
    });

    expect(prompt).toContain('Only report "completed" if you have concrete evidence');
    expect(prompt).toContain('Files were actually changed or created');
  });

  it('does not show remaining WPs for ad-hoc (single WP)', () => {
    const s = createSession(db, { name: 'test', project_path: '/tmp/project', engine: 'claude' });
    const g = createGoal(db, {
      session_id: s.id,
      title: 'Fix',
      description: 'fix it',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    const wp = createWorkPackage(db, {
      goal_id: g.id, seq: 1, title: 'Complete task',
    });

    const prompt = buildGoalPrompt({
      session: s, goal: g, wp, snapshot: null,
      strategy: 'normal', allWPs: [wp],
    });

    expect(prompt).not.toContain('Remaining work packages');
  });
});

// ---- isWPCompleted with requireEvidence ----

describe('isWPCompleted with evidence requirement', () => {
  it('plan mode: completion signal alone is enough', () => {
    const report = makeReport({ summary: 'Run completed successfully (exit code: 0)' });
    expect(isWPCompleted(report, false)).toBe(true);
  });

  it('ad-hoc: completion signal alone is NOT enough', () => {
    const report = makeReport({ summary: 'Run completed successfully (exit code: 0)' });
    expect(isWPCompleted(report, true)).toBe(false);
  });

  it('ad-hoc: completion signal + files_changed = completed', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      files_changed_json: '["src/auth.ts"]',
    });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('ad-hoc: completion signal + fix_applied = completed', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      fix_applied: 'Added null check',
    });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('ad-hoc: completion signal + verification_notes = completed', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      verification_notes: 'All tests pass',
    });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('ad-hoc: completion signal + what_implemented = completed', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      what_implemented: 'Login endpoint error handling',
    });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('ad-hoc: ## Status completed + files = completed', () => {
    const report = makeReport({
      final_output: '## Summary\nDone\n\n## Status\ncompleted',
      files_changed_json: '["src/fix.ts"]',
    });
    expect(isWPCompleted(report, true)).toBe(true);
  });

  it('ad-hoc: ## Status completed alone = NOT completed', () => {
    const report = makeReport({
      final_output: '## Summary\nDone\n\n## Status\ncompleted',
    });
    expect(isWPCompleted(report, true)).toBe(false);
  });

  it('no report = not completed regardless', () => {
    expect(isWPCompleted(null, false)).toBe(false);
    expect(isWPCompleted(null, true)).toBe(false);
  });
});

// ---- createSingleWPPlan for ad-hoc ----

describe('createSingleWPPlan for ad-hoc', () => {
  it('creates single WP from task description', () => {
    const plan = createSingleWPPlan('fix bug login API 500 error');
    expect(plan.workPackages).toHaveLength(1);
    expect(plan.workPackages[0].description).toBe('fix bug login API 500 error');
    expect(plan.title).toBe('fix bug login API 500 error');
  });

  it('truncates long titles to 80 chars', () => {
    const long = 'A'.repeat(100);
    const plan = createSingleWPPlan(long);
    expect(plan.title.length).toBe(80);
    expect(plan.workPackages[0].description).toBe(long);
  });
});
