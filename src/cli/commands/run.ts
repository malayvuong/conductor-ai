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
import { loadConfig } from '../../core/config/service.js';
import type { Run, RunStatus } from '../../types/index.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .option('--engine <engine>', 'Engine to use (claude, codex)')
    .option('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      const db = getDb();
      const config = loadConfig();

      // Resolve path: CLI flag > config default
      const workspacePath = opts.path || config.defaultPath;
      if (!workspacePath) {
        log.error('No workspace path. Use --path or set default: conductor set-path <path>');
        process.exit(1);
      }
      if (!fs.existsSync(workspacePath)) {
        log.error(`Workspace path does not exist: ${workspacePath}`);
        process.exit(1);
      }
      opts.path = workspacePath;

      // Resolve engine: CLI flag > config default
      const engineName = opts.engine || config.defaultEngine;
      if (!engineName) {
        log.error('No engine specified. Use --engine or set defaultEngine in config.');
        process.exit(1);
      }
      const validEngines = ['claude', 'codex'];
      if (!validEngines.includes(engineName)) {
        log.error(`Unknown engine: ${engineName}. Available: ${validEngines.join(', ')}`);
        process.exit(1);
      }
      opts.engine = engineName;

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
      log.info(`  Command:   ${command.executable} ${command.args.join(' ')}${command.stdin ? ' (prompt via stdin)' : ''}`);
      log.info(`  CWD:       ${opts.path}`);
      log.info(`  Prompt:    ${promptFinal.length} chars`);
      log.debug(`  Preview:   ${promptFinal.slice(0, 200).replace(/\n/g, '\\n')}...`);
      appendRunLog(db, run.id, 'system', `engine=${opts.engine} cwd=${opts.path} prompt_len=${promptFinal.length}`);
      console.log('');

      // Start heartbeat (use config overrides if set)
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
