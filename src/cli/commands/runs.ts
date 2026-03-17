import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { listRuns, getTaskById } from '../../core/storage/repository.js';
import { findRunByPrefix, findTaskByPrefix } from '../../utils/lookup.js';

export function registerRunsCommand(program: Command): void {
  const runsCmd = program
    .command('runs')
    .description('List and inspect runs')
    .option('--task <taskId>', 'Filter by task ID (prefix)')
    .option('--status <status>', 'Filter by status (queued, running, completed, failed)')
    .option('--engine <engine>', 'Filter by engine (claude, codex)')
    .action(async (opts: { task?: string; status?: string; engine?: string }) => {
      const db = getDb();

      // Resolve task ID prefix if provided
      let taskId: string | undefined;
      if (opts.task) {
        const task = findTaskByPrefix(db, opts.task);
        if (!task) {
          console.error(`Task not found: ${opts.task}`);
          process.exit(1);
        }
        taskId = task.id;
      }

      const runs = listRuns(db, {
        task_id: taskId,
        status: opts.status,
        engine: opts.engine,
      });

      if (runs.length === 0) {
        console.log('No runs found.');
        return;
      }

      for (const r of runs) {
        const shortId = r.id.slice(0, 8);
        const taskShort = r.task_id.slice(0, 8);
        const cost = r.cost_usd != null ? `$${r.cost_usd.toFixed(4)}` : '';
        const duration = r.duration_seconds != null ? `${r.duration_seconds}s` : '';
        const meta = [cost, duration].filter(Boolean).join(' ');
        const metaStr = meta ? ` (${meta})` : '';
        console.log(`[${shortId}] ${r.status.padEnd(10)} ${r.engine.padEnd(8)} task:${taskShort}${metaStr}`);
      }
    });

  // Subcommand: cdx runs show <runId>
  runsCmd
    .command('show <runId>')
    .description('Show detailed metadata for a run')
    .action(async (runId: string) => {
      const db = getDb();

      const run = findRunByPrefix(db, runId);
      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      // Get task for task_type and workspace_path
      const task = getTaskById(db, run.task_id);
      const taskType = task?.task_type || 'unknown';
      const workspacePath = task?.workspace_path || 'unknown';

      // Duration
      let duration = '—';
      if (run.started_at && run.finished_at) {
        const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
        const secs = Math.floor(ms / 1000);
        if (secs < 60) duration = `${secs}s`;
        else duration = `${Math.floor(secs / 60)}m ${secs % 60}s`;
      } else if (run.duration_seconds != null) {
        const secs = Math.floor(run.duration_seconds);
        if (secs < 60) duration = `${secs}s`;
        else duration = `${Math.floor(secs / 60)}m ${secs % 60}s`;
      }

      console.log('=== Run Details ===');
      console.log(`Run ID:              ${run.id}`);
      console.log(`Task ID:             ${run.task_id}`);
      if (run.resumed_from_run_id) {
        console.log(`Resumed from:        ${run.resumed_from_run_id}`);
      }
      console.log(`Engine:              ${run.engine}`);
      console.log(`Task type:           ${taskType}`);
      console.log(`CWD:                 ${workspacePath}`);
      console.log(`Status:              ${run.status}`);
      console.log(`Exit code:           ${run.exit_code ?? '—'}`);
      console.log(`Duration:            ${duration}`);
      console.log(`Prompt length:       ${run.prompt_final.length} chars`);
      if (run.cost_usd != null) {
        console.log(`Cost:                $${run.cost_usd.toFixed(4)}`);
      }
      if (run.duration_seconds != null) {
        console.log(`Engine duration:     ${run.duration_seconds}s`);
      }
      console.log(`PID:                 ${run.pid ?? '—'}`);
      console.log(`Started at:          ${run.started_at ?? '—'}`);
      console.log(`Finished at:         ${run.finished_at ?? '—'}`);
    });
}
