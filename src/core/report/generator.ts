import type { Task, Run, RunLog, TaskType } from '../../types/index.js';
import { interpretLogLine, type ParsedRunEvent } from '../engine/log-interpreter.js';
import type { StreamType } from '../../types/index.js';

export interface ReportData {
  summary: string;
  files_inspected_json: string | null;
  files_changed_json: string | null;
  verification_notes: string | null;
  final_output: string | null;
  root_cause: string | null;
  fix_applied: string | null;
  remaining_risks: string | null;
  findings: string | null;
  risks: string | null;
  recommendations: string | null;
  what_implemented: string | null;
  follow_ups: string | null;
}

// Tools that READ/inspect files or gather evidence
const INSPECT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Agent']);
// Tools that MODIFY files (only these count as "changed")
const MUTATE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function generateReport(task: Task, run: Run, logs: RunLog[]): ReportData {
  const duration = run.started_at && run.finished_at
    ? formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
    : 'unknown';

  const isFailed = run.status === 'failed' || (run.exit_code !== null && run.exit_code !== 0);

  // Interpret all log lines into indexed events
  const events: IndexedEvent[] = logs.map((l, i) => ({
    index: i,
    event: interpretLogLine(l.stream_type as StreamType, l.line),
  }));

  // Classify events: main-run vs sub-agent
  const lastToolIndex = findLastToolIndex(events);
  const mainResult = findMainResult(events);

  // Post-tool text = main agent's conclusion (no sub-agent contamination)
  const allTextEvents = events.filter(e => e.event.type === 'text' && e.event.displayText);
  const postToolTextEvents = allTextEvents.filter(e => e.index > lastToolIndex);
  const errorEvents = events.filter(e => e.event.type === 'error' && e.event.displayText);

  // Extract ALL tool_use blocks from raw logs
  const allTools = extractAllToolUses(logs);

  // Separate files by tool semantics
  const filesInspected = new Set<string>();
  const filesChanged = new Set<string>();
  for (const tool of allTools) {
    if (!tool.filePath) continue;
    if (MUTATE_TOOLS.has(tool.toolName)) {
      filesChanged.add(tool.filePath);
    } else if (INSPECT_TOOLS.has(tool.toolName)) {
      filesInspected.add(tool.filePath);
    }
  }

  // Extract the final markdown report block from post-tool text
  const finalOutput = extractFinalReport(postToolTextEvents);

  // Parse structured sections from the final report (no regex on random text)
  const sections = finalOutput ? extractSections(finalOutput) : new Map<string, string>();

  // Extract verification from ALL events (sub-agent test results count as evidence)
  const verification = extractVerification(events);

  // Build summary using post-tool text and main result only
  const summary = buildSummary(
    task, run, duration, isFailed,
    postToolTextEvents.map(e => e.event),
    errorEvents.map(e => e.event),
    mainResult,
    filesInspected.size, filesChanged.size,
  );

  // Map sections to fields based on task_type
  const taskType = task.task_type as TaskType | null;

  return {
    summary,
    files_inspected_json: filesInspected.size > 0 ? JSON.stringify(Array.from(filesInspected)) : null,
    files_changed_json: filesChanged.size > 0 ? JSON.stringify(Array.from(filesChanged)) : null,
    verification_notes: taskType === 'scan_review' ? null : verification,
    final_output: finalOutput,

    // debug_fix — from sections only
    root_cause: taskType === 'debug_fix'
      ? findSection(sections, 'root cause', 'cause', 'problem', 'issue') : null,
    fix_applied: taskType === 'debug_fix'
      ? findSection(sections, 'fix applied', 'fix', 'solution', 'changes made') : null,
    remaining_risks: taskType === 'debug_fix'
      ? findSection(sections, 'remaining risks', 'risks', 'caveats', 'warnings') : null,

    // scan_review — from sections only
    findings: taskType === 'scan_review'
      ? findSection(sections, 'findings', 'key findings', 'issues found', 'observations') : null,
    risks: taskType === 'scan_review'
      ? findSection(sections, 'risks', 'security risks', 'vulnerabilities', 'concerns') : null,
    recommendations: taskType === 'scan_review'
      ? findSection(sections, 'recommendations', 'suggested improvements', 'next steps', 'action items') : null,

    // implement_feature — from sections only
    what_implemented: taskType === 'implement_feature'
      ? findSection(sections, 'implementation', 'what was implemented', 'changes', 'implementation summary') : null,
    follow_ups: taskType === 'implement_feature'
      ? findSection(sections, 'follow-up', 'follow up', 'remaining work', 'todo', 'next steps') : null,
  };
}

// ---- Internal types ----

interface IndexedEvent {
  index: number;
  event: ParsedRunEvent;
}

// ---- Main vs sub-agent separation ----

function findLastToolIndex(events: IndexedEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].event.type;
    if (t === 'tool_use' || t === 'tool_result') {
      return events[i].index;
    }
  }
  return -1;
}

function findMainResult(events: IndexedEvent[]): ParsedRunEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event.type === 'result') {
      return events[i].event;
    }
  }
  return null;
}

// ---- Summary ----

