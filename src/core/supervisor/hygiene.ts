/**
 * Session hygiene checks — passive warnings for session health.
 * Pure functions, no side effects.
 */

import type { Session, Goal } from '../../types/supervisor.js';

const STALE_DAYS = 7;
const MAX_PAUSED_GOALS = 3;

export interface Warning {
  level: 'info' | 'warn';
  message: string;
  suggestion: string;
}

export function checkStaleSession(session: Session): Warning | null {
  const updatedAt = new Date(session.updated_at).getTime();
  const now = Date.now();
  const daysSince = Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000));

  if (daysSince > STALE_DAYS) {
    return {
      level: 'warn',
      message: `Idle for ${daysSince} days.`,
      suggestion: 'Consider: cdx session pause or cdx session close',
    };
  }
  return null;
}

export function checkPausedGoals(goals: Goal[]): Warning | null {
  const pausedCount = goals.filter(g => g.status === 'paused').length;

  if (pausedCount >= MAX_PAUSED_GOALS) {
    return {
      level: 'warn',
      message: `${pausedCount} paused goals in session.`,
      suggestion: 'Review: cdx inspect',
    };
  }
  return null;
}

export function getSessionWarnings(session: Session, goals: Goal[]): Warning[] {
  const warnings: Warning[] = [];

  const stale = checkStaleSession(session);
  if (stale) warnings.push(stale);

  const paused = checkPausedGoals(goals);
  if (paused) warnings.push(paused);

  return warnings;
}
