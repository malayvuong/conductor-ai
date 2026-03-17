import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { getRunLogs } from '../../core/storage/repository.js';
import { findRunByPrefix } from '../../utils/lookup.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <runId>')
    .description('View logs for a run')
    .option('--tail <n>', 'Show last N lines', '0')
    .option('--stream <type>', 'Filter by stream type (stdout, stderr)')
    .action(async (runId: string, opts) => {
      const db = getDb();

      // Support short IDs
      const run = findRunByPrefix(db, runId);
      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      let logs = getRunLogs(db, run.id);

      if (opts.stream) {
        logs = logs.filter(l => l.stream_type === opts.stream);
      }

      const tail = parseInt(opts.tail, 10);
      if (tail > 0) {
        logs = logs.slice(-tail);
      }

      if (logs.length === 0) {
        console.log('No logs found.');
        return;
      }

      for (const entry of logs) {
        const prefix = entry.stream_type === 'stderr' ? '[ERR] ' : '';
        console.log(`${entry.seq.toString().padStart(5)} ${prefix}${entry.line}`);
      }

      console.log(`\n--- ${logs.length} lines ---`);
    });
}
