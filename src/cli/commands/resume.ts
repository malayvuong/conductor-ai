import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import {
  getRunsByTaskId, getRunLogs, getReportByRunId,
  createRun, updateTaskStatus, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, createHeartbeat, saveReport, getTaskById,
} from '../../core/storage/repository.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { HeartbeatMonitor } from '../../core/heartbeat/monitor.js';
import { generateReport } from '../../core/report/generator.js';
import { selectBestRun, buildResumeContext } from '../../core/resume/context.js';
import { renderResumePrompt } from '../../core/resume/prompt.js';
import { findTaskByPrefix } from '../../utils/lookup.js';
import { log } from '../../utils/logger.js';
import { loadConfig } from '../../core/config/service.js';
import { parseClaudeStreamEvent } from '../../core/engine/stream-parser.js';
import type { Task, Run, RunStatus, TaskType } from '../../types/index.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume <taskId>')
    .description('Resume a task with curated context from previous runs')
    .option('--task <task>', 'New instruction for this run')
    .option('--engine <engine>', 'Override engine (default: reuse from task)')
    .option('--path <path>', 'Override workspace path (default: reuse from task)')
    .action(async (taskId: string, opts: { task?: string; engine?: string; path?: string }) => {
      const db = getDb();
      const config = loadConfig();

      // 1. Find task
      const task = findTaskByPrefix(db, taskId);
      if (!task) {
        console.error(`Task not found: ${taskId}`);
        process.exit(1);
      }

      // 2. Select best previous run
      const prevRuns = getRunsByTaskId(db, task.id);
      if (prevRuns.length === 0) {
        console.error('No previous runs found for this task.');
        process.exit(1);
      }

      const best = selectBestRun(prevRuns, (runId) => getReportByRunId(db, runId));
      if (!best) {
        console.error('No usable previous run found (all runs have no report or context).');
        process.exit(1);
      }

      // 3. Build typed context from best run's report
      const taskType = (task.task_type as TaskType | null) || null;
      const context = buildResumeContext(best.run, best.report, taskType);

      // 4. Resolve engine and path (override or reuse from task)
      const engineName = opts.engine || task.engine;
      const workspacePath = opts.path || task.workspace_path;

      // 5. Render resume prompt
      const resumePrompt = renderResumePrompt({
        task,
        context,
        newInstruction: opts.task || null,
        workspacePath,
      });

      // 6. Show clear terminal output
      log.info(`Resuming task: ${task.id.slice(0, 8)}`);
      log.info(`Using previous run: ${best.run.id.slice(0, 8)} (${best.run.status})`);
      log.info(`Task type: ${taskType || 'generic'}`);
      log.info(`Context quality: ${context.quality}`);
      log.info(`Context sections used:`);
      for (const section of context.sections) {
        log.info(`  - ${section.label}`);
      }
      if (opts.task) {
        log.info(`New instruction: ${opts.task}`);
      }
      console.log('');

      // 7. Get engine adapter
      const engine = getEngine(engineName);
      if (!engine.validateExecutable()) {
        log.error(`Engine executable '${engineName}' not found in PATH`);
        process.exit(1);
      }

      const command = engine.buildCommand({
        prompt: resumePrompt,
        workspacePath,
      });

      // 8. Create new run with linkage
      const run = createRun(db, {
        task_id: task.id,
        engine: engineName,
        command: command.executable,
        args_json: JSON.stringify(command.args),
        prompt_final: resumePrompt,
        resumed_from_run_id: best.run.id,
      });

      updateTaskStatus(db, task.id, 'running');
      updateRunStarted(db, run.id);

      log.info(`Run created: ${run.id.slice(0, 8)}`);
      log.info(`  Engine:    ${engineName}`);
      log.info(`  Command:   ${command.executable}`);
      log.info(`  CWD:       ${workspacePath}`);
      log.info(`  Prompt:    ${resumePrompt.length} chars`);
      appendRunLog(db, run.id, 'system',
        `engine=${engineName} cwd=${workspacePath} prompt_len=${resumePrompt.length} resume=true resumed_from=${best.run.id.slice(0, 8)}`
      );

      // 9. Execute
      const heartbeatInterval = (config.heartbeatIntervalSec || 15) * 1000;
      const stuckThreshold = config.stuckThresholdSec || 60;
      const heartbeat = new HeartbeatMonitor({
        intervalMs: heartbeatInterval,
        stuckThresholdSeconds: stuckThreshold,
        onHeartbeat: (status, summary, noOutputSeconds) => {
          createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
          if (status === 'suspected_stuck') {
            log.error(`No output for ${Math.round(noOutputSeconds)}s — engine may be processing`);
          } else if (status === 'recovered') {
            log.info('Output resumed');
          }
        },
      });
      heartbeat.start();

      let childPid: number | undefined;
      const cleanup = () => {
        if (childPid) {
          try { process.kill(childPid, 'SIGTERM'); } catch {}
        }
        heartbeat.stop();
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.info('Run interrupted by user');
        process.exit(130);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      const isStreaming = engine.streaming;
      let runCostUsd: number | null = null;
      let runDurationSeconds: number | null = null;

      try {
        const result = await runProcess(command, {
          cwd: workspacePath,
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            heartbeat.recordOutput(line);

            if (stream === 'stderr') {
              console.log(`[ERR] ${line}`);
            } else if (isStreaming) {
              const parsed = parseClaudeStreamEvent(line);
              if (parsed.display) {
                console.log(parsed.display);
              }
              try {
                const event = JSON.parse(line);
                if (event.type === 'result') {
                  if (event.total_cost_usd != null) runCostUsd = event.total_cost_usd;
                  if (event.duration_ms != null) runDurationSeconds = Math.round(event.duration_ms / 1000 * 100) / 100;
                }
              } catch { /* not JSON */ }
            } else {
              console.log(line);
            }
          },
          onPid: (pid) => {
            childPid = pid;
            updateRunPid(db, run.id, pid);
          },
        });

        heartbeat.stop();
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);

        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode, runCostUsd, runDurationSeconds);
        updateTaskStatus(db, task.id, status);

        // Generate report for this run
        const allLogs = getRunLogs(db, run.id);
        const updatedTask = getTaskById(db, task.id)!;
        const updatedRun: Run = {
          ...run,
          status: status as RunStatus,
          exit_code: result.exitCode,
          finished_at: new Date().toISOString(),
        };
        const reportData = generateReport(updatedTask, updatedRun, allLogs);
        saveReport(db, { run_id: run.id, ...reportData });

        console.log('');
        log.info(`Resume run finished. Exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
        log.info(`Status: ${status}`);
        log.info(`View report: cdx report ${run.id.slice(0, 8)}`);
      } catch (err: any) {
        heartbeat.stop();
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
