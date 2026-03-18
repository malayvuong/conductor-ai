/**
 * Progress detector — determines if a run made real progress.
 *
 * Progress = observable state change, not just "agent produced output."
 * Without this, the supervisor loop would be a dumb retry machine.
 */

import type { RunReport } from '../../types/index.js';
import type { Snapshot } from '../../types/supervisor.js';

export interface ProgressResult {
  hasProgress: boolean;
  filesChanged: number;
  filesInspected: number;
  indicators: string[];
}

/**
 * Detect whether a run made real progress toward the goal.
 */
export function detectProgress(
  report: RunReport | null,
  previousSnapshot: Snapshot | null,
): ProgressResult {
  const indicators: string[] = [];
  let filesChanged = 0;
  let filesInspected = 0;

  if (!report) {
    return { hasProgress: false, filesChanged: 0, filesInspected: 0, indicators: ['No report'] };
  }

  // 1. Files changed (strongest signal)
  const changed = safeParseArray(report.files_changed_json);
  filesChanged = changed.length;
  if (filesChanged > 0) {
    indicators.push(`${filesChanged} files changed`);
  }

  // 2. Files inspected (weaker but still progress if new)
  const inspected = safeParseArray(report.files_inspected_json);
  filesInspected = inspected.length;

  // Check if new files were inspected compared to previous snapshot
  if (previousSnapshot) {
    const prevFiles = new Set(safeParseArray(previousSnapshot.related_files));
    const newFiles = [...changed, ...inspected].filter(f => !prevFiles.has(f));
    if (newFiles.length > 0) {
      indicators.push(`${newFiles.length} new files touched`);
    }
  } else if (filesInspected > 0) {
    indicators.push(`${filesInspected} files inspected`);
  }

  // 3. Structured report fields populated (agent produced useful analysis)
  if (report.findings) indicators.push('Findings produced');
  if (report.root_cause) indicators.push('Root cause identified');
  if (report.fix_applied) indicators.push('Fix applied');
  if (report.what_implemented) indicators.push('Implementation described');
  if (report.verification_notes) indicators.push('Verification performed');

  // 4. Summary indicates completion keywords
  if (report.summary) {
    const lower = report.summary.toLowerCase();
    if (lower.includes('completed') || lower.includes('done') || lower.includes('finished')) {
      indicators.push('Summary indicates completion');
    }
    if (lower.includes('test') && lower.includes('pass')) {
      indicators.push('Tests passing');
    }
  }

  // 5. Final output exists (agent produced substantial response)
  if (report.final_output && report.final_output.length > 100) {
    indicators.push('Substantial final output');
  }

  const hasProgress = indicators.length > 0;
  return { hasProgress, filesChanged, filesInspected, indicators };
}

/**
 * Determine the prompt strategy based on retry count.
 */
export function determineStrategy(retryCount: number): 'normal' | 'focused' | 'surgical' | 'recovery' {
  if (retryCount === 0) return 'normal';
  if (retryCount === 1) return 'focused';
  if (retryCount === 2) return 'surgical';
  return 'recovery';
}

/**
 * Check if a report indicates the WP is completed.
 *
 * Completion signal sources (any one is sufficient):
 *   - Report header: "completed successfully" / "exit code: 0"
 *   - Summary text contains: "completed", "done", "finished"
 *     (same keywords detectProgress uses — these may come from
 *     the engine's own output appended to the summary)
 *   - final_output contains "## Status ... completed"
 *
 * For ad-hoc tasks (requireEvidence=true), a completion signal alone
 * is not enough — we also need observable evidence that the engine
 * actually did work (files changed/inspected, fix applied,
 * verification, implementation, substantial output, or findings).
 */
export function isWPCompleted(report: RunReport | null, requireEvidence = false): boolean {
  if (!report) return false;

  let hasCompletionSignal = false;

  // Check summary for completion signals — broad match, same as detectProgress
  if (report.summary) {
    const lower = report.summary.toLowerCase();
    if (lower.includes('completed') || lower.includes('done') || lower.includes('finished')
        || lower.includes('exit code: 0')) {
      hasCompletionSignal = true;
    }
  }

  // Check final_output for explicit status
  if (report.final_output) {
    if (/##\s*status[\s\S]*completed/i.test(report.final_output)) {
      hasCompletionSignal = true;
    }
  }

  if (!hasCompletionSignal) return false;

  // For ad-hoc tasks: require observable evidence beyond just saying "completed"
  if (requireEvidence) {
    const hasFilesChanged = report.files_changed_json ? safeParseArray(report.files_changed_json).length > 0 : false;
    const hasFilesInspected = report.files_inspected_json ? safeParseArray(report.files_inspected_json).length > 0 : false;
    const hasFixApplied = !!report.fix_applied;
    const hasVerification = !!report.verification_notes;
    const hasImplementation = !!report.what_implemented;
    const hasSubstantialOutput = !!report.final_output && report.final_output.length > 100;
    const hasFindings = !!report.findings;

    return hasFilesChanged || hasFilesInspected || hasFixApplied
      || hasVerification || hasImplementation || hasSubstantialOutput || hasFindings;
  }

  return true;
}

/**
 * Check if a report indicates a hard blocker.
 */
export function detectHardBlocker(report: RunReport | null): { isHard: boolean; detail: string } | null {
  if (!report) return null;

  const text = [report.summary, report.final_output, report.remaining_risks]
    .filter(Boolean).join('\n').toLowerCase();

  // Hard blocker patterns
  const hardPatterns = [
    { pattern: /permission\s+denied/i, detail: 'Permission denied' },
    { pattern: /file\s+not\s+found.*critical/i, detail: 'Critical file not found' },
    { pattern: /cannot\s+proceed/i, detail: 'Cannot proceed' },
    { pattern: /destructive\s+action/i, detail: 'Destructive action needs approval' },
    { pattern: /breaking\s+change/i, detail: 'Breaking change needs approval' },
    { pattern: /spec.*contradict/i, detail: 'Specification contradiction' },
  ];

  for (const { pattern, detail } of hardPatterns) {
    if (pattern.test(text)) {
      return { isHard: true, detail };
    }
  }

  return null;
}

function safeParseArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
