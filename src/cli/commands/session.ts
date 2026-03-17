import { Command } from 'commander';
import fs from 'node:fs';
import { getDb } from '../../core/storage/db.js';
import {
  createSession, getSessionByName, getActiveSession, listSessions,
  updateSessionStatus, getGoalsBySession, getWPsByGoal,
  getSnapshotsByGoal, getAttemptsByGoal, getSessionById,
  getGoalById, updateGoalStatus, updateSessionGoal, getGoalBySeq,
  updateGoalCloseout,
} from '../../core/storage/supervisor-repository.js';
import { countWPsByStatus } from '../../core/supervisor/scheduler.js';
import { buildCloseoutSummary } from '../../core/supervisor/closeout.js';
import { loadConfig } from '../../core/config/service.js';
import { log } from '../../utils/logger.js';
import type { Session, Goal } from '../../types/supervisor.js';

// ---- Session Resolution ----

/**
 * Resolve the current session:
 *   1. If name is provided, find by name
 *   2. Otherwise, find most recent active/created session
 */
export function resolveSession(db: import('better-sqlite3').Database, name?: string): Session | null {
  if (name) {
    return getSessionByName(db, name) ?? null;
  }
  return getActiveSession(db) ?? null;
}

function isUnfinished(status: string): boolean {
  return status === 'created' || status === 'active' || status === 'paused';
}

/**
 * Pause a session and its active goal (if unfinished).
 * Shared primitive used by: switch, pause commands.
 */
export function pauseCurrentSession(db: import('better-sqlite3').Database, session: Session): void {
  if (session.active_goal_id) {
    const goal = getGoalById(db, session.active_goal_id);
    if (goal && isUnfinished(goal.status)) {
      updateGoalStatus(db, goal.id, 'paused');
    }
  }
  updateSessionStatus(db, session.id, 'paused');
}

/**
 * Activate a session and set its most recent paused/created goal as active.
 * Shared primitive used by: switch, resume commands.
 */
export function activateSession(db: import('better-sqlite3').Database, sessionId: string): void {
  updateSessionStatus(db, sessionId, 'active');
  // Find most recent paused/created goal (by updated_at DESC — most recently worked on)
  const resumable = db.prepare(
    `SELECT * FROM goals WHERE session_id = ? AND status IN ('paused', 'created') ORDER BY updated_at DESC LIMIT 1`
  ).get(sessionId) as Goal | undefined;
  if (resumable) {
    updateSessionGoal(db, sessionId, resumable.id);
  }
}

// ---- Display Helpers ----

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    created: 'Created', active: 'Running', paused: 'Paused',
    completed: 'Done', failed: 'Failed', hard_blocked: 'Blocked',
    abandoned: 'Cancelled',
  };
  return map[status] || status;
}

function formatGoalSource(goal: Goal): string {
  if (goal.source_type === 'plan_file') return `Plan: ${goal.source_file || '—'}`;
  if (goal.source_type === 'inline_task') return `Task: ${goal.description.slice(0, 60)}`;
  // Legacy goals without source_type
  return goal.source_file ? `Plan: ${goal.source_file}` : '—';
}

function showSessionStatus(session: Session, goals: Goal[], db: import('better-sqlite3').Database): void {
  console.log(`Session:  ${session.name} [${formatStatus(session.status)}]`);
  console.log(`Engine:   ${session.engine}`);
  console.log(`Path:     ${session.project_path}`);

  // Active goal info
  const activeGoal = goals.find(g => g.id === session.active_goal_id);
  if (activeGoal) {
    const wps = getWPsByGoal(db, activeGoal.id);
    const counts = countWPsByStatus(wps);
    const activeWP = wps.find(w => w.status === 'active');
    const total = wps.length;
    const completed = counts.completed || 0;

    console.log('');
    console.log(`Goal:     ${activeGoal.title} [${activeGoal.status}]`);
    console.log(`Progress: ${completed}/${total} WPs completed`);

    if (activeWP) {
      const retry = activeWP.retry_count > 0 ? ` (attempt ${activeWP.retry_count + 1}/${activeWP.retry_budget})` : '';
      console.log(`Current:  ${activeWP.title}${retry}`);
    }

    if (counts.failed) console.log(`Failed:   ${counts.failed} WPs`);
    if (counts.blocked) console.log(`Blocked:  ${counts.blocked} WPs`);
  } else if (goals.length > 0) {
    console.log('');
    console.log(`Goals:    ${goals.length} (no active goal)`);
  } else {
    console.log('');
    console.log('No goals yet. Run: cdx execute <plan.md> --until-done');
  }

  if (session.working_summary) {
    console.log('');
    console.log(`Summary:  ${session.working_summary}`);
  }

  console.log('');
  console.log(`Updated:  ${session.updated_at}`);
}