function buildSummary(
  task: Task, run: Run, duration: string, isFailed: boolean,
  mainTextEvents: ParsedRunEvent[], errorEvents: ParsedRunEvent[],
  mainResult: ParsedRunEvent | null,
  inspectedCount: number, changedCount: number,
): string {
  const header = isFailed
    ? `Run failed (exit code: ${run.exit_code}, duration: ${duration}).`
    : `Run completed successfully (exit code: 0, duration: ${duration}).`;

  const parts = [header, `\nTask: ${task.raw_input}`];

  const fileParts: string[] = [];
  if (inspectedCount > 0) fileParts.push(`${inspectedCount} files inspected`);
  if (changedCount > 0) fileParts.push(`${changedCount} files changed`);
  if (fileParts.length > 0) parts.push(`\n${fileParts.join(', ')}.`);

  if (isFailed && errorEvents.length > 0) {
    const lastErrors = errorEvents.slice(-5).map(e => e.displayText).join('\n');
    parts.push(`\nLast errors:\n${lastErrors}`);
  }

  const lastText = mainTextEvents.slice(-3).map(e => e.displayText).join('\n');
  if (lastText) {
    parts.push(`\nFinal output:\n${lastText}`);
  }

  if (mainResult?.displayText) {
    parts.push(`\nResult: ${mainResult.displayText}`);
  }

  return parts.join('\n');
}

// ---- File extraction ----

function extractAllToolUses(logs: RunLog[]): Array<{ toolName: string; filePath: string | null }> {
  const tools: Array<{ toolName: string; filePath: string | null }> = [];
  for (const log of logs) {
    if (log.stream_type !== 'stdout') continue;
    try {
      const event = JSON.parse(log.line);
      if (event.type !== 'assistant') continue;
      const content = event.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          const filePath = block.input?.file_path || block.input?.path || block.input?.filePath || null;
          tools.push({ toolName: block.name, filePath });
        }
      }
    } catch {
      // Not JSON — skip
    }
  }
  return tools;
}

// ---- Final report extraction ----

/**
 * Extract the agent's final markdown report block from post-tool text.
 *
 * Preference order:
 * 1. Last text block with markdown structure (## headers)
 * 2. Last text block >= 200 chars (substantial prose)
 * 3. null
 *
 * This is THE source for structured fields (findings, root_cause, etc.)
 * via section parsing — not random regex on all text.
 */
function extractFinalReport(postToolTextEvents: IndexedEvent[]): string | null {
  // Prefer last block with markdown headers
  for (let i = postToolTextEvents.length - 1; i >= 0; i--) {
    const text = postToolTextEvents[i].event.displayText;
    if (text && hasMarkdownStructure(text)) {
      return text;
    }
  }
  // Fallback: last substantial block
  for (let i = postToolTextEvents.length - 1; i >= 0; i--) {
    const text = postToolTextEvents[i].event.displayText;
    if (text && text.length >= 200) {
      return text;
    }
  }
  return null;
}

/**
 * Check if text has markdown structure (headers, bullet lists).
 */
function hasMarkdownStructure(text: string): boolean {
  return /^#{1,3}\s+/m.test(text);
}

// ---- Section parsing ----

/**
 * Parse markdown sections from the final report block.
 *
 * Handles:
 * - ## Header / ### Header / # Header
 * - **Bold Label**
 *
 * Returns map of lowercase header → section content.
 */
function extractSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split('\n');
  let currentHeader = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    // Match ## Header or ### Header or # Header
    const mdHeader = /^#{1,3}\s+(.+)/.exec(line);
    // Match **Bold Label** at start of line
    const boldHeader = /^\*\*([^*]+)\*\*\s*$/.exec(line);

    const headerMatch = mdHeader || boldHeader;

    if (headerMatch) {
      // Save previous section
      if (currentHeader) {
        const content = currentContent.join('\n').trim();
        if (content) sections.set(currentHeader, content);
      }
      currentHeader = headerMatch[1].trim().toLowerCase();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentHeader) {
    const content = currentContent.join('\n').trim();
    if (content) sections.set(currentHeader, content);
  }

  return sections;
}

/**
 * Find a section by trying multiple header names (case-insensitive).
 * Returns the section content or null.
 */
function findSection(sections: Map<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    // Exact match
    const exact = sections.get(name);
    if (exact) return exact;
    // Partial match: section header contains the name
    for (const [key, value] of sections) {
      if (key.includes(name)) return value;
    }
  }
  return null;
}

// ---- Verification extraction ----

/**
 * STRICT verification extraction.
 * Only real evidence: "15 tests passed", "Verified: ..."
 * Rejects tables, vague mentions.
 */
function extractVerification(events: IndexedEvent[]): string | null {
  for (const { event } of events) {
    if (event.type === 'tool_result' && event.displayText) {
      const text = event.displayText;
      if (/^\s*\|/.test(text) || /^[-=]{3,}/.test(text)) continue;
      if (/\d+\s+tests?\s+pass/i.test(text) || /tests?\s+pass(?:ed)?:\s*\d/i.test(text) || /✓\s*\d+\s+passing/i.test(text)) {
        return text.slice(0, 500);
      }
    }
  }
  for (const { event } of events) {
    if (event.type === 'text' && event.displayText) {
      const text = event.displayText.trim();
      if (/^\s*\|/.test(text) || /^[-=]{3,}/.test(text)) continue;
      if (/^verified\s*:/i.test(text) || /^all\s+(?:\d+\s+)?tests?\s+pass/i.test(text)) {
        return text;
      }
    }
  }
  return null;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}
