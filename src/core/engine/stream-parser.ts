/**
 * Live stream parser for Claude CLI output during execution.
 * Delegates to the unified log interpreter for actual parsing.
 * Kept as a thin wrapper for backward compatibility with run.ts/resume.ts.
 */

import { interpretLogLine, formatEventForDisplay } from './log-interpreter.js';

export function parseClaudeStreamEvent(jsonLine: string): { display: string | null; raw: string } {
  const event = interpretLogLine('stdout', jsonLine);
  const display = formatEventForDisplay(event);
  return { display, raw: jsonLine };
}
