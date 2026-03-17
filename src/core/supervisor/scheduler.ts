/**
 * WP Scheduler — selects the next work package to execute.
 *
 * Selection priority:
 * 1. Active WP (already in progress)
 * 2. First pending WP whose dependencies are all completed
 * 3. null (all remaining WPs are blocked/completed/failed)
 */

import type { WorkPackage } from '../../types/supervisor.js';

/**
 * Select the next WP to work on.
 */
export function selectNextWP(wps: WorkPackage[]): WorkPackage | null {
  // 1. Active WP first (continue what's in progress)
  const active = wps.find(wp => wp.status === 'active');
  if (active) return active;

  // 2. First pending WP with satisfied dependencies
  const completedIds = new Set(wps.filter(wp => wp.status === 'completed').map(wp => wp.id));

  for (const wp of wps) {
    if (wp.status !== 'pending') continue;
    if (wp.retry_count >= wp.retry_budget) continue;

    // Check dependencies
    if (wp.dependencies) {
      try {
        const deps = JSON.parse(wp.dependencies) as string[];
        const satisfied = deps.every(depId => completedIds.has(depId));
        if (!satisfied) continue;
      } catch { /* invalid deps → treat as no deps */ }
    }

    return wp;
  }

  return null;
}

/**
 * Check if all WPs are in a terminal state (completed/failed/blocked/skipped).
 */
export function allWPsTerminal(wps: WorkPackage[]): boolean {
  return wps.every(wp =>
    wp.status === 'completed' ||
    wp.status === 'failed' ||
    wp.status === 'blocked' ||
    wp.status === 'skipped'
  );
}

/**
 * Check if all WPs are completed.
 */
export function allWPsCompleted(wps: WorkPackage[]): boolean {
  return wps.length > 0 && wps.every(wp => wp.status === 'completed');
}

/**
 * Count WPs by status.
 */
export function countWPsByStatus(wps: WorkPackage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const wp of wps) {
    counts[wp.status] = (counts[wp.status] || 0) + 1;
  }
  return counts;
}