function showSessionInspect(session: Session, goals: Goal[], db: import('better-sqlite3').Database): void {
  console.log('=== Session Details ===');
  console.log(`ID:          ${session.id}`);
  console.log(`Name:        ${session.name}`);
  console.log(`Engine:      ${session.engine}`);
  console.log(`Path:        ${session.project_path}`);
  console.log(`Status:      ${formatStatus(session.status)}`);
  console.log(`Created:     ${session.created_at}`);
  console.log(`Updated:     ${session.updated_at}`);

  if (session.working_summary) {
    console.log(`Summary:     ${session.working_summary}`);
  }
  if (session.decisions) {
    console.log(`Decisions:   ${session.decisions}`);
  }
  if (session.constraints) {
    console.log(`Constraints: ${session.constraints}`);
  }
  console.log('');

  for (const goal of goals) {
    const isActive = goal.id === session.active_goal_id;
    const wps = getWPsByGoal(db, goal.id);
    const counts = countWPsByStatus(wps);
    const snapshots = getSnapshotsByGoal(db, goal.id);
    const attempts = getAttemptsByGoal(db, goal.id);

    console.log(`=== Goal: ${goal.title} ${isActive ? '[ACTIVE]' : `[${goal.status}]`} ===`);
    console.log(`  Type:       ${goal.goal_type || 'custom'}`);
    console.log(`  Source:     ${formatGoalSource(goal)}`);
    console.log(`  Progress:   ${counts.completed || 0}/${wps.length} WPs`);
    console.log(`  Attempts:   ${attempts.length}`);
    console.log('');

    // WPs
    console.log(`  Work Packages (${wps.length}):`);
    for (const wp of wps) {
      const icon = wp.status === 'completed' ? 'x' : wp.status === 'active' ? '>' : wp.status === 'failed' || wp.status === 'blocked' ? '!' : ' ';
      const retry = wp.retry_count > 0 ? ` [retries: ${wp.retry_count}/${wp.retry_budget}]` : '';
      const blocker = wp.blocker_detail ? ` — ${wp.blocker_detail}` : '';
      console.log(`    [${icon}] ${wp.seq}. ${wp.title}${retry}${blocker}`);
    }
    console.log('');

    // Attempts
    if (attempts.length > 0) {
      console.log(`  Attempts (${attempts.length}):`);
      for (const a of attempts) {
        const progress = a.progress_detected ? 'progress' : 'no progress';
        console.log(`    #${a.attempt_no} [${a.status}] ${a.prompt_strategy || 'normal'} — ${progress}`);
        if (a.notes) console.log(`       ${a.notes}`);
      }
      console.log('');
    }

    // Latest snapshot
    if (snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      console.log(`  Latest Snapshot:`);
      console.log(`    ${latest.trigger} — ${latest.summary.slice(0, 100)}`);
      console.log(`    Next: ${latest.next_action.slice(0, 100)}`);
      console.log('');
    }

    // Closeout summary
    if (goal.closeout_summary) {
      try {
        const closeout = JSON.parse(goal.closeout_summary);
        console.log('  Closeout:');
        console.log(`    Status:      ${closeout.final_status}`);
        console.log(`    WPs:         ${closeout.wps_completed}/${closeout.wps_total} completed`);
        console.log(`    Attempts:    ${closeout.attempts_total}`);
        if (closeout.total_cost_usd) console.log(`    Cost:        $${closeout.total_cost_usd.toFixed(4)}`);
        if (closeout.files_touched?.length > 0) console.log(`    Files:       ${closeout.files_touched.length} touched`);
        if (closeout.key_decisions?.length > 0) {
          console.log('    Decisions:');
          for (const d of closeout.key_decisions.slice(0, 5)) console.log(`      - ${d}`);
        }
        if (closeout.blockers_encountered?.length > 0) {
          console.log('    Blockers:');
          for (const b of closeout.blockers_encountered) console.log(`      - ${b}`);
        }
        if (closeout.next_recommended_action) {
          console.log(`    Next:        ${closeout.next_recommended_action}`);
        }
        console.log('');
      } catch { /* malformed closeout */ }
    }
  }
}

