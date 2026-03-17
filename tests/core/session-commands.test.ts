import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/core/storage/db.js';
import {
  createSession, createGoal, createWorkPackage,
  getSessionById, getGoalById, getGoalsBySession, getGoalBySeq,
  updateSessionStatus, updateGoalStatus, updateSessionGoal,
} from '../../src/core/storage/supervisor-repository.js';
import { pauseCurrentSession, activateSession, resolveSession } from '../../src/cli/commands/session.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('getGoalBySeq', () => {
  it('returns goal by 1-based sequence number', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    createGoal(db, { session_id: s.id, title: 'G1', description: 'd1' });
    createGoal(db, { session_id: s.id, title: 'G2', description: 'd2' });
    createGoal(db, { session_id: s.id, title: 'G3', description: 'd3' });

    expect(getGoalBySeq(db, s.id, 1)!.title).toBe('G1');
    expect(getGoalBySeq(db, s.id, 2)!.title).toBe('G2');
    expect(getGoalBySeq(db, s.id, 3)!.title).toBe('G3');
  });

  it('returns undefined for out of range seq', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    createGoal(db, { session_id: s.id, title: 'G1', description: 'd1' });

    expect(getGoalBySeq(db, s.id, 0)).toBeUndefined();
    expect(getGoalBySeq(db, s.id, 2)).toBeUndefined();
  });
});

describe('pauseCurrentSession', () => {
  it('pauses session and active goal', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'active');
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    updateGoalStatus(db, g.id, 'active');
    updateSessionGoal(db, s.id, g.id);

    const updated = getSessionById(db, s.id)!;
    pauseCurrentSession(db, updated);

    expect(getSessionById(db, s.id)!.status).toBe('paused');
    expect(getGoalById(db, g.id)!.status).toBe('paused');
  });

  it('does nothing to goal if no active goal', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'active');

    const updated = getSessionById(db, s.id)!;
    pauseCurrentSession(db, updated);

    expect(getSessionById(db, s.id)!.status).toBe('paused');
  });

  it('skips completed goals when pausing', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'active');
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    updateGoalStatus(db, g.id, 'completed');
    updateSessionGoal(db, s.id, g.id);

    const updated = getSessionById(db, s.id)!;
    pauseCurrentSession(db, updated);

    expect(getGoalById(db, g.id)!.status).toBe('completed');
    expect(getSessionById(db, s.id)!.status).toBe('paused');
  });
});

describe('activateSession', () => {
  it('sets session to active', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'paused');

    activateSession(db, s.id);

    expect(getSessionById(db, s.id)!.status).toBe('active');
  });

  it('sets most recent paused goal as active_goal_id', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g1 = createGoal(db, { session_id: s.id, title: 'G1', description: 'd1' });
    updateGoalStatus(db, g1.id, 'completed');
    const g2 = createGoal(db, { session_id: s.id, title: 'G2', description: 'd2' });
    updateGoalStatus(db, g2.id, 'paused');

    activateSession(db, s.id);

    expect(getSessionById(db, s.id)!.active_goal_id).toBe(g2.id);
  });
});

describe('session current', () => {
  it('resolves active session', () => {
    const s = createSession(db, { name: 'my-project', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s.id, 'active');

    const current = resolveSession(db);
    expect(current).toBeDefined();
    expect(current!.name).toBe('my-project');
  });
});

describe('session resume with name', () => {
  it('resumes specific session by name', () => {
    const s1 = createSession(db, { name: 's1', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s1.id, 'paused');
    const s2 = createSession(db, { name: 's2', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s2.id, 'paused');

    activateSession(db, s1.id);
    expect(getSessionById(db, s1.id)!.status).toBe('active');
    expect(getSessionById(db, s2.id)!.status).toBe('paused');
  });
});

function isUnfinished(status: string): boolean {
  return status === 'created' || status === 'active' || status === 'paused';
}

describe('session switch', () => {
  it('pauses current and activates target', () => {
    const s1 = createSession(db, { name: 'proj-a', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s1.id, 'active');
    const g1 = createGoal(db, { session_id: s1.id, title: 'G1', description: 'd' });
    updateGoalStatus(db, g1.id, 'active');
    updateSessionGoal(db, s1.id, g1.id);

    const s2 = createSession(db, { name: 'proj-b', project_path: '/tmp', engine: 'claude' });
    updateSessionStatus(db, s2.id, 'paused');

    const current = getSessionById(db, s1.id)!;
    pauseCurrentSession(db, current);
    activateSession(db, s2.id);

    expect(getSessionById(db, s1.id)!.status).toBe('paused');
    expect(getGoalById(db, g1.id)!.status).toBe('paused');
    expect(getSessionById(db, s2.id)!.status).toBe('active');
  });
});

describe('session close', () => {
  it('marks session completed if all goals done', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g = createGoal(db, { session_id: s.id, title: 'G', description: 'd' });
    updateGoalStatus(db, g.id, 'completed');

    const goals = getGoalsBySession(db, s.id);
    const allDone = goals.every(g => g.status === 'completed');
    const finalStatus = allDone ? 'completed' : 'abandoned';
    updateSessionStatus(db, s.id, finalStatus);

    expect(getSessionById(db, s.id)!.status).toBe('completed');
  });

  it('marks session abandoned if unfinished goals exist', () => {
    const s = createSession(db, { name: 's', project_path: '/tmp', engine: 'claude' });
    const g1 = createGoal(db, { session_id: s.id, title: 'G1', description: 'd' });
    updateGoalStatus(db, g1.id, 'completed');
    const g2 = createGoal(db, { session_id: s.id, title: 'G2', description: 'd' });
    updateGoalStatus(db, g2.id, 'paused');

    const goals = getGoalsBySession(db, s.id);
    for (const g of goals) {
      if (isUnfinished(g.status)) {
        updateGoalStatus(db, g.id, 'abandoned');
      }
    }
    const updatedGoals = getGoalsBySession(db, s.id);
    const allDone = updatedGoals.every(g => g.status === 'completed');
    updateSessionStatus(db, s.id, allDone ? 'completed' : 'abandoned');

    expect(getSessionById(db, s.id)!.status).toBe('abandoned');
    expect(getGoalById(db, g2.id)!.status).toBe('abandoned');
  });
});
