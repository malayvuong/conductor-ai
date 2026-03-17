import { Command } from 'commander';
import { getDb } from '../../core/storage/db.js';
import { getReportByRunId } from '../../core/storage/repository.js';
import { findRunByPrefix } from '../../utils/lookup.js';
import type { RunReport } from '../../types/index.js';

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

      // Get task_type for display branching
      const task = db.prepare('SELECT task_type FROM tasks WHERE id = ?').get(run.task_id) as
        { task_type: string | null } | undefined;
      const taskType = task?.task_type || null;

      console.log('=== Run Report ===');
      console.log(`Run: ${run.id.slice(0, 8)}`);
      console.log(`Engine: ${run.engine}`);
      console.log(`Status: ${run.status}`);
      console.log(`Exit Code: ${run.exit_code}`);
      console.log('');

      switch (taskType) {
        case 'scan_review':
          renderScanReview(report);
          break;
        case 'debug_fix':
          renderDebugFix(report);
          break;
        case 'implement_feature':
          renderImplementFeature(report);
          break;
        default:
          renderGeneric(report);
      }
    });
}

/**
 * scan_review: Summary, Findings, Risks, Recommendations, Files Inspected.
 * NO: Root Cause, Fix Applied, Files Changed, Verification.
 */
function renderScanReview(report: RunReport): void {
  section('Summary', report.summary);
  section('Findings', report.findings);
  section('Risks', report.risks);
  section('Recommendations', report.recommendations);
  fileList('Files Inspected', report.files_inspected_json);
}

/**
 * debug_fix: Summary, Root Cause, Fix Applied, Files Changed, Verification, Remaining Risks.
 * NO: Findings, Recommendations, Files Inspected.
 */
function renderDebugFix(report: RunReport): void {
  section('Summary', report.summary);
  section('Root Cause', report.root_cause);
  section('Fix Applied', report.fix_applied);
  fileList('Files Changed', report.files_changed_json);
  section('Verification', report.verification_notes);
  section('Remaining Risks', report.remaining_risks);
}

/**
 * implement_feature: Summary, What Was Implemented, Files Changed, Validation, Follow-up Notes.
 * NO: Root Cause, Fix Applied, Findings.
 */
function renderImplementFeature(report: RunReport): void {
  section('Summary', report.summary);
  section('What Was Implemented', report.what_implemented);
  fileList('Files Changed', report.files_changed_json);
  section('Validation', report.verification_notes);
  section('Follow-up Notes', report.follow_ups);
}

function renderGeneric(report: RunReport): void {
  section('Summary', report.summary);
  fileList('Files Inspected', report.files_inspected_json);
  fileList('Files Changed', report.files_changed_json);
  section('Verification', report.verification_notes);
}

function section(title: string, content: string | null): void {
  if (!content) return;
  console.log(`\n--- ${title} ---`);
  console.log(content);
}

function fileList(title: string, json: string | null): void {
  if (!json) return;
  try {
    const files = JSON.parse(json);
    if (!Array.isArray(files) || files.length === 0) return;
    console.log(`\n--- ${title} ---`);
    for (const f of files) console.log(`  - ${f}`);
  } catch { /* ignore parse errors */ }
}
