/**
 * Real-world scenario validation tests.
 *
 * These tests validate the complete flow through the data layer
 * for the 4 critical scenarios identified for daily use.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, getSessionById, getSessionByName, getActiveSession,
  updateSessionStatus, updateSessionGoal,
  createGoal, getGoalById, getGoalsBySession, updateGoalStatus, updateGoalCloseout,
  createWorkPackage, getWPsByGoal, updateWPStatus,
  createSnapshot, getLatestSnapshot, getSnapshotsByGoal,
  createAttempt, getAttemptsByGoal, updateAttemptFinished,
} from '../../src/core/storage/supervisor-repository.js';
import { buildCloseoutSummary } from '../../src/core/supervisor/closeout.js';
import { extractDecisionsFromReport } from '../../src/core/supervisor/compactor.js';
import { selectNextWP, allWPsCompleted, allWPsTerminal } from '../../src/core/supervisor/scheduler.js';
import { isWPCompleted, detectProgress } from '../../src/core/supervisor/progress.js';
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

// ====================================================================
// Scenario A: Plan happy path
// ====================================================================
describe('Scenario A — plan happy path', () => {
  it('full lifecycle: session → goal → WPs → complete', () => {
    // 1. Start session
    const session = createSession(db, { name: 'cms-management', project_path: '/project', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');

    // 2. Create goal from plan (simulating what execute does)
    const goal = createGoal(db, {
      session_id: session.id,
      title: 'CMS Implementation',
      description: 'Build the CMS module',
      goal_type: 'execute_plan',
      source_type: 'plan_file',
      source_file: '/docs/plan.md',
    });
    updateSessionGoal(db, session.id, goal.id);
    updateGoalStatus(db, goal.id, 'active');

    // 3. Create WPs from plan
    const wp1 = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'Scan structure' });
    const wp2 = createWorkPackage(db, { goal_id: goal.id, seq: 2, title: 'Implement API' });
    const wp3 = createWorkPackage(db, { goal_id: goal.id, seq: 3, title: 'Write tests' });

    // 4. Execute WP1 → completed
    updateWPStatus(db, wp1.id, 'active');
    createAttempt(db, { session_id: session.id, goal_id: goal.id, wp_id: wp1.id, attempt_no: 1, prompt_strategy: 'normal' });
    updateWPStatus(db, wp1.id, 'completed');

    // 5. Execute WP2 → completed
    updateWPStatus(db, wp2.id, 'active');
    createAttempt(db, { session_id: session.id, goal_id: goal.id, wp_id: wp2.id, attempt_no: 1, prompt_strategy: 'normal' });
    updateWPStatus(db, wp2.id, 'completed');

    // 6. Execute WP3 → completed
    updateWPStatus(db, wp3.id, 'active');
    createAttempt(db, { session_id: session.id, goal_id: goal.id, wp_id: wp3.id, attempt_no: 1, prompt_strategy: 'normal' });
    updateWPStatus(db, wp3.id, 'completed');

    // 7. Check final state
    const wps = getWPsByGoal(db, goal.id);
    expect(allWPsCompleted(wps)).toBe(true);

    updateGoalStatus(db, goal.id, 'completed');
    updateSessionStatus(db, session.id, 'completed');

    // 8. Verify history is clean
    const finalGoal = getGoalById(db, goal.id)!;
    expect(finalGoal.status).toBe('completed');
    expect(finalGoal.source_type).toBe('plan_file');
    expect(finalGoal.source_file).toBe('/docs/plan.md');

    const attempts = getAttemptsByGoal(db, goal.id);
    expect(attempts).toHaveLength(3);

    const goals = getGoalsBySession(db, session.id);
    expect(goals).toHaveLength(1);
  });
});

// ====================================================================
// Scenario B: No-plan happy path
// ====================================================================
describe('Scenario B — no-plan happy path', () => {
  it('ad-hoc task: session → inline goal → single WP → complete', () => {
    // 1. Session already exists
    const session = createSession(db, { name: 'daily-work', project_path: '/project', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');

    // 2. Create ad-hoc goal (what execute "text" does)
    const goal = createGoal(db, {
      session_id: session.id,
      title: 'fix bug login API 500 error',
      description: 'fix bug login API 500 error',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    updateSessionGoal(db, session.id, goal.id);
    updateGoalStatus(db, goal.id, 'active');

    const wp = createWorkPackage(db, {
      goal_id: goal.id, seq: 1,
      title: 'Complete task: fix bug login API 500 error',
      description: 'fix bug login API 500 error',
      retry_budget: 2,
    });

    // 3. First attempt — has progress but not complete
    updateWPStatus(db, wp.id, 'active');
    const a1 = createAttempt(db, { session_id: session.id, goal_id: goal.id, wp_id: wp.id, attempt_no: 1, prompt_strategy: 'normal' });

    const report1 = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      files_changed_json: '["src/auth.ts"]',
      fix_applied: 'Added error handling for null user',
    });

    // Ad-hoc requires evidence for completion
    expect(isWPCompleted(report1, true)).toBe(true);

    updateWPStatus(db, wp.id, 'completed');
    updateGoalStatus(db, goal.id, 'completed');

    // 4. Verify
    const finalGoal = getGoalById(db, goal.id)!;
    expect(finalGoal.status).toBe('completed');
    expect(finalGoal.source_type).toBe('inline_task');
    expect(finalGoal.source_file).toBeNull();
  });

  it('ad-hoc task: completion without evidence is rejected', () => {
    const report = makeReport({
      summary: 'Run completed successfully (exit code: 0)',
      // No files_changed, no fix_applied, no verification
    });
    expect(isWPCompleted(report, true)).toBe(false);
    expect(isWPCompleted(report, false)).toBe(true); // plan mode would accept
  });
});

// ====================================================================
// Scenario C: Interrupted resume
// ====================================================================
describe('Scenario C — interrupted resume', () => {
  it('pause and resume preserves state correctly', () => {
    const session = createSession(db, { name: 'long-task', project_path: '/project', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');

    const goal = createGoal(db, {
      session_id: session.id,
      title: 'Big refactor',
      description: 'Refactor entire module',
      goal_type: 'execute_plan',
      source_type: 'plan_file',
    });
    updateSessionGoal(db, session.id, goal.id);
    updateGoalStatus(db, goal.id, 'active');

    const wp1 = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'Phase 1' });
    const wp2 = createWorkPackage(db, { goal_id: goal.id, seq: 2, title: 'Phase 2' });

    // Complete WP1
    updateWPStatus(db, wp1.id, 'completed');
    createAttempt(db, { session_id: session.id, goal_id: goal.id, wp_id: wp1.id, attempt_no: 1 });

    // Create snapshot
    createSnapshot(db, {
      session_id: session.id, goal_id: goal.id,
      trigger: 'run_completed', summary: '1/2 done',
      next_action: 'Start Phase 2',
    });

    // === INTERRUPT ===
    updateGoalStatus(db, goal.id, 'paused');
    updateSessionStatus(db, session.id, 'paused');

    // Verify paused state
    const pausedGoal = getGoalById(db, goal.id)!;
    expect(pausedGoal.status).toBe('paused');

    const pausedSession = getSessionById(db, session.id)!;
    expect(pausedSession.status).toBe('paused');

    // === RESUME ===
    // Resolve session — paused sessions are found as fallback
    const activeSession = getActiveSession(db);
    expect(activeSession).toBeDefined();
    expect(activeSession!.status).toBe('paused');

    // User runs: cdx execute --until-done → session auto-reactivated
    updateSessionStatus(db, session.id, 'active');
    updateGoalStatus(db, goal.id, 'active');

    // Verify resume state
    const resumedGoal = getGoalById(db, goal.id)!;
    expect(resumedGoal.status).toBe('active');
    expect(resumedGoal.id).toBe(goal.id); // same goal, not new

    // Snapshot chain intact
    const snap = getLatestSnapshot(db, goal.id);
    expect(snap).toBeDefined();
    expect(snap!.next_action).toBe('Start Phase 2');

    // WP1 still completed, WP2 still pending
    const wps = getWPsByGoal(db, goal.id);
    expect(wps[0].status).toBe('completed');
    expect(wps[1].status).toBe('pending');

    // Scheduler picks WP2
    const next = selectNextWP(wps);
    expect(next!.id).toBe(wp2.id);
  });
});

// ====================================================================
// Scenario D: Switch task mid-execution
// ====================================================================
describe('Scenario D — switch task mid-execution', () => {
  it('auto-pause old goal when starting new one', () => {
    const session = createSession(db, { name: 'daily-work', project_path: '/project', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');

    // Goal A — in progress
    const goalA = createGoal(db, {
      session_id: session.id,
      title: 'Refactor auth module',
      description: 'Refactor auth',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    updateSessionGoal(db, session.id, goalA.id);
    updateGoalStatus(db, goalA.id, 'active');

    const wpA = createWorkPackage(db, { goal_id: goalA.id, seq: 1, title: 'Refactor auth' });
    updateWPStatus(db, wpA.id, 'active');

    // === USER SWITCHES TASK ===
    // Simulate what execute.ts does: pause old goal, create new

    // Check: old goal is unfinished → pause it
    const oldGoal = getGoalById(db, goalA.id)!;
    expect(['created', 'active', 'paused'].includes(oldGoal.status)).toBe(true);
    updateGoalStatus(db, goalA.id, 'paused');

    // Create new goal B
    const goalB = createGoal(db, {
      session_id: session.id,
      title: 'Fix urgent login bug',
      description: 'Fix login bug',
      goal_type: 'ad_hoc',
      source_type: 'inline_task',
    });
    updateSessionGoal(db, session.id, goalB.id);
    updateGoalStatus(db, goalB.id, 'active');

    // === VERIFY STATE ===
    const updatedSession = getSessionById(db, session.id)!;
    expect(updatedSession.active_goal_id).toBe(goalB.id);

    const pausedA = getGoalById(db, goalA.id)!;
    expect(pausedA.status).toBe('paused');

    const activeB = getGoalById(db, goalB.id)!;
    expect(activeB.status).toBe('active');

    // History shows both goals
    const goals = getGoalsBySession(db, session.id);
    expect(goals).toHaveLength(2);
    expect(goals[0].title).toBe('Refactor auth module');
    expect(goals[1].title).toBe('Fix urgent login bug');
  });

  it('paused goal can be resumed later', () => {
    const session = createSession(db, { name: 'daily', project_path: '/project', engine: 'claude' });
    updateSessionStatus(db, session.id, 'active');

    // Goal A paused
    const goalA = createGoal(db, {
      session_id: session.id, title: 'Task A', description: 'A',
      source_type: 'inline_task', goal_type: 'ad_hoc',
    });
    updateGoalStatus(db, goalA.id, 'paused');
    const wpA = createWorkPackage(db, { goal_id: goalA.id, seq: 1, title: 'WP A' });

    // Goal B completed
    const goalB = createGoal(db, {
      session_id: session.id, title: 'Task B', description: 'B',
      source_type: 'inline_task', goal_type: 'ad_hoc',
    });
    updateGoalStatus(db, goalB.id, 'completed');

    // Now resume A
    updateSessionGoal(db, session.id, goalA.id);
    updateGoalStatus(db, goalA.id, 'active');

    const resumed = getGoalById(db, goalA.id)!;
    expect(resumed.status).toBe('active');

    // WP still pending, ready to execute
    const wps = getWPsByGoal(db, goalA.id);
    expect(wps[0].status).toBe('pending');
    expect(selectNextWP(wps)!.id).toBe(wpA.id);
  });
});

// ====================================================================
// Closeout summary
// ====================================================================
describe('closeout summary', () => {
  it('generates structured closeout on completion', () => {
    const session = createSession(db, { name: 'test', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, {
      session_id: session.id, title: 'Fix login', description: 'fix login bug',
      goal_type: 'ad_hoc', source_type: 'inline_task',
    });
    updateGoalStatus(db, goal.id, 'completed');

    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'Fix it' });
    updateWPStatus(db, wp.id, 'completed');

    const attempt = createAttempt(db, {
      session_id: session.id, goal_id: goal.id, wp_id: wp.id, attempt_no: 1,
    });
    updateAttemptFinished(db, attempt.id, 'completed', true, 2, 1, 'Fixed auth.ts');

    const snap = createSnapshot(db, {
      session_id: session.id, goal_id: goal.id,
      trigger: 'run_completed', summary: 'Fixed login bug',
      next_action: 'Done',
      related_files: '["src/auth.ts", "tests/auth.test.ts"]',
      decisions: '[{"decision": "Used JWT instead of session cookies"}]',
    });

    const updatedGoal = getGoalById(db, goal.id)!;
    const closeout = buildCloseoutSummary({
      goal: updatedGoal,
      wps: getWPsByGoal(db, goal.id),
      attempts: getAttemptsByGoal(db, goal.id),
      snapshots: getSnapshotsByGoal(db, goal.id),
      totalCost: 0.52,
    });

    expect(closeout.source).toBe('inline_task');
    expect(closeout.final_status).toBe('completed');
    expect(closeout.wps_completed).toBe(1);
    expect(closeout.wps_total).toBe(1);
    expect(closeout.attempts_total).toBe(1);
    expect(closeout.files_touched).toContain('src/auth.ts');
    expect(closeout.key_decisions).toHaveLength(1);
    expect(closeout.key_decisions[0]).toBe('Used JWT instead of session cookies');
    expect(closeout.total_cost_usd).toBe(0.52);
    expect(closeout.next_recommended_action).toBeNull(); // completed → no next action
  });

  it('generates closeout with next action for failed goal', () => {
    const session = createSession(db, { name: 'test', project_path: '/tmp', engine: 'claude' });
    const goal = createGoal(db, {
      session_id: session.id, title: 'Deploy', description: 'deploy to prod',
      goal_type: 'ad_hoc', source_type: 'inline_task',
    });
    updateGoalStatus(db, goal.id, 'failed');

    const wp = createWorkPackage(db, { goal_id: goal.id, seq: 1, title: 'Deploy it' });
    updateWPStatus(db, wp.id, 'failed');

    const closeout = buildCloseoutSummary({
      goal: getGoalById(db, goal.id)!,
      wps: getWPsByGoal(db, goal.id),
      attempts: [], snapshots: [], totalCost: 0,
    });

    expect(closeout.final_status).toBe('failed');
    expect(closeout.next_recommended_action).toContain('Deploy it');
  });
});

// ====================================================================
// Decision extraction
// ====================================================================
describe('decision extraction from reports', () => {
  it('extracts decisions from ## Decisions section', () => {
    const report = makeReport({
      final_output: '## Summary\nDone.\n\n## Decisions\n- Used PostgreSQL instead of MySQL\n- Chose JWT for auth\n\n## Status\ncompleted',
    });
    const decisions = extractDecisionsFromReport(report);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].decision).toBe('Used PostgreSQL instead of MySQL');
    expect(decisions[1].decision).toBe('Chose JWT for auth');
  });

  it('extracts "decided to" patterns', () => {
    const report = makeReport({
      summary: 'We decided to use Redis for caching instead of in-memory.',
    });
    const decisions = extractDecisionsFromReport(report);
    expect(decisions.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty for report without decisions', () => {
    const report = makeReport({ summary: 'Run completed.' });
    const decisions = extractDecisionsFromReport(report);
    expect(decisions).toHaveLength(0);
  });

  it('returns empty for null report', () => {
    expect(extractDecisionsFromReport(null)).toHaveLength(0);
  });
});
