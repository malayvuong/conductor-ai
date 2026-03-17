/**
 * Closeout summary generator — produces structured closure when a goal ends.
 *
 * Stored as JSON in goal.closeout_summary for history/reference.
 */

import type { Goal, WorkPackage, ExecutionAttempt, Snapshot } from '../../types/supervisor.js';

export interface CloseoutSummary {
  source: 'plan_file' | 'inline_task' | 'unknown';
  objective: string;
  final_status: string;
  attempts_total: number;
  wps_total: number;
  wps_completed: number;
  wps_failed: number;
  files_touched: string[];
  key_decisions: string[];
  blockers_encountered: string[];
  unresolved_follow_ups: string[];
  next_recommended_action: string | null;
  total_cost_usd: number | null;
}

export function buildCloseoutSummary(input: {
  goal: Goal;
  wps: WorkPackage[];
  attempts: ExecutionAttempt[];
  snapshots: Snapshot[];
  totalCost: number;
}): CloseoutSummary {
  const { goal, wps, attempts, snapshots, totalCost } = input;

  // Gather files from all snapshots
  const allFiles = new Set<string>();
  for (const snap of snapshots) {
    if (snap.related_files) {
      try {
        const files = JSON.parse(snap.related_files);
        if (Array.isArray(files)) files.forEach((f: string) => allFiles.add(f));
      } catch { /* ignore */ }
    }
  }

  // Gather decisions from all snapshots
  const allDecisions: string[] = [];
  for (const snap of snapshots) {
    if (snap.decisions) {
      try {
        const decisions = JSON.parse(snap.decisions);
        if (Array.isArray(decisions)) {
          for (const d of decisions) {
            const text = typeof d === 'string' ? d : d.decision || JSON.stringify(d);
            if (!allDecisions.includes(text)) allDecisions.push(text);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Gather blockers
  const allBlockers: string[] = [];
  for (const wp of wps) {
    if (wp.blocker_detail && !allBlockers.includes(wp.blocker_detail)) {
      allBlockers.push(wp.blocker_detail);
    }
  }
  for (const snap of snapshots) {
    if (snap.blockers_encountered) {
      try {
        const blockers = JSON.parse(snap.blockers_encountered);
        if (Array.isArray(blockers)) {
          for (const b of blockers) {
            const text = typeof b === 'string' ? b : b.detail || JSON.stringify(b);
            if (!allBlockers.includes(text)) allBlockers.push(text);
          }
        }
      } catch { /* ignore */ }
    }
  }

  // Extract follow-ups from last snapshot or attempt notes
  const followUps: string[] = [];
  if (snapshots.length > 0) {
    const last = snapshots[snapshots.length - 1];
    if (last.next_action && goal.status !== 'completed') {
      followUps.push(last.next_action);
    }
  }
  for (const a of attempts) {
    if (a.notes && a.notes.includes('follow') && !followUps.includes(a.notes)) {
      followUps.push(a.notes);
    }
  }

  // Determine next recommended action
  let nextAction: string | null = null;
  if (goal.status === 'completed') {
    nextAction = null;
  } else if (goal.status === 'hard_blocked') {
    const blockedWP = wps.find(w => w.status === 'blocked');
    nextAction = blockedWP
      ? `Resolve blocker on "${blockedWP.title}": ${blockedWP.blocker_detail || 'unknown'}`
      : 'Resolve hard blocker and retry';
  } else if (goal.status === 'failed') {
    const failedWPs = wps.filter(w => w.status === 'failed');
    nextAction = failedWPs.length > 0
      ? `Retry failed WPs: ${failedWPs.map(w => w.title).join(', ')}`
      : 'Review execution history and retry';
  } else if (goal.status === 'paused') {
    nextAction = 'Resume with: cdx execute --until-done';
  }

  const wpCompleted = wps.filter(w => w.status === 'completed').length;
  const wpFailed = wps.filter(w => w.status === 'failed' || w.status === 'blocked').length;

  return {
    source: (goal.source_type as 'plan_file' | 'inline_task') || 'unknown',
    objective: goal.description,
    final_status: goal.status,
    attempts_total: attempts.length,
    wps_total: wps.length,
    wps_completed: wpCompleted,
    wps_failed: wpFailed,
    files_touched: [...allFiles],
    key_decisions: allDecisions,
    blockers_encountered: allBlockers,
    unresolved_follow_ups: followUps,
    next_recommended_action: nextAction,
    total_cost_usd: totalCost > 0 ? totalCost : null,
  };
}
