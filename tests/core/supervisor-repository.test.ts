import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, getSessionById, getSessionByName, getActiveSession, listSessions, updateSessionStatus, updateSessionGoal, updateSessionSummary,
  createGoal, getGoalById, getGoalsBySession, updateGoalStatus, listGoals,
  createWorkPackage, getWPById, getWPsByGoal, updateWPStatus, incrementWPRetry, updateWPBlocker, updateWPProgress,
  createSnapshot, getSnapshotById, getLatestSnapshot, getSnapshotsByGoal,
  createAttempt, getAttemptById, getAttemptsByGoal, getAttemptsByWP, updateAttemptFinished, updateAttemptRunId,
} from '../../src/core/storage/supervisor-repository.js';
import { createTask, createRun } from '../../src/core/storage/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ---- Sessions ----

describe('sessions', () => {
  it('creates and retrieves a session', () => {
    const session = createSession(db, { name: 'Test Session', project_path: '/tmp/project', engine: 'claude' });
    expect(session.id).toBeDefined();
    expect(session.name).toBe('Test Session');
    expect(session.title).toBe('Test Session');
    expect(session.status).toBe('created');
    expect(session.engine).toBe('claude');

    const fetched = getSessionById(db, session.id);
    expect(fetched!.id).toBe(session.id);
  });

  it('lists sessions', () => {
    createSession(db, { name: 'S1', project_path: '/tmp', engine: 'claude' });
    createSession(db, { name: 'S2', project_path: '/tmp', engine: 'codex' });
    expect(listSessions(db)).toHaveLength(2);
  });

  it('filters sessions by status', () => {
    const s = createSession(db, { name: 'S1', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'active');
    createSession(db, { name: 'S2', project_path: '/tmp', engine: 'claude' });

    expect(listSessions(db, { status: 'active' })).toHaveLength(1);
    expect(listSessions(db, { status: 'created' })).toHaveLength(1);
  });

  it('updates session goal and summary', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    updateSessionGoal(db, s.id, 'goal-123');
    updateSessionSummary(db, s.id, '3/5 WPs done');

    const updated = getSessionById(db, s.id)!;
    expect(updated.active_goal_id).toBe('goal-123');
    expect(updated.working_summary).toBe('3/5 WPs done');
  });

  it('finds session by name', () => {
    createSession(db, { name: 'cms-management', project_path: '/tmp', engine: 'claude' });
    createSession(db, { name: 'api-refactor', project_path: '/tmp', engine: 'codex' });

    const found = getSessionByName(db, 'cms-management');
    expect(found).toBeDefined();
    expect(found!.name).toBe('cms-management');
    expect(found!.engine).toBe('claude');

    expect(getSessionByName(db, 'nonexistent')).toBeUndefined();
  });

  it('gets active session (most recent active/created)', () => {
    const s1 = createSession(db, { name: 's1', project_path: '/tmp', engine: 'claude' });
    const s2 = createSession(db, { name: 's2', project_path: '/tmp', engine: 'codex' });
    updateSessionStatus(db, s1.id, 'completed');

    // s2 is still 'created' → should be returned
    const active = getActiveSession(db);
    expect(active).toBeDefined();
    expect(active!.name).toBe('s2');
  });

  it('returns undefined when no active session', () => {
    const s = createSession(db, { name: 's1', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'completed');

    expect(getActiveSession(db)).toBeUndefined();
  });

  it('falls back to paused session when no active', () => {
    const s = createSession(db, { name: 's1', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'paused');

    const active = getActiveSession(db);
    expect(active).toBeDefined();
    expect(active!.status).toBe('paused');
  });

  it('uses name as default title', () => {
    const s = createSession(db, { name: 'my-session', project_path: '/tmp', engine: 'claude' });
    expect(s.name).toBe('my-session');
    expect(s.title).toBe('my-session');
  });

  it('allows custom title separate from name', () => {
    const s = createSession(db, { name: 'my-session', title: 'My Custom Title', project_path: '/tmp', engine: 'claude' });
    expect(s.name).toBe('my-session');
    expect(s.title).toBe('My Custom Title');
  });
});

// ---- Goals ----

describe('goals', () => {
  it('creates and retrieves a goal', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'Implement CMS', description: 'Full CMS implementation' });

    expect(g.id).toBeDefined();
    expect(g.title).toBe('Implement CMS');
    expect(g.status).toBe('created');

    const fetched = getGoalById(db, g.id);
    expect(fetched!.description).toBe('Full CMS implementation');
  });

  it('lists goals by session', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    createGoal(db, { session_id: s.id, title: 'G1', description: 'd1' });
    createGoal(db, { session_id: s.id, title: 'G2', description: 'd2' });

    expect(getGoalsBySession(db, s.id)).toHaveLength(2);
  });

  it('updates goal status', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    updateGoalStatus(db, g.id, 'completed');

    expect(getGoalById(db, g.id)!.status).toBe('completed');
  });

  it('lists all goals with filter', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g1 = createGoal(db, { session_id: s.id, title: 'G1', description: 'd1' });
    createGoal(db, { session_id: s.id, title: 'G2', description: 'd2' });
    updateGoalStatus(db, g1.id, 'completed');

    expect(listGoals(db)).toHaveLength(2);
    expect(listGoals(db, { status: 'completed' })).toHaveLength(1);
  });
});

