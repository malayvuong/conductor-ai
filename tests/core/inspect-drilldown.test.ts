import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, createGoal, createWorkPackage, createSnapshot,
  createAttempt, updateAttemptFinished, updateGoalStatus,
  getGoalBySeq, getGoalsBySession, getWPsByGoal, getSnapshotsByGoal, getAttemptsByGoal,
} from '../../src/core/storage/supervisor-repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('getGoalBySeq for inspect', () => {
  it('returns correct goal by seq in multi-goal session', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g1 = createGoal(db, { session_id: s.id, title: 'First Goal', description: 'd1' });
    const g2 = createGoal(db, { session_id: s.id, title: 'Second Goal', description: 'd2' });

    expect(getGoalBySeq(db, s.id, 1)!.id).toBe(g1.id);
    expect(getGoalBySeq(db, s.id, 2)!.id).toBe(g2.id);
  });
});

describe('inspect goal data retrieval', () => {
  it('retrieves WPs, snapshots, and attempts for a goal', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    const wp = createWorkPackage(db, { goal_id: g.id, seq: 1, title: 'WP1' });
    createSnapshot(db, {
      session_id: s.id, goal_id: g.id, trigger: 'run_completed',
      summary: '1/1 done', next_action: 'verify',
      decisions: JSON.stringify([{ decision: 'Use TypeScript' }]),
    });
    const a = createAttempt(db, { session_id: s.id, goal_id: g.id, wp_id: wp.id, attempt_no: 1 });
    updateAttemptFinished(db, a.id, 'completed', true, 2, 1, '2 files changed');

    const wps = getWPsByGoal(db, g.id);
    const snapshots = getSnapshotsByGoal(db, g.id);
    const attempts = getAttemptsByGoal(db, g.id);

    expect(wps).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].files_changed_count).toBe(2);
  });

  it('extracts decisions from snapshots', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    createSnapshot(db, {
      session_id: s.id, goal_id: g.id, trigger: 'run_completed',
      summary: 's1', next_action: 'a',
      decisions: JSON.stringify([{ decision: 'Use PostgreSQL' }]),
    });
    createSnapshot(db, {
      session_id: s.id, goal_id: g.id, trigger: 'run_completed',
      summary: 's2', next_action: 'b',
      decisions: JSON.stringify([{ decision: 'Use PostgreSQL' }, { decision: 'Switch to GraphQL' }]),
    });

    const snapshots = getSnapshotsByGoal(db, g.id);
    expect(snapshots).toHaveLength(2);

    const lastDecisions = JSON.parse(snapshots[1].decisions!);
    expect(lastDecisions).toHaveLength(2);
  });
});
