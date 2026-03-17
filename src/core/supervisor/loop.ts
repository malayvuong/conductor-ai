/**
 * Supervisor execution loop — the heart of Conductor v2.
 *
 * Runs a goal to completion by iterating:
 *   pick WP → build prompt → run engine → parse results → update state → compact → loop
 *
 * Exit conditions:
 *   A. Done — all WPs completed
 *   B. Hard blocked — unrecoverable blocker
 *   C. All WPs exhausted retries — nothing left to try
 *   D. User interrupt (Ctrl+C)
 */

import type Database from 'better-sqlite3';
import type { Session, Goal, Snapshot, PromptStrategy } from '../../types/supervisor.js';
import type { Run, RunStatus } from '../../types/index.js';
import { selectNextWP, allWPsCompleted, allWPsTerminal, countWPsByStatus } from './scheduler.js';
import { buildGoalPrompt } from './prompt-builder.js';
import { buildSnapshotData } from './compactor.js';
import { detectProgress, determineStrategy, isWPCompleted, detectHardBlocker } from './progress.js';
import {
  getWPsByGoal, getLatestSnapshot, createSnapshot,
  createAttempt, updateAttemptFinished, updateAttemptRunId,
  updateWPStatus, incrementWPRetry, updateWPBlocker, updateWPProgress,
  updateGoalStatus, updateGoalCloseout, updateSessionStatus, updateSessionSummary, getWPById,
  getGoalById, getSnapshotsByGoal, getAttemptsByGoal,
} from '../storage/supervisor-repository.js';
import { buildCloseoutSummary } from './closeout.js';
import {
  createTask, createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, getRunLogs, getTaskById, createHeartbeat, saveReport, updateTaskStatus,
} from '../storage/repository.js';
import { getEngine } from '../engine/types.js';
import { runProcess } from '../runner/process.js';
import { HeartbeatMonitor } from '../heartbeat/monitor.js';
import { generateReport } from '../report/generator.js';
import { parseClaudeStreamEvent } from '../engine/stream-parser.js';
import { loadConfig } from '../config/service.js';
import { log } from '../../utils/logger.js';
import { formatProgressEvent, type ProgressEvent } from './progress-reporter.js';

function emit(event: ProgressEvent): void {
  console.log(formatProgressEvent(event));
}

export interface ExecuteGoalResult {
  status: 'completed' | 'hard_blocked' | 'exhausted' | 'interrupted';
  totalAttempts: number;
  totalCost: number;
  message: string;
}

/**
 * Execute a goal until done, hard-blocked, or exhausted.
 */