function showSessionHistory(session: Session, goals: Goal[], db: import('better-sqlite3').Database): void {
  console.log(`Session: ${session.name} [${formatStatus(session.status)}]`);
  console.log(`Created: ${session.created_at}`);
  console.log('');

  if (goals.length === 0) {
    console.log('No goals in this session.');
    return;
  }

  console.log(`Goals (${goals.length}):`);
  console.log('');

  for (const goal of goals) {
    const isActive = goal.id === session.active_goal_id;
    const wps = getWPsByGoal(db, goal.id);
    const counts = countWPsByStatus(wps);
    const attempts = getAttemptsByGoal(db, goal.id);
    const snapshots = getSnapshotsByGoal(db, goal.id);

    const marker = isActive ? ' [ACTIVE]' : '';
    console.log(`  ${goal.title}${marker}`);
    console.log(`    Status:    ${goal.status}`);
    console.log(`    Progress:  ${counts.completed || 0}/${wps.length} WPs`);
    console.log(`    Attempts:  ${attempts.length}`);
    console.log(`    Source:    ${formatGoalSource(goal)}`);
    console.log(`    Created:   ${goal.created_at}`);
    console.log(`    Updated:   ${goal.updated_at}`);

    if (snapshots.length > 0) {
      const latest = snapshots[snapshots.length - 1];
      console.log(`    Summary:   ${latest.summary.slice(0, 80)}`);
    }

    console.log('');
  }
}

// ---- Commands ----

