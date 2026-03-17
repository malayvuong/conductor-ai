import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import {
  getRunsByTaskId, getRunLogs, getReportByRunId,
  createRun, updateTaskStatus, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, createHeartbeat, saveReport,
} from '../../core/storage/repository.js';
import { buildPrompt } from '../../core/prompt/builder.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { HeartbeatMonitor } from '../../core/heartbeat/monitor.js';
import { generateReport } from '../../core/report/generator.js';
import { findTaskByPrefix } from '../../utils/lookup.js';
import { log } from '../../utils/logger.js';
import type { Task, Run, RunStatus } from '../../types/index.js';

export function registerResumeCommand(program: Command): void {
  program
    .command('resume <taskId>')
    .description('Resume a task with context from previous runs')
    .action(async (taskId: string) => {
      const db = getDb();

      // Find task (support short ID)
      const task = findTaskByPrefix(db, taskId);
      if (!task) {
        console.error(`Task not found: ${taskId}`);
        process.exit(1);
      }

      // Get previous runs
      const prevRuns = getRunsByTaskId(db, task.id);
      if (prevRuns.length === 0) {
        console.error('No previous runs found for this task.');
        process.exit(1);
      }

      // Build context summary from last run
      const lastRun = prevRuns[0];
      const lastReport = getReportByRunId(db, lastRun.id);
      const lastLogs = getRunLogs(db, lastRun.id);
      const logTail = lastLogs.slice(-20).map(l => l.line).join('\n');

      const previousContext = [
        `## Previous Run Summary`,
        `Status: ${lastRun.status}`,
        `Exit code: ${lastRun.exit_code}`,
        lastReport ? `Report: ${lastReport.summary}` : '',
        `\n## Last 20 log lines:\n${logTail}`,
      ].filter(Boolean).join('\n');

      // Build new prompt with resume context
      const resumePrompt = [
        buildPrompt({
          engine: task.engine,
          task_type: task.task_type || 'debug_fix',
          variables: {
            workspace_path: task.workspace_path,
            raw_input: task.raw_input,
          },
        }),
        '\n---\n',
        '## Context from previous attempt\n',
        previousContext,
        '\n\nPlease continue from where the previous run left off. Focus on what remains to be done.',
      ].join('\n');

      log.info(`Resuming task: ${task.id.slice(0, 8)}`);
      log.info(`Previous runs: ${prevRuns.length}`);

      // Get engine
      const engine = getEngine(task.engine);
      const command = engine.buildCommand({
        prompt: resumePrompt,
        workspacePath: task.workspace_path,
      });

      // Create new run
      const run = createRun(db, {
        task_id: task.id,
        engine: task.engine,
        command: command.executable,
        args_json: JSON.stringify(command.args),
        prompt_final: resumePrompt,
      });

      updateTaskStatus(db, task.id, 'running');
      updateRunStarted(db, run.id);

      // Log execution details
      log.info(`  Engine:    ${task.engine}`);
      log.info(`  Command:   ${command.executable}`);
      log.info(`  CWD:       ${task.workspace_path}`);
      log.info(`  Prompt:    ${resumePrompt.length} chars`);
      appendRunLog(db, run.id, 'system', `engine=${task.engine} cwd=${task.workspace_path} prompt_len=${resumePrompt.length} resume=true`);

      const heartbeat = new HeartbeatMonitor({
        intervalMs: 15000,
        stuckThresholdSeconds: 60,
        onHeartbeat: (status, summary, noOutputSeconds) => {
          createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
          if (status === 'suspected_stuck') {
            log.error(`⚠ Suspected stuck: no output for ${Math.round(noOutputSeconds)}s`);
          }
        },
      });
      heartbeat.start();

      try {
        const result = await runProcess(command, {
          cwd: task.workspace_path,
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            heartbeat.recordOutput(line);
            const prefix = stream === 'stderr' ? '[ERR] ' : '';
            console.log(`${prefix}${line}`);
          },
          onPid: (pid) => {
            updateRunPid(db, run.id, pid);
          },
        });

        heartbeat.stop();

        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode);
        updateTaskStatus(db, task.id, status);

        const allLogs = getRunLogs(db, run.id);
        const updatedTask = { ...task, status } as Task;
        const updatedRun: Run = {
          ...run,
          status: status as RunStatus,
          exit_code: result.exitCode,
          finished_at: new Date().toISOString(),
        };
        const reportData = generateReport(updatedTask, updatedRun, allLogs);
        saveReport(db, { run_id: run.id, ...reportData });

        log.info(`Resume run finished. Exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
      } catch (err: any) {
        heartbeat.stop();
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
