import { Command } from 'commander';
import fs from 'node:fs';
import { getDb } from '../../core/storage/db.js';
import {
  getGoalById, createGoal, createWorkPackage,
  updateSessionGoal, updateSessionStatus, updateGoalStatus,
  getWPsByGoal,
} from '../../core/storage/supervisor-repository.js';
import { resolveSession } from './session.js';
import { parsePlan, createSingleWPPlan } from '../../core/supervisor/plan-parser.js';
import { executeGoal } from '../../core/supervisor/loop.js';
import { log } from '../../utils/logger.js';
import { formatProgressEvent } from '../../core/supervisor/progress-reporter.js';
import { countWPsByStatus } from '../../core/supervisor/scheduler.js';
import type { Goal, GoalType } from '../../types/supervisor.js';

/**
 * Resume vs New Goal Rules (locked down):
 *
 *   cdx execute --until-done          → RESUME active unfinished goal only
 *   cdx execute "text" --until-done   → ALWAYS create new goal
 *   cdx execute plan.md --until-done  → ALWAYS create new goal
 *
 * If creating new goal while an active unfinished goal exists:
 *   → auto-pause the old goal
 *   → inform user
 *   → set new goal as active
 */
export function registerExecuteCommand(program: Command): void {
  program
    .command('execute [source]')
    .description('Execute a plan file, ad-hoc task, or resume active goal')
    .option('--until-done', 'Keep running until all WPs are completed (default behavior)')
    .option('--session <name>', 'Use specific session by name')
    .option('--type <type>', 'Goal type (execute_plan, implement, debug, review, custom, ad_hoc)')
    .action(async (source: string | undefined, opts: {
      untilDone?: boolean; session?: string; type?: string;
    }) => {
      const db = getDb();

      // Resolve session
      const session = resolveSession(db, opts.session);
      if (!session) {
        log.error('No active session. Run: cdx session start <name> --path <path>');
        process.exit(1);
      }

      let goal: Goal;

      if (source) {
        // ---- NEW GOAL (plan or ad-hoc) ----
        // Rule: source provided → ALWAYS create new goal

        // If there's an active unfinished goal, auto-pause it
        if (session.active_goal_id) {
          const oldGoal = getGoalById(db, session.active_goal_id);
          if (oldGoal && isUnfinished(oldGoal.status)) {
            updateGoalStatus(db, oldGoal.id, 'paused');
            log.info(`Paused previous goal: ${oldGoal.title}`);
          }
        }

        // Resolve input: file path vs task description
        if (fs.existsSync(source)) {
          goal = createGoalFromPlan(db, session.id, source, opts.type as GoalType | undefined);
        } else {
          goal = createGoalFromTask(db, session.id, source, opts.type as GoalType | undefined);
        }
        updateSessionGoal(db, session.id, goal.id);
      } else {
        // ---- RESUME ----
        // Rule: no source → resume active unfinished goal only
        if (!session.active_goal_id) {
          log.error('No active goal to resume. Start a new execution:');
          log.error('  cdx execute /path/to/plan.md --until-done');
          log.error('  cdx execute "fix bug description" --until-done');
          process.exit(1);
        }

        const activeGoal = getGoalById(db, session.active_goal_id);
        if (!activeGoal) {
          log.error('Active goal not found in database.');
          process.exit(1);
        }

        if (!isUnfinished(activeGoal.status)) {
          log.info(`Active goal "${activeGoal.title}" is ${activeGoal.status}. Start a new execution:`);
          log.info('  cdx execute /path/to/plan.md --until-done');
          log.info('  cdx execute "fix bug description" --until-done');
          return;
        }

        goal = activeGoal;
        log.info(`Resuming: ${goal.title}`);
      }

      // Ensure session is active
      if (session.status !== 'active') {
        updateSessionStatus(db, session.id, 'active');
      }

      // Execute
      console.log('');
      const result = await executeGoal(db, session, goal);

      // Final output
      console.log('');
      const wps = getWPsByGoal(db, goal.id);
      const counts = countWPsByStatus(wps);
      console.log(formatProgressEvent({
        type: 'goal_end',
        completed: counts.completed || 0,
        total: wps.length,
        attempts: result.totalAttempts,
        cost: result.totalCost,
      }));
    });
}

// ---- Helpers ----

function isUnfinished(status: string): boolean {
  return status === 'created' || status === 'active' || status === 'paused';
}

// ---- Plan mode ----

function createGoalFromPlan(
  db: import('better-sqlite3').Database,
  sessionId: string,
  planPath: string,
  goalType?: GoalType,
): Goal {
  const content = fs.readFileSync(planPath, 'utf-8');
  const plan = parsePlan(content);

  if (plan.workPackages.length === 0) {
    log.error('No work packages found in plan.');
    process.exit(1);
  }

  const type = goalType || 'execute_plan';
  const goal = createGoal(db, {
    session_id: sessionId,
    title: plan.title,
    description: plan.description || plan.title,
    goal_type: type,
    source_type: 'plan_file',
    source_file: planPath,
  });

  for (const wp of plan.workPackages) {
    createWorkPackage(db, {
      goal_id: goal.id,
      seq: wp.seq,
      title: wp.title,
      description: wp.description,
    });
  }

  log.info(`Plan: ${plan.title}`);
  log.info(`WPs:  ${plan.workPackages.length}`);
  for (const wp of plan.workPackages) {
    console.log(`  ${wp.seq}. ${wp.title}`);
  }
  console.log('');

  return goal;
}

// ---- No-plan mode ----

function createGoalFromTask(
  db: import('better-sqlite3').Database,
  sessionId: string,
  taskDescription: string,
  goalType?: GoalType,
): Goal {
  const plan = createSingleWPPlan(taskDescription);
  const type = goalType || 'ad_hoc';

  const goal = createGoal(db, {
    session_id: sessionId,
    title: plan.title,
    description: taskDescription,
    goal_type: type,
    source_type: 'inline_task',
  });

  createWorkPackage(db, {
    goal_id: goal.id,
    seq: 1,
    title: `Complete task: ${plan.title}`,
    description: taskDescription,
    retry_budget: 2,
  });

  log.info(`Task: ${plan.title}`);
  console.log('');

  return goal;
}
