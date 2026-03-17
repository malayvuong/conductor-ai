import { describe, it, expect } from 'vitest';
import { selectNextWP, allWPsCompleted, allWPsTerminal, countWPsByStatus } from '../../src/core/supervisor/scheduler.js';
import type { WorkPackage } from '../../src/types/supervisor.js';

const makeWP = (overrides?: Partial<WorkPackage>): WorkPackage => ({
  id: 'wp-1', goal_id: 'g-1', parent_wp_id: null, seq: 1,
  title: 'Test WP', description: '', status: 'pending',
  done_criteria: null, dependencies: null,
  retry_count: 0, retry_budget: 3,
  last_progress_at: null, blocker_type: null, blocker_detail: null,
  created_at: '', updated_at: '',
  ...overrides,
});

describe('selectNextWP', () => {
  it('selects active WP first', () => {
    const wps = [
      makeWP({ id: 'wp-1', status: 'pending', seq: 1 }),
      makeWP({ id: 'wp-2', status: 'active', seq: 2 }),
    ];
    expect(selectNextWP(wps)!.id).toBe('wp-2');
  });

  it('selects first pending WP when none active', () => {
    const wps = [
      makeWP({ id: 'wp-1', status: 'completed', seq: 1 }),
      makeWP({ id: 'wp-2', status: 'pending', seq: 2 }),
      makeWP({ id: 'wp-3', status: 'pending', seq: 3 }),
    ];
    expect(selectNextWP(wps)!.id).toBe('wp-2');
  });

  it('skips WPs with exhausted retries', () => {
    const wps = [
      makeWP({ id: 'wp-1', status: 'pending', retry_count: 3, retry_budget: 3, seq: 1 }),
      makeWP({ id: 'wp-2', status: 'pending', retry_count: 0, seq: 2 }),
    ];
    expect(selectNextWP(wps)!.id).toBe('wp-2');
  });

  it('respects dependencies', () => {
    const wps = [
      makeWP({ id: 'wp-1', status: 'pending', seq: 1, dependencies: '["wp-0"]' }),
      makeWP({ id: 'wp-2', status: 'pending', seq: 2 }),
    ];
    // wp-0 not completed → wp-1 skipped
    expect(selectNextWP(wps)!.id).toBe('wp-2');
  });

  it('selects WP when dependencies are satisfied', () => {
    const wps = [
      makeWP({ id: 'wp-0', status: 'completed', seq: 0 }),
      makeWP({ id: 'wp-1', status: 'pending', seq: 1, dependencies: '["wp-0"]' }),
    ];
    expect(selectNextWP(wps)!.id).toBe('wp-1');
  });

  it('returns null when all WPs are terminal', () => {
    const wps = [
      makeWP({ id: 'wp-1', status: 'completed', seq: 1 }),
      makeWP({ id: 'wp-2', status: 'failed', seq: 2 }),
    ];
    expect(selectNextWP(wps)).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(selectNextWP([])).toBeNull();
  });
});

describe('allWPsCompleted', () => {
  it('true when all completed', () => {
    const wps = [
      makeWP({ status: 'completed' }),
      makeWP({ id: 'wp-2', status: 'completed' }),
    ];
    expect(allWPsCompleted(wps)).toBe(true);
  });

  it('false when some pending', () => {
    const wps = [
      makeWP({ status: 'completed' }),
      makeWP({ id: 'wp-2', status: 'pending' }),
    ];
    expect(allWPsCompleted(wps)).toBe(false);
  });

  it('false for empty list', () => {
    expect(allWPsCompleted([])).toBe(false);
  });
});

describe('allWPsTerminal', () => {
  it('true when all terminal', () => {
    const wps = [
      makeWP({ status: 'completed' }),
      makeWP({ id: 'wp-2', status: 'failed' }),
      makeWP({ id: 'wp-3', status: 'blocked' }),
    ];
    expect(allWPsTerminal(wps)).toBe(true);
  });

  it('false when some active', () => {
    const wps = [
      makeWP({ status: 'completed' }),
      makeWP({ id: 'wp-2', status: 'active' }),
    ];
    expect(allWPsTerminal(wps)).toBe(false);
  });
});

describe('countWPsByStatus', () => {
  it('counts correctly', () => {
    const wps = [
      makeWP({ status: 'completed' }),
      makeWP({ id: 'wp-2', status: 'completed' }),
      makeWP({ id: 'wp-3', status: 'pending' }),
      makeWP({ id: 'wp-4', status: 'failed' }),
    ];
    const counts = countWPsByStatus(wps);
    expect(counts.completed).toBe(2);
    expect(counts.pending).toBe(1);
    expect(counts.failed).toBe(1);
  });
});
