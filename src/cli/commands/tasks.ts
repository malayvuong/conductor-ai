import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { listTasks } from '../../core/storage/repository.js';

export function registerTasksCommand(program: Command): void {
  program
    .command('tasks')
    .description('List all tasks')
    .option('--status <status>', 'Filter by status (created, running, completed, failed)')
    .option('--engine <engine>', 'Filter by engine (claude, codex)')
    .action(async (opts: { status?: string; engine?: string }) => {
      const db = getDb();
      const tasks = listTasks(db, {
        status: opts.status,
        engine: opts.engine,
      });
      if (tasks.length === 0) {
        console.log('No tasks found.');
        return;
      }
      for (const t of tasks) {
        const shortId = t.id.slice(0, 8);
        console.log(`[${shortId}] ${t.status.padEnd(10)} ${t.engine.padEnd(8)} ${t.raw_input.slice(0, 60)}`);
      }
    });
}
