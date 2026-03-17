import { Command } from 'commander';
import fs from 'node:fs';
import { getDb } from '../../core/storage/db.js';
import {
  createTask, updateTaskNormalized, updateTaskStatus,
  createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog, saveReport, getRunLogs, getTaskById, createHeartbeat,
} from '../../core/storage/repository.js';
import { normalizeTask } from '../../core/task/normalizer.js';
import { buildPrompt } from '../../core/prompt/builder.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { HeartbeatMonitor } from '../../core/heartbeat/monitor.js';
import { log } from '../../utils/logger.js';
import { generateReport } from '../../core/report/generator.js';
import type { Run, RunStatus } from '../../types/index.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .requiredOption('--engine <engine>', 'Engine to use (claude, codex)')
    .requiredOption('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      const db = getDb();

      // Validate path exists
      if (!fs.existsSync(opts.path)) {
        log.error(`Workspace path does not exist: ${opts.path}`);
        process.exit(1);
      }

      // Validate engine name
      const validEngines = ['claude', 'codex'];
      if (!validEngines.includes(opts.engine)) {
        log.error(`Unknown engine: ${opts.engine}. Available: ${validEngines.join(', ')}`);
        process.exit(1);
      }

      // 1. Create task
      const task = createTask(db, {
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      log.info(`Task created: ${task.id.slice(0, 8)}`);

      // 2. Normalize
      const normalized = normalizeTask({
        raw_input: opts.task,
        workspace_path: opts.path,
        engine: opts.engine,
      });
      updateTaskNormalized(db, task.id, normalized.task_type, JSON.stringify(normalized));
      log.info(`Task type: ${normalized.task_type}`);

      // 3. Build prompt
      const promptFinal = buildPrompt({
        engine: opts.engine,
        task_type: normalized.task_type,
        variables: {
          workspace_path: opts.path,
          raw_input: opts.task,
        },
      });
      log.info(`Prompt built (${promptFinal.length} chars)`);

      // 4. Get engine adapter
      const engine = getEngine(opts.engine);
      if (!engine.validateExecutable()) {
        log.error(`Engine executable '${opts.engine}' not found in PATH`);
        updateTaskStatus(db, task.id, 'failed');
        process.exit(1);
      }

      // 5. Build command
      const command = engine.buildCommand({
        prompt: promptFinal,
        workspacePath: opts.path,
      });

      // 6. Create run record
      const run = createRun(db, {
        task_id: task.id,
        engine: opts.engine,
        command: command.executable,
        args_json: JSON.stringify(command.args),
        prompt_final: promptFinal,
      });
      log.info(`Run created: ${run.id.slice(0, 8)}`);

      // 7. Execute
      updateTaskStatus(db, task.id, 'running');
      updateRunStarted(db, run.id);

      // Log execution details
      log.info('Starting engine process...');
      log.info(`  Engine:    ${opts.engine}`);
      log.info(`  Command:   ${command.executable} ${command.args.filter(a => a !== (command as any).stdin && a.length < 60).join(' ')}`);
      log.info(`  CWD:       ${opts.path}`);
      log.info(`  Prompt:    ${promptFinal.length} chars`);
      log.debug(`  Preview:   ${promptFinal.slice(0, 200).replace(/\n/g, '\\n')}...`);
      appendRunLog(db, run.id, 'system', `engine=${opts.engine} cwd=${opts.path} prompt_len=${promptFinal.length}`);
      console.log('');

      // Start heartbeat
      const heartbeat = new HeartbeatMonitor({
        intervalMs: 15000, // 15 seconds
        stuckThresholdSeconds: 60,
        onHeartbeat: (status, summary, noOutputSeconds) => {
          createHeartbeat(db, { run_id: run.id, status, summary, no_output_seconds: noOutputSeconds });
          if (status === 'suspected_stuck') {
            log.error(`⚠ Suspected stuck: no output for ${Math.round(noOutputSeconds)}s`);
          }
        },
      });
      heartbeat.start();

      // Handle Ctrl+C gracefully
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

      try {
        const result = await runProcess(command, {
          cwd: opts.path,
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            heartbeat.recordOutput(line);
            const prefix = stream === 'stderr' ? '[ERR] ' : '';
            console.log(`${prefix}${line}`);
          },
          onPid: (pid) => {
            childPid = pid;
            updateRunPid(db, run.id, pid);
            log.info(`Process started with PID: ${pid}`);
          },
        });

        // 8. Finalize
        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode);
        updateTaskStatus(db, task.id, status);
        heartbeat.stop();
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);

        // Generate report
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
        log.info(`Report saved. View with: conductor report ${run.id.slice(0, 8)}`);

        console.log('');
        log.info(`Run finished with exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
        log.info(`Status: ${status}`);
      } catch (err: any) {
        heartbeat.stop();
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