export async function executeGoal(
  db: Database.Database,
  session: Session,
  goal: Goal,
): Promise<ExecuteGoalResult> {
  const config = loadConfig();
  let totalAttempts = 0;
  let totalCost = 0;
  let interrupted = false;

  // Setup interrupt handler
  const cleanup = () => { interrupted = true; };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Mark goal and session as active
  updateGoalStatus(db, goal.id, 'active');
  updateSessionStatus(db, session.id, 'active');

  emit({ type: 'goal_start', session: session.name, goal: goal.title });
  console.log('');

  try {
    while (!interrupted) {
      // 1. Load current state
      const wps = getWPsByGoal(db, goal.id);

      // 2. Check: all WPs completed?
      if (allWPsCompleted(wps)) {
        updateGoalStatus(db, goal.id, 'completed');
        updateSessionStatus(db, session.id, 'completed');
        persistCloseout(db, goal, totalCost);
        const counts = countWPsByStatus(wps);
        return {
          status: 'completed',
          totalAttempts,
          totalCost,
          message: `Goal completed. ${counts.completed || 0} WPs done.`,
        };
      }

      // 3. Check: all WPs in terminal state but not all completed?
      if (allWPsTerminal(wps)) {
        updateGoalStatus(db, goal.id, 'failed');
        persistCloseout(db, goal, totalCost);
        const counts = countWPsByStatus(wps);
        return {
          status: 'exhausted',
          totalAttempts,
          totalCost,
          message: `All WPs exhausted. Completed: ${counts.completed || 0}, Failed: ${counts.failed || 0}, Blocked: ${counts.blocked || 0}`,
        };
      }

      // 4. Select next WP
      const wp = selectNextWP(wps);
      if (!wp) {
        updateGoalStatus(db, goal.id, 'hard_blocked');
        persistCloseout(db, goal, totalCost);
        return {
          status: 'hard_blocked',
          totalAttempts,
          totalCost,
          message: 'No available WP to execute. All remaining WPs are blocked or dependencies not met.',
        };
      }

      // 5. Determine strategy based on retry count
      const strategy = determineStrategy(wp.retry_count) as PromptStrategy;

      // 6. Get latest snapshot
      const snapshot = getLatestSnapshot(db, goal.id) || null;

      // 7. Build prompt
      const prompt = buildGoalPrompt({
        session, goal, wp, snapshot, strategy, allWPs: wps,
      });

      // 8. Log iteration info
      totalAttempts++;
      let wpIndex = wps.findIndex(w => w.id === wp.id) + 1;
      emit({ type: 'wp_start', wpIndex, wpTotal: wps.length, title: wp.title, attempt: wp.retry_count + 1, strategy });

      // Mark WP as active
      updateWPStatus(db, wp.id, 'active');

      // 9. Create execution attempt
      const attempt = createAttempt(db, {
        session_id: session.id,
        goal_id: goal.id,
        wp_id: wp.id,
        attempt_no: wp.retry_count + 1,
        snapshot_id: snapshot?.id || null,
        prompt_strategy: strategy,
      });

      // 10. Execute engine (delegates to existing execution layer)
      const runResult = await executeEngineRun(db, session, goal, wp, prompt, config);

      // Link run to attempt
      if (runResult.runId) {
        updateAttemptRunId(db, attempt.id, runResult.runId);
      }
      if (runResult.cost) {
        totalCost += runResult.cost;
      }

      // 11. Parse results
      const report = runResult.report;
      const progress = detectProgress(report, snapshot);

      // 12. Check for hard blockers
      const hardBlocker = detectHardBlocker(report);
      if (hardBlocker?.isHard) {
        updateAttemptFinished(db, attempt.id, 'failed', false, 0, 0, hardBlocker.detail, 'hard', hardBlocker.detail);
        updateWPBlocker(db, wp.id, 'hard', hardBlocker.detail);
        updateWPStatus(db, wp.id, 'blocked');
        emit({ type: 'hard_blocker', wpIndex: wps.findIndex(w => w.id === wp.id) + 1, wpTotal: wps.length, detail: hardBlocker.detail });
        updateGoalStatus(db, goal.id, 'hard_blocked');
        persistCloseout(db, goal, totalCost);
        return {
          status: 'hard_blocked',
          totalAttempts,
          totalCost,
          message: `Hard blocker on "${wp.title}": ${hardBlocker.detail}`,
        };
      }

      // 13. Update attempt
      updateAttemptFinished(
        db, attempt.id,
        runResult.exitCode === 0 ? 'completed' : 'failed',
        progress.hasProgress,
        progress.filesChanged,
        0, // wp completed count updated below
        progress.indicators.join('; '),
      );

      // 14. Update WP status
      const isAdHoc = goal.source_type === 'inline_task' || goal.goal_type === 'ad_hoc';

      if (isWPCompleted(report, isAdHoc)) {
        updateWPStatus(db, wp.id, 'completed');
        updateWPProgress(db, wp.id);
        emit({ type: 'wp_completed', wpIndex, wpTotal: wps.length });
      } else if (progress.hasProgress) {
        updateWPProgress(db, wp.id);
        emit({ type: 'wp_progress', wpIndex, wpTotal: wps.length, detail: progress.indicators.join(', ') });
      } else {
        incrementWPRetry(db, wp.id);
        const updatedWP = getWPById(db, wp.id)!;
        if (updatedWP.retry_count >= updatedWP.retry_budget) {
          updateWPStatus(db, wp.id, 'failed');
          updateWPBlocker(db, wp.id, 'soft', 'Retry budget exhausted without progress');
          emit({ type: 'wp_failed', wpIndex, wpTotal: wps.length, reason: 'retries exhausted' });
        } else {
          emit({ type: 'wp_failed', wpIndex, wpTotal: wps.length, reason: `no progress, retry ${updatedWP.retry_count}/${updatedWP.retry_budget}` });
        }
      }

      // 15. Build snapshot for next iteration
      const updatedWPs = getWPsByGoal(db, goal.id);
      const snapshotData = buildSnapshotData({
        sessionId: session.id,
        goalId: goal.id,
        currentWP: getWPById(db, wp.id)!,
        allWPs: updatedWPs,
        report,
        previousSnapshot: snapshot,
        trigger: runResult.exitCode === 0 ? 'run_completed' : 'run_failed',
        runId: runResult.runId,
      });
      createSnapshot(db, snapshotData);

      // 16. Update session summary
      const counts = countWPsByStatus(updatedWPs);
      updateSessionSummary(db, session.id,
        `${counts.completed || 0}/${updatedWPs.length} WPs completed. Last: ${wp.title} (${strategy}). Cost: $${totalCost.toFixed(4)}`
      );
    }

    // Interrupted by user — pause both goal and session
    updateGoalStatus(db, goal.id, 'paused');
    updateSessionStatus(db, session.id, 'paused');
    return {
      status: 'interrupted',
      totalAttempts,
      totalCost,
      message: 'Execution interrupted by user. Goal and session paused.',
    };
  } finally {
    process.removeListener('SIGINT', cleanup);
    process.removeListener('SIGTERM', cleanup);
  }
}

// ---- Engine execution (bridges supervisor → execution layer) ----

interface EngineRunResult {
  exitCode: number;
  runId: string | null;
  report: import('../../types/index.js').RunReport | null;
  cost: number | null;
}

