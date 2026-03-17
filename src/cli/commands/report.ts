import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { getReportByRunId } from '../../core/storage/repository.js';
import { findRunByPrefix } from '../../utils/lookup.js';

export function registerReportCommand(program: Command): void {
  program
    .command('report <runId>')
    .description('View report for a run')
    .action(async (runId: string) => {
      const db = getDb();

      const run = findRunByPrefix(db, runId);
      if (!run) {
        console.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      const report = getReportByRunId(db, run.id);
      if (!report) {
        console.error(`No report found for run: ${run.id.slice(0, 8)}`);
        process.exit(1);
      }

      console.log('=== Run Report ===');
      console.log(`Run: ${run.id.slice(0, 8)}`);
      console.log(`Engine: ${run.engine}`);
      console.log(`Status: ${run.status}`);
      console.log(`Exit Code: ${run.exit_code}`);
      console.log('');
      console.log('--- Summary ---');
      console.log(report.summary);

      if (report.root_cause) {
        console.log('\n--- Root Cause ---');
        console.log(report.root_cause);
      }
      if (report.fix_applied) {
        console.log('\n--- Fix Applied ---');
        console.log(report.fix_applied);
      }
      if (report.files_changed_json) {
        console.log('\n--- Files Changed ---');
        const files = JSON.parse(report.files_changed_json);
        for (const f of files) console.log(`  - ${f}`);
      }
      if (report.verification_notes) {
        console.log('\n--- Verification ---');
        console.log(report.verification_notes);
      }
      if (report.remaining_risks) {
        console.log('\n--- Remaining Risks ---');
        console.log(report.remaining_risks);
      }
    });
}