// ---- Work Packages ----

describe('work packages', () => {
  it('creates and retrieves WPs', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'Scan structure' });

    expect(wp.id).toBeDefined();
    expect(wp.title).toBe('Scan structure');
    expect(wp.status).toBe('pending');
    expect(wp.retry_count).toBe(0);
    expect(wp.retry_budget).toBe(3);
  });

  it('lists WPs by goal in order', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    createWorkPackage(db, { goal_id: g.id, seq: 2, title: 'WP2' });
    createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    const wps = getWPsByGoal(db, g.id);
    expect(wps).toHaveLength(2);
    expect(wps[0].title).toBe('WP1'); // sorted by seq
    expect(wps[1].title).toBe('WP2');
  });

  it('updates WP status', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    updateWPStatus(db, wp.id, 'active');
    expect(getWPById(db, wp.id)!.status).toBe('active');

    updateWPStatus(db, wp.id, 'completed');
    expect(getWPById(db, wp.id)!.status).toBe('completed');
  });

  it('increments retry count', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    incrementWPRetry(db, wp.id);
    expect(getWPById(db, wp.id)!.retry_count).toBe(1);

    incrementWPRetry(db, wp.id);
    expect(getWPById(db, wp.id)!.retry_count).toBe(2);
  });

  it('updates WP blocker', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    updateWPBlocker(db, wp.id, 'hard', 'Missing critical file');
    const updated = getWPById(db, wp.id)!;
    expect(updated.blocker_type).toBe('hard');
    expect(updated.blocker_detail).toBe('Missing critical file');
  });

  it('updates WP progress timestamp', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    expect(getWPById(db, wp.id)!.last_progress_at).toBeNull();
    updateWPProgress(db, wp.id);
    expect(getWPById(db, wp.id)!.last_progress_at).not.toBeNull();
  });
});

// ---- Snapshots ----

describe('snapshots', () => {
  it('creates and retrieves a snapshot', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const snap = createSnapshot(db, {
      session_id: s.id, goal_id: g.id, trigger: 'run_completed',
      summary: '1/3 done', next_action: 'Start WP2',
    });

    expect(snap.id).toBeDefined();
    expect(snap.summary).toBe('1/3 done');
    expect(snap.next_action).toBe('Start WP2');
  });

  it('gets latest snapshot', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    createSnapshot(db, { session_id: s.id, goal_id: g.id, trigger: 'run_completed', summary: 'first', next_action: 'a' });
    createSnapshot(db, { session_id: s.id, goal_id: g.id, trigger: 'run_completed', summary: 'second', next_action: 'b' });

    const latest = getLatestSnapshot(db, g.id);
    expect(latest!.summary).toBe('second');
  });

  it('lists all snapshots for a goal', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    createSnapshot(db, { session_id: s.id, goal_id: g.id, trigger: 'run_completed', summary: 's1', next_action: 'a' });
    createSnapshot(db, { session_id: s.id, goal_id: g.id, trigger: 'run_failed', summary: 's2', next_action: 'b' });

    expect(getSnapshotsByGoal(db, g.id)).toHaveLength(2);
  });
});

// ---- Execution Attempts ----

describe('execution attempts', () => {
  it('creates and retrieves an attempt', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const a = createAttempt(db, {
      session_id: s.id, goal_id: g.id, attempt_no: 1, prompt_strategy: 'normal',
    });

    expect(a.id).toBeDefined();
    expect(a.status).toBe('running');
    expect(a.prompt_strategy).toBe('normal');
    expect(a.progress_detected).toBe(0);
  });

  it('updates attempt when finished', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const a = createAttempt(db, { session_id: s.id, goal_id: g.id, attempt_no: 1 });

    updateAttemptFinished(db, a.id, 'completed', true, 3, 1, '3 files changed');
    const updated = getAttemptById(db, a.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.progress_detected).toBe(1);
    expect(updated.files_changed_count).toBe(3);
    expect(updated.notes).toBe('3 files changed');
    expect(updated.ended_at).not.toBeNull();
  });

  it('lists attempts by goal and WP', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });

    createAttempt(db, { session_id: s.id, goal_id: g.id, wp_id: wp.id, attempt_no: 1 });
    createAttempt(db, { session_id: s.id, goal_id: g.id, wp_id: wp.id, attempt_no: 2 });

    expect(getAttemptsByGoal(db, g.id)).toHaveLength(2);
    expect(getAttemptsByWP(db, wp.id)).toHaveLength(2);
  });

  it('links attempt to run', () => {
    const s = createSession(db, { name: 'S', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const a = createAttempt(db, { session_id: s.id, goal_id: g.id, attempt_no: 1 });

    // Create a real run to satisfy foreign key
    const task = createTask(db, { raw_input: 'test', workspace_path: '/tmp', engine: 'claude' });
    const run = createRun(db, { task_id: task.id, engine: 'claude', command: 'claude', args_json: '[]', prompt_final: 'p' });

    updateAttemptRunId(db, a.id, run.id);
    expect(getAttemptById(db, a.id)!.run_id).toBe(run.id);
  });
});
