/**
 * Resume context selection layer.
 *
 * Two responsibilities:
 * 1. selectBestRun — pick the best previous run to resume from
 * 2. buildResumeContext — extract typed context sections from that run's report
 *
 * This layer does NOT build prompts — that's the prompt layer's job.
 */

import type { Run, RunReport, TaskType } from '../../types/index.js';

export interface ResumeSection {
  label: string;
  content: string;
}

export interface ResumeContext {
  sourceRun: Run;
  taskType: TaskType | null;
  sections: ResumeSection[];
  quality: 'full' | 'partial' | 'limited';
}

/**
 * Pick the best previous run to resume from.
 *
 * Priority:
 * 1. Most recent completed run with a usable report
 * 2. Most recent failed run with a usable report
 * 3. Most recent run with any report (even sparse)
 * 4. null — no usable context
 *
 * Runs are expected to be sorted by started_at DESC (most recent first).
 */
export function selectBestRun(
  runs: Run[],
  getReport: (runId: string) => RunReport | undefined,
): { run: Run; report: RunReport | undefined } | null {
  if (runs.length === 0) return null;

  // Pass 1: completed run with usable report
  for (const run of runs) {
    if (run.status === 'completed') {
      const report = getReport(run.id);
      if (report && hasUsableContent(report)) {
        return { run, report };
      }
    }
  }

  // Pass 2: failed run with usable report
  for (const run of runs) {
    if (run.status === 'failed') {
      const report = getReport(run.id);
      if (report && hasUsableContent(report)) {
        return { run, report };
      }
    }
  }

  // Pass 3: any run with any report
  for (const run of runs) {
    const report = getReport(run.id);
    if (report) {
      return { run, report };
    }
  }

  return null;
}

/**
 * Build typed context sections from a run's report.
 *
 * Extracts ONLY the fields relevant to the task type.
 * Returns structured sections ready for prompt rendering.
 */
export function buildResumeContext(
  sourceRun: Run,
  report: RunReport | undefined,
  taskType: TaskType | null,
): ResumeContext {
  if (!report) {
    return {
      sourceRun,
      taskType,
      sections: [{ label: 'Previous run', content: `Status: ${sourceRun.status}, exit code: ${sourceRun.exit_code ?? 'unknown'}` }],
      quality: 'limited',
    };
  }

  const sections: ResumeSection[] = [];

  // Always include summary
  if (report.summary) {
    sections.push({ label: 'Previous run summary', content: report.summary });
  }

  // Task-type-specific sections
  switch (taskType) {
    case 'scan_review':
      addIfPresent(sections, 'Findings from previous run', report.findings);
      addIfPresent(sections, 'Risks identified', report.risks);
      addIfPresent(sections, 'Recommendations', report.recommendations);
      addFileList(sections, 'Files inspected previously', report.files_inspected_json);
      break;

    case 'debug_fix':
      addIfPresent(sections, 'Previous root cause', report.root_cause);
      addIfPresent(sections, 'Previous fix applied', report.fix_applied);
      addFileList(sections, 'Files changed', report.files_changed_json);
      addIfPresent(sections, 'Verification', report.verification_notes);
      addIfPresent(sections, 'Remaining risks', report.remaining_risks);
      break;

    case 'implement_feature':
      addIfPresent(sections, 'What was implemented', report.what_implemented);
      addFileList(sections, 'Files changed', report.files_changed_json);
      addIfPresent(sections, 'Validation', report.verification_notes);
      addIfPresent(sections, 'Follow-up notes', report.follow_ups);
      break;

    default:
      // Generic: include whatever exists
      addFileList(sections, 'Files inspected', report.files_inspected_json);
      addFileList(sections, 'Files changed', report.files_changed_json);
      addIfPresent(sections, 'Verification', report.verification_notes);
      break;
  }

  // Always include final_output if it exists and adds information
  addIfPresent(sections, 'Final output from previous run', report.final_output);

  // Determine context quality
  const quality = determineQuality(report, taskType);

  return { sourceRun, taskType, sections, quality };
}

// ---- Helpers ----

function hasUsableContent(report: RunReport): boolean {
  return !!(
    report.summary ||
    report.findings ||
    report.root_cause ||
    report.what_implemented ||
    report.final_output
  );
}

function addIfPresent(sections: ResumeSection[], label: string, content: string | null): void {
  if (content) {
    sections.push({ label, content });
  }
}

function addFileList(sections: ResumeSection[], label: string, json: string | null): void {
  if (!json) return;
  try {
    const files = JSON.parse(json);
    if (Array.isArray(files) && files.length > 0) {
      sections.push({ label, content: files.map((f: string) => `- ${f}`).join('\n') });
    }
  } catch { /* ignore */ }
}

function determineQuality(report: RunReport, taskType: TaskType | null): 'full' | 'partial' | 'limited' {
  switch (taskType) {
    case 'scan_review':
      if (report.findings || report.recommendations) return 'full';
      if (report.final_output || report.summary) return 'partial';
      return 'limited';
    case 'debug_fix':
      if (report.root_cause || report.fix_applied) return 'full';
      if (report.final_output || report.summary) return 'partial';
      return 'limited';
    case 'implement_feature':
      if (report.what_implemented) return 'full';
      if (report.final_output || report.summary) return 'partial';
      return 'limited';
    default:
      if (report.final_output || report.summary) return 'partial';
      return 'limited';
  }
}