export function registerSessionCommand(program: Command): void {
  const sessionCmd = program
    .command('session')
    .description('Manage sessions');

  // cdx session start <name>
  sessionCmd
    .command('start <name>')
    .description('Start or reactivate a session')
    .option('--path <path>', 'Workspace path')
    .option('--engine <engine>', 'Engine to use (claude, codex)')
    .action(async (name: string, opts: { path?: string; engine?: string }) => {
      const db = getDb();
      const config = loadConfig();

      const engine = opts.engine || config.defaultEngine;
      if (!engine) {
        log.error('No engine specified. Use --engine or set defaultEngine in config.');
        process.exit(1);
      }

      const projectPath = opts.path || config.defaultPath || process.cwd();
      if (!fs.existsSync(projectPath)) {
        log.error(`Workspace path does not exist: ${projectPath}`);
        process.exit(1);
      }

      // Check if session with this name already exists
      const existing = getSessionByName(db, name);
      if (existing) {
        // Reactivate
        if (existing.status === 'paused' || existing.status === 'created') {
          updateSessionStatus(db, existing.id, 'active');
          const updated = getSessionById(db, existing.id)!;
          log.info(`Session reactivated: ${updated.name}`);
          showSessionStatus(updated, getGoalsBySession(db, updated.id), db);
        } else {
          log.info(`Session "${name}" exists [${existing.status}]`);
          showSessionStatus(existing, getGoalsBySession(db, existing.id), db);
        }
        return;
      }

      // Create new session
      const session = createSession(db, {
        name,
        project_path: projectPath,
        engine,
      });
      updateSessionStatus(db, session.id, 'active');

      log.info(`Session started: ${name}`);
      console.log(`  Engine: ${engine}`);
      console.log(`  Path:   ${projectPath}`);
      console.log('');
      console.log('Next: cdx execute <plan.md> --until-done');
    });

  // cdx session list
  sessionCmd
    .command('list')
    .description('List all sessions')
    .option('--status <status>', 'Filter by status')
    .action(async (opts: { status?: string }) => {
      const db = getDb();
      const sessions = listSessions(db, { status: opts.status });

      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }

      for (const s of sessions) {
        const goals = getGoalsBySession(db, s.id);
        const goalCount = goals.length > 0 ? `${goals.length} goals` : 'no goals';
        console.log(`  ${s.name.padEnd(25)} ${formatStatus(s.status).padEnd(10)} ${goalCount.padEnd(10)} ${s.updated_at}`);
      }
    });

  // cdx session status
  sessionCmd
    .command('status')
    .description('Show current session status')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session. Run: cdx session start <name> --path <path>');
        return;
      }
      const goals = getGoalsBySession(db, session.id);
      showSessionStatus(session, goals, db);
    });

  // cdx session inspect
  sessionCmd
    .command('inspect')
    .description('Detailed inspection of current session')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session. Run: cdx session start <name> --path <path>');
        return;
      }
      const goals = getGoalsBySession(db, session.id);
      showSessionInspect(session, goals, db);
    });

  // cdx session history
  sessionCmd
    .command('history')
    .description('View session goal history as reference')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session. Run: cdx session start <name> --path <path>');
        return;
      }
      const goals = getGoalsBySession(db, session.id);
      showSessionHistory(session, goals, db);
    });

  // cdx session current
  sessionCmd
    .command('current')
    .description('Show which session is active')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session.');
        return;
      }
      console.log(`  ${session.name} (${session.status})`);
    });

  // cdx session pause
  sessionCmd
    .command('pause')
    .description('Pause current session and active goal')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session to pause.');
        return;
      }
      if (session.status === 'paused') {
        console.log(`Session "${session.name}" is already paused.`);
        return;
      }

      const goals = getGoalsBySession(db, session.id);
      const activeGoal = goals.find(g => g.id === session.active_goal_id && isUnfinished(g.status));

      pauseCurrentSession(db, session);

      console.log(`⏸ Paused: ${session.name}`);
      if (activeGoal) {
        const wps = getWPsByGoal(db, activeGoal.id);
        const counts = countWPsByStatus(wps);
        console.log(`  Goal "${activeGoal.title}" paused (${counts.completed || 0}/${wps.length} WPs done)`);
      }
    });

  // cdx session resume [name]
  sessionCmd
    .command('resume [name]')
    .description('Resume a paused session')
    .action(async (name?: string) => {
      const db = getDb();

      let session;
      if (name) {
        session = getSessionByName(db, name);
        if (!session) {
          log.error(`Session "${name}" not found.`);
          process.exit(1);
        }
      } else {
        session = db.prepare(
          `SELECT * FROM sessions WHERE status = 'paused' ORDER BY updated_at DESC LIMIT 1`
        ).get() as Session | undefined;
        if (!session) {
          console.log('No paused session to resume.');
          return;
        }
      }

      if (session.status !== 'paused' && session.status !== 'created') {
        console.log(`Session "${session.name}" is ${session.status}. Cannot resume.`);
        return;
      }

      activateSession(db, session.id);

      const goals = getGoalsBySession(db, session.id);
      const activeGoal = goals.find(g => g.status === 'active' || g.status === 'paused' || g.status === 'created');

      console.log(`▶ Resumed: ${session.name}`);
      if (activeGoal) {
        const wps = getWPsByGoal(db, activeGoal.id);
        const counts = countWPsByStatus(wps);
        console.log(`  Continuing goal: ${activeGoal.title} (${counts.completed || 0}/${wps.length} WPs done)`);
      }
    });

  // cdx session switch <name>
  sessionCmd
    .command('switch <name>')
    .description('Switch to another session')
    .action(async (name: string) => {
      const db = getDb();

      const target = getSessionByName(db, name);
      if (!target) {
        log.error(`Session "${name}" not found.`);
        process.exit(1);
      }

      if (target.status === 'completed' || target.status === 'abandoned') {
        log.error(`Session "${name}" is ${target.status}. Use "cdx session start ${name}" to reactivate.`);
        process.exit(1);
      }

      const current = resolveSession(db);
      if (current && current.id !== target.id) {
        pauseCurrentSession(db, current);
        console.log(`⏸ Paused session: ${current.name}`);
      }

      const prevStatus = target.status;
      activateSession(db, target.id);
      console.log(`▶ Switched to: ${target.name} (${prevStatus} → active)`);
    });

  // cdx session close
  sessionCmd
    .command('close')
    .description('Close current session')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session to close.');
        return;
      }

      const goals = getGoalsBySession(db, session.id);
      let abandonedCount = 0;
      let completedCount = 0;

      // Check completion BEFORE mutating goals
      for (const goal of goals) {
        if (goal.status === 'completed') {
          completedCount++;
        }
      }
      const allDone = goals.length > 0 && completedCount === goals.length;

      // Now abandon unfinished goals
      for (const goal of goals) {
        if (isUnfinished(goal.status)) {
          updateGoalStatus(db, goal.id, 'abandoned');
          try {
            const updatedGoal = getGoalById(db, goal.id)!;
            const goalWPs = getWPsByGoal(db, goal.id);
            const goalAttempts = getAttemptsByGoal(db, goal.id);
            const goalSnapshots = getSnapshotsByGoal(db, goal.id);
            const closeout = buildCloseoutSummary({ goal: updatedGoal, wps: goalWPs, attempts: goalAttempts, snapshots: goalSnapshots, totalCost: 0 });
            updateGoalCloseout(db, goal.id, JSON.stringify(closeout));
          } catch { /* best effort */ }
          abandonedCount++;
        }
      }

      const finalStatus = allDone ? 'completed' : 'abandoned';
      updateSessionStatus(db, session.id, finalStatus as any);

      console.log(`Session "${session.name}" closed.`);
      if (completedCount > 0 || abandonedCount > 0) {
        const parts: string[] = [];
        if (completedCount > 0) parts.push(`${completedCount} completed`);
        if (abandonedCount > 0) parts.push(`${abandonedCount} paused (→ abandoned)`);
        console.log(`  Goals: ${parts.join(', ')}`);
      }
    });
}

// ---- Top-level aliases ----

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current session status')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session. Run: cdx session start <name> --path <path>');
        return;
      }
      const goals = getGoalsBySession(db, session.id);
      showSessionStatus(session, goals, db);
    });
}

export function registerInspectCommand(program: Command): void {
  program
    .command('inspect')
    .description('Detailed inspection of current session')
    .action(async () => {
      const db = getDb();
      const session = resolveSession(db);
      if (!session) {
        console.log('No active session. Run: cdx session start <name> --path <path>');
        return;
      }
      const goals = getGoalsBySession(db, session.id);
      showSessionInspect(session, goals, db);
    });
}