async function executeEngineRun(
  db: Database.Database,
  session: Session,
  goal: Goal,
  wp: import('../../types/supervisor.js').WorkPackage,
  prompt: string,
  config: import('../config/service.js').ConductorConfig,
): Promise<EngineRunResult> {
  const engine = getEngine(session.engine);
  if (!engine.validateExecutable()) {
    log.error(`Engine executable '${session.engine}' not found in PATH`);
    return { exitCode: 1, runId: null, report: null, cost: null };
  }

  const command = engine.buildCommand({
    prompt,
    workspacePath: session.project_path,
  });

  // Create task + run in execution layer
  const task = createTask(db, {
    raw_input: `[Goal: ${goal.title}] WP: ${wp.title}`,
    workspace_path: session.project_path,
    engine: session.engine,
  });
  // Set task_type based on goal_type
  const taskType = mapGoalTypeToTaskType(goal.goal_type);
  if (taskType) {
    db.prepare('UPDATE tasks SET task_type = ?, updated_at = ? WHERE id = ?')
      .run(taskType, new Date().toISOString(), task.id);
  }

  const run = createRun(db, {
    task_id: task.id,
    engine: session.engine,
    command: command.executable,
    args_json: JSON.stringify(command.args),
    prompt_final: prompt,
  });

  updateTaskStatus(db, task.id, 'running');
  updateRunStarted(db, run.id);

  // Heartbeat
  const heartbeatInterval = (config.heartbeatIntervalSec || 15) * 1000;
  const stuckThreshold = config.stuckThresholdSec || 60;
  const heartbeat = new HeartbeatMonitor({
    intervalMs: heartbeatInterval,
    stuckThresholdSeconds: stuckThreshold,
    onHeartbeat: (status, summary, noOutputSeconds) => {
      createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
    },
  });
  heartbeat.start();

  let childPid: number | undefined;
  let runCostUsd: number | null = null;
  let runDurationSeconds: number | null = null;
  const isStreaming = engine.streaming;

  try {
    const result = await runProcess(command, {
      cwd: session.project_path,
      onLine: (stream, line) => {
        appendRunLog(db, run.id, stream, line);
        heartbeat.recordOutput(line);

        if (stream === 'stderr') {
          // Don't spam terminal with stderr in supervisor mode
        } else if (isStreaming) {
          const parsed = parseClaudeStreamEvent(line);
          // Streaming output suppressed — progress reporter handles state updates
          try {
            const event = JSON.parse(line);
            if (event.type === 'result') {
              if (event.total_cost_usd != null) runCostUsd = event.total_cost_usd;
              if (event.duration_ms != null) runDurationSeconds = Math.round(event.duration_ms / 1000 * 100) / 100;
            }
          } catch { /* not JSON */ }
        }
      },
      onPid: (pid) => {
        childPid = pid;
        updateRunPid(db, run.id, pid);
      },
    });

    heartbeat.stop();

    const status: RunStatus = result.exitCode === 0 ? 'completed' : 'failed';
    updateRunFinished(db, run.id, status, result.exitCode, runCostUsd, runDurationSeconds);
    updateTaskStatus(db, task.id, status);

    // Generate report
    const allLogs = getRunLogs(db, run.id);
    const updatedTask = getTaskById(db, task.id)!;
    const updatedRun: Run = {
      ...run,
      status,
      exit_code: result.exitCode,
      finished_at: new Date().toISOString(),
      cost_usd: runCostUsd,
      duration_seconds: runDurationSeconds,
    };
    const reportData = generateReport(updatedTask, updatedRun, allLogs);
    const savedReport = saveReport(db, { run_id: run.id, ...reportData });

    return {
      exitCode: result.exitCode ?? 1,
      runId: run.id,
      report: savedReport,
      cost: runCostUsd,
    };
  } catch (err: any) {
    heartbeat.stop();
    updateRunFinished(db, run.id, 'failed', null);
    updateTaskStatus(db, task.id, 'failed');
    log.error(`Engine error: ${err.message}`);
    return { exitCode: 1, runId: run.id, report: null, cost: null };
  }
}

function mapGoalTypeToTaskType(goalType: string | null): string | null {
  switch (goalType) {
    case 'execute_plan': return 'implement_feature';
    case 'implement': return 'implement_feature';
    case 'debug': return 'debug_fix';
    case 'review': return 'scan_review';
    default: return null;
  }
}

function persistCloseout(db: Database.Database, goal: Goal, totalCost: number): void {
  try {
    const updatedGoal = getGoalById(db, goal.id)!;
    const wps = getWPsByGoal(db, goal.id);
    const attempts = getAttemptsByGoal(db, goal.id);
    const snapshots = getSnapshotsByGoal(db, goal.id);
    const closeout = buildCloseoutSummary({ goal: updatedGoal, wps, attempts, snapshots, totalCost });
    updateGoalCloseout(db, goal.id, JSON.stringify(closeout));
  } catch (err: any) {
    log.error(`Failed to generate closeout: ${err.message}`);
  }
}
