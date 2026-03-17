import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import {
  createTask, updateTaskNormalized, updateTaskStatus,
  createRun, updateRunStarted, updateRunPid, updateRunFinished,
  appendRunLog,
} from '../../core/storage/repository.js';
import { normalizeTask } from '../../core/task/normalizer.js';
import { buildPrompt } from '../../core/prompt/builder.js';
import { getEngine } from '../../core/engine/types.js';
import { runProcess } from '../../core/runner/process.js';
import { log } from '../../utils/logger.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a task with an AI engine')
    .requiredOption('--engine <engine>', 'Engine to use (claude, codex)')
    .requiredOption('--path <path>', 'Workspace path')
    .requiredOption('--task <task>', 'Task description')
    .action(async (opts) => {
      const db = getDb();

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

      log.info('Starting engine process...');
      console.log('');

      try {
        const result = await runProcess(command, {
          onLine: (stream, line) => {
            appendRunLog(db, run.id, stream, line);
            const prefix = stream === 'stderr' ? '[ERR] ' : '';
            console.log(`${prefix}${line}`);
          },
          onPid: (pid) => {
            updateRunPid(db, run.id, pid);
            log.info(`Process started with PID: ${pid}`);
          },
        });

        // 8. Finalize
        const status = result.exitCode === 0 ? 'completed' : 'failed';
        updateRunFinished(db, run.id, status, result.exitCode);
        updateTaskStatus(db, task.id, status);

        console.log('');
        log.info(`Run finished with exit code: ${result.exitCode}`);
        log.info(`Run ID: ${run.id.slice(0, 8)}`);
        log.info(`Status: ${status}`);
      } catch (err: any) {
        updateRunFinished(db, run.id, 'failed', null);
        updateTaskStatus(db, task.id, 'failed');
        log.error(`Process error: ${err.message}`);
        process.exit(1);
      }
    });
}
