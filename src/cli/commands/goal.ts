import { Command } from 'commander';
import fs from 'node:fs';
import { getDb } from '../../core/storage/db.js';
import {
  createSession, createGoal, createWorkPackage, updateSessionGoal,
  getGoalById, getWPsByGoal, getSnapshotsByGoal, getAttemptsByGoal,
  listGoals,
} from '../../core/storage/supervisor-repository.js';
import { parsePlan, createSingleWPPlan } from '../../core/supervisor/plan-parser.js';
import { loadConfig } from '../../core/config/service.js';
import { countWPsByStatus } from '../../core/supervisor/scheduler.js';
import { log } from '../../utils/logger.js';
import type { GoalType } from '../../types/supervisor.js';

export function registerGoalCommand(program: Command): void {
  const goalCmd = program
    .command('goal')
    .description('[Internal] Manage goals and work packages directly');

  // cdx goal create <title>
  goalCmd
    .command('create <title>')
    .description('Create a goal from a plan file or task description')
    .option('--plan <file>', 'Plan markdown file to parse into work packages')
    .option('--task <description>', 'Single task description (creates 1 WP)')
    .option('--engine <engine>', 'Engine to use (claude, codex)')
    .option('--path <path>', 'Workspace path')
    .option('--type <type>', 'Goal type (execute_plan, implement, debug, review, custom)')
    .action(async (title: string, opts: { plan?: string; task?: string; engine?: string; path?: string; type?: string }) => {
      const db = getDb();
      const config = loadConfig();

      // Resolve engine and path
      const engine = opts.engine || config.defaultEngine;
      if (!engine) {
        log.error('No engine specified. Use --engine or set defaultEngine in config.');
        process.exit(1);
      }

      const projectPath = opts.path || config.defaultPath;
      if (!projectPath) {
        log.error('No workspace path. Use --path or set default: cdx set-path <path>');
        process.exit(1);
      }
      if (!fs.existsSync(projectPath)) {
        log.error(`Workspace path does not exist: ${projectPath}`);
        process.exit(1);
      }

      // Need either --plan or --task
      if (!opts.plan && !opts.task) {
        log.error('Provide --plan <file> or --task <description>');
        process.exit(1);
      }

      // Parse plan or create single WP
      let parsedPlan;
      if (opts.plan) {
        if (!fs.existsSync(opts.plan)) {
          log.error(`Plan file not found: ${opts.plan}`);
          process.exit(1);
        }
        const content = fs.readFileSync(opts.plan, 'utf-8');
        parsedPlan = parsePlan(content);
      } else {
        parsedPlan = createSingleWPPlan(opts.task!);
      }

      if (parsedPlan.workPackages.length === 0) {
        log.error('No work packages found in plan.');
        process.exit(1);
      }

      // Create session
      const session = createSession(db, {
        name: title,
        project_path: projectPath,
        engine,
      });

      // Create goal
      const goalType = (opts.type as GoalType) || (opts.plan ? 'execute_plan' : 'custom');
      const sourceType = opts.plan ? 'plan_file' as const : 'inline_task' as const;
      const goal = createGoal(db, {
        session_id: session.id,
        title,
        description: parsedPlan.description || title,
        goal_type: goalType,
        source_type: sourceType,
        source_file: opts.plan || null,
      });

      // Link goal to session
      updateSessionGoal(db, session.id, goal.id);

      // Create work packages
      for (const wp of parsedPlan.workPackages) {
        createWorkPackage(db, {
          goal_id: goal.id,
          seq: wp.seq,
          title: wp.title,
          description: wp.description,
        });
      }

      // Display
      log.info(`Session: ${session.id.slice(0, 8)}`);
      log.info(`Goal:    ${goal.id.slice(0, 8)} — ${title}`);
      log.info(`Engine:  ${engine}`);
      log.info(`Path:    ${projectPath}`);
      log.info(`WPs:     ${parsedPlan.workPackages.length}`);
      console.log('');

      for (const wp of parsedPlan.workPackages) {
        console.log(`  ${wp.seq}. ${wp.title}`);
      }

      console.log('');
      log.info(`Execute: cdx execute ${goal.id.slice(0, 8)} --until-done`);
      log.info('');
      log.info('Tip: prefer session-first workflow:');
      log.info('  cdx session start <name> --path <path>');
      log.info('  cdx execute <plan.md> --until-done');
    });

  // cdx goal list
  goalCmd
    .command('list')
    .description('List all goals')
    .option('--status <status>', 'Filter by status')
    .action(async (opts: { status?: string }) => {
      const db = getDb();
      const goals = listGoals(db, { status: opts.status });

      if (goals.length === 0) {
        console.log('No goals found.');
        return;
      }

      for (const g of goals) {
        const wps = getWPsByGoal(db, g.id);
        const counts = countWPsByStatus(wps);
        const progress = `${counts.completed || 0}/${wps.length}`;
        console.log(`[${g.id.slice(0, 8)}] ${g.status.padEnd(14)} ${progress.padEnd(6)} ${g.title.slice(0, 50)}`);
      }
    });

  // cdx goal status <goalId>
  goalCmd
    .command('status <goalId>')
    .description('Show goal status with WP progress')
    .action(async (goalId: string) => {
      const db = getDb();

      // Find goal by prefix
      const goal = findGoalByPrefix(db, goalId);
      if (!goal) {
        console.error(`Goal not found: ${goalId}`);
        process.exit(1);
      }

      const wps = getWPsByGoal(db, goal.id);
      const counts = countWPsByStatus(wps);

      console.log(`Goal: ${goal.title} [${goal.status}]`);
      console.log(`Progress: ${counts.completed || 0}/${wps.length} WPs completed`);
      console.log('');

      // Show WPs by status
      const completed = wps.filter(w => w.status === 'completed');
      const active = wps.filter(w => w.status === 'active');
      const pending = wps.filter(w => w.status === 'pending');
      const failed = wps.filter(w => w.status === 'failed' || w.status === 'blocked');

      if (completed.length > 0) {
        console.log('Completed:');
        for (const w of completed) console.log(`  [x] ${w.title}`);
      }

      if (active.length > 0) {
        console.log('Active:');
        for (const w of active) {
          const retry = w.retry_count > 0 ? ` (attempt ${w.retry_count + 1}/${w.retry_budget})` : '';
          console.log(`  [>] ${w.title}${retry}`);
        }
      }

      if (pending.length > 0) {
        console.log('Remaining:');
        for (const w of pending) console.log(`  [ ] ${w.title}`);
      }

      if (failed.length > 0) {
        console.log('Failed/Blocked:');
        for (const w of failed) {
          const reason = w.blocker_detail ? `: ${w.blocker_detail}` : '';
          console.log(`  [!] ${w.title} (${w.status})${reason}`);
        }
      }
    });

  // cdx goal inspect <goalId>
  goalCmd
    .command('inspect <goalId>')
    .description('Detailed inspection: WPs, snapshots, attempts')
    .action(async (goalId: string) => {
      const db = getDb();

      const goal = findGoalByPrefix(db, goalId);
      if (!goal) {
        console.error(`Goal not found: ${goalId}`);
        process.exit(1);
      }

      const wps = getWPsByGoal(db, goal.id);
      const snapshots = getSnapshotsByGoal(db, goal.id);
      const attempts = getAttemptsByGoal(db, goal.id);

      console.log('=== Goal Details ===');
      console.log(`ID:          ${goal.id}`);
      console.log(`Title:       ${goal.title}`);
      console.log(`Type:        ${goal.goal_type || 'custom'}`);
      console.log(`Status:      ${goal.status}`);
      console.log(`Source:      ${goal.source_file || '—'}`);
      console.log(`Created:     ${goal.created_at}`);
      console.log('');

      console.log(`=== Work Packages (${wps.length}) ===`);
      for (const wp of wps) {
        const retry = wp.retry_count > 0 ? ` [retries: ${wp.retry_count}/${wp.retry_budget}]` : '';
        const blocker = wp.blocker_detail ? ` — ${wp.blocker_detail}` : '';
        console.log(`  ${wp.seq}. [${wp.status}] ${wp.title}${retry}${blocker}`);
      }
      console.log('');

      console.log(`=== Execution Attempts (${attempts.length}) ===`);
      for (const a of attempts) {
        const progress = a.progress_detected ? 'progress' : 'no progress';
        const cost = a.run_id ? '' : ' (no run)';
        console.log(`  #${a.attempt_no} [${a.status}] ${a.prompt_strategy || 'normal'} — ${progress}${cost}`);
        if (a.notes) console.log(`     ${a.notes}`);
      }
      console.log('');

      console.log(`=== Snapshots (${snapshots.length}) ===`);
      for (const s of snapshots) {
        console.log(`  [${s.created_at}] ${s.trigger} — ${s.summary.slice(0, 80)}`);
        console.log(`     Next: ${s.next_action.slice(0, 80)}`);
      }
    });
}

function findGoalByPrefix(db: import('better-sqlite3').Database, prefix: string): import('../../types/supervisor.js').Goal | null {
  // Exact match first
  const exact = getGoalById(db, prefix);
  if (exact) return exact;

  // Prefix match
  const matches = db.prepare('SELECT * FROM goals WHERE id LIKE ? LIMIT 2').all(`${prefix}%`) as import('../../types/supervisor.js').Goal[];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`Ambiguous goal ID: ${prefix}. Matches: ${matches.map(m => m.id.slice(0, 8)).join(', ')}`);
    process.exit(1);
  }
  return null;
}
