import type { Task, Run, RunLog } from '../../types/index.js';

interface ReportData {
  summary: string;
  root_cause: string | null;
  fix_applied: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  remaining_risks: string | null;
}

export function generateReport(task: Task, run: Run, logs: RunLog[]): ReportData {
  const duration = run.started_at && run.finished_at
    ? formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
    : 'unknown';

  const stdoutLines = logs.filter(l => l.stream_type === 'stdout').map(l => l.line);
  const stderrLines = logs.filter(l => l.stream_type === 'stderr').map(l => l.line);

  const isFailed = run.status === 'failed' || (run.exit_code !== null && run.exit_code !== 0);

  // Extract file changes from log lines (simple heuristic)
  const fileChanges = extractFileChanges(stdoutLines);

  // Build summary
  let summary: string;
  if (isFailed) {
    const lastErrors = stderrLines.slice(-5).join('\n');
    summary = `Run failed (exit code: ${run.exit_code}, duration: ${duration}).\n\nTask: ${task.raw_input}\n\nLast errors:\n${lastErrors || '(no stderr output)'}`;
  } else {
    const tailLines = stdoutLines.slice(-10).join('\n');
    summary = `Run completed successfully (exit code: 0, duration: ${duration}).\n\nTask: ${task.raw_input}\n\nFinal output:\n${tailLines || '(no stdout output)'}`;
  }

  // Try to extract structured info from logs
  const rootCause = extractPattern(stdoutLines, /(?:root\s*cause|found|issue|problem)[:\s]+(.*)/i);
  const fixApplied = extractPattern(stdoutLines, /(?:fix(?:ed)?|changed|updated|added)[:\s]+(.*)/i);
  const verification = extractPattern(stdoutLines, /(?:test(?:s)?|verif(?:y|ied)|pass(?:es|ing)?)[:\s]+(.*)/i);

  return {
    summary,
    root_cause: rootCause,
    fix_applied: fixApplied,
    files_changed_json: fileChanges.length > 0 ? JSON.stringify(fileChanges) : null,
    verification_notes: verification,
    remaining_risks: null,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function extractFileChanges(lines: string[]): string[] {
  const files = new Set<string>();
  const filePattern = /(?:modified|created|changed|edited|updated|wrote)\s+[`']?([^\s`']+\.[a-z]{1,10})[`']?/gi;
  for (const line of lines) {
    let match;
    while ((match = filePattern.exec(line)) !== null) {
      files.add(match[1]);
    }
  }
  return Array.from(files);
}

function extractPattern(lines: string[], pattern: RegExp): string | null {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return match[1].trim();
  }
  return null;
}
