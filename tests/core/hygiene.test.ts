import { describe, it, expect } from 'vitest';
import { checkStaleSession, checkPausedGoals, getSessionWarnings, type Warning } from '../../src/core/supervisor/hygiene.js';
import type { Session, Goal } from '../../src/types/supervisor.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sid', name: 'test', title: 'test', project_path: '/tmp', engine: 'claude',
    status: 'active', active_goal_id: null, working_summary: null,
    decisions: null, constraints: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'gid', session_id: 'sid', title: 'G', description: 'd',
    goal_type: null, source_type: null, status: 'created',
    completion_rules: null, source_file: null, closeout_summary: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('checkStaleSession', () => {
  it('returns null for recent session', () => {
    const session = makeSession({ updated_at: new Date().toISOString() });
    expect(checkStaleSession(session)).toBeNull();
  });

  it('returns warning for session idle > 7 days', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const session = makeSession({ updated_at: old });
    const warning = checkStaleSession(session);
    expect(warning).not.toBeNull();
    expect(warning!.level).toBe('warn');
    expect(warning!.message).toContain('8');
  });

  it('returns null for exactly 7 days', () => {
    const exact = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const session = makeSession({ updated_at: exact });
    expect(checkStaleSession(session)).toBeNull();
  });
});

describe('checkPausedGoals', () => {
  it('returns null for fewer than 3 paused goals', () => {
    const goals = [
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'paused' }),
    ];
    expect(checkPausedGoals(goals)).toBeNull();
  });

  it('returns warning for 3+ paused goals', () => {
    const goals = [
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'paused' }),
    ];
    const warning = checkPausedGoals(goals);
    expect(warning).not.toBeNull();
    expect(warning!.level).toBe('warn');
    expect(warning!.message).toContain('3');
  });

  it('only counts paused goals', () => {
    const goals = [
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'completed' }),
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'active' }),
    ];
    expect(checkPausedGoals(goals)).toBeNull();
  });
});

describe('getSessionWarnings', () => {
  it('returns empty for healthy session', () => {
    const session = makeSession();
    const goals = [makeGoal({ status: 'active' })];
    expect(getSessionWarnings(session, goals)).toHaveLength(0);
  });

  it('returns multiple warnings', () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const session = makeSession({ updated_at: old });
    const goals = [
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'paused' }),
      makeGoal({ status: 'paused' }),
    ];
    const warnings = getSessionWarnings(session, goals);
    expect(warnings).toHaveLength(2);
  });
});
