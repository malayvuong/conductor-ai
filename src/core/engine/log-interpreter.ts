/**
 * Unified log interpretation layer.
 *
 * Parses persisted log lines (raw JSON events, plain text, stderr, system)
 * into structured ParsedRunEvent objects usable by both:
 * - `cdx logs` for human-readable display
 * - report generator for structured field extraction
 *
 * Persisted log shapes:
 * - stdout (Claude): raw JSON event lines from --output-format stream-json
 * - stdout (Codex/other): plain text lines
 * - stderr: plain text error lines
 * - system: conductor metadata lines (e.g. "engine=claude cwd=/tmp ...")
 *
 * Claude JSON event types and what they carry:
 * - system/init: model name, session_id, tools list
 * - system/hook_*: hook lifecycle (not useful for reporting)
 * - assistant: message.content[] with text blocks and tool_use blocks
 *   - tool_use blocks have: name, input (with file paths for Edit/Write)
 * - tool_result: tool execution output
 * - rate_limit_event: rate limit info (not useful)
 * - result: final status, cost, duration
 */

import type { StreamType } from '../../types/index.js';

export type EventType = 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'result' | 'silent';

export interface ParsedRunEvent {
  type: EventType;
  displayText: string | null;
  toolName: string | null;
  filePath: string | null;
  severity: 'info' | 'warning' | 'error';
  raw: string;
}

/**
 * Interpret a single persisted log line into a structured event.
 */
export function interpretLogLine(streamType: StreamType, line: string): ParsedRunEvent {
  if (streamType === 'stderr') {
    return {
      type: 'error',
      displayText: line,
      toolName: null,
      filePath: null,
      severity: 'error',
      raw: line,
    };
  }

  if (streamType === 'system') {
    return {
      type: 'system',
      displayText: line,
      toolName: null,
      filePath: null,
      severity: 'info',
      raw: line,
    };
  }

  // stdout — try to parse as JSON event
  try {
    const event = JSON.parse(line);
    return parseJsonEvent(event, line);
  } catch {
    // Not JSON — plain text stdout
    return {
      type: 'text',
      displayText: line,
      toolName: null,
      filePath: null,
      severity: 'info',
      raw: line,
    };
  }
}

function parseJsonEvent(event: any, raw: string): ParsedRunEvent {
  switch (event.type) {
    case 'system': {
      if (event.subtype === 'init') {
        return {
          type: 'system',
          displayText: `Session started (model: ${event.model || 'unknown'})`,
          toolName: null,
          filePath: null,
          severity: 'info',
          raw,
        };
      }
      // hook_started, hook_response, etc. — silent
      return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };
    }

    case 'assistant': {
      const content = event.message?.content;
      if (!Array.isArray(content)) {
        return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };
      }

      // An assistant message can contain multiple content blocks.
      // We return one ParsedRunEvent per call, so we merge text blocks
      // and pick the first tool_use if present.
      const textParts: string[] = [];
      let toolName: string | null = null;
      let filePath: string | null = null;

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolName = block.name || null;
          filePath = extractFilePath(block) || null;
        }
      }

      if (toolName) {
        const display = filePath ? `${toolName}: ${filePath}` : toolName;
        return {
          type: 'tool_use',
          displayText: display,
          toolName,
          filePath,
          severity: 'info',
          raw,
        };
      }

      const text = textParts.join('\n');
      if (text) {
        return {
          type: 'text',
          displayText: text,
          toolName: null,
          filePath: null,
          severity: 'info',
          raw,
        };
      }

      return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };
    }

    case 'tool_result': {
      // Tool execution result — brief preview
      if (event.content) {
        const preview = typeof event.content === 'string'
          ? event.content.slice(0, 300)
          : JSON.stringify(event.content).slice(0, 300);
        return {
          type: 'tool_result',
          displayText: preview,
          toolName: null,
          filePath: null,
          severity: 'info',
          raw,
        };
      }
      return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };
    }

    case 'result': {
      const status = event.subtype || 'done';
      const cost = event.total_cost_usd ? ` ($${event.total_cost_usd.toFixed(4)})` : '';
      const duration = event.duration_ms ? ` ${Math.round(event.duration_ms / 1000)}s` : '';
      return {
        type: 'result',
        displayText: `${status}${duration}${cost}`,
        toolName: null,
        filePath: null,
        severity: event.is_error ? 'error' : 'info',
        raw,
      };
    }

    case 'rate_limit_event':
      return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };

    default:
      return { type: 'silent', displayText: null, toolName: null, filePath: null, severity: 'info', raw };
  }
}

/**
 * Extract file path from a tool_use content block.
 * Claude tool_use blocks for Edit/Write/Read have input.file_path or input.path.
 */
function extractFilePath(block: any): string | undefined {
  const input = block.input;
  if (!input) return undefined;
  return input.file_path || input.path || input.filePath || undefined;
}

/**
 * Format a ParsedRunEvent for CLI display.
 */
export function formatEventForDisplay(event: ParsedRunEvent): string | null {
  if (!event.displayText) return null;

  switch (event.type) {
    case 'text':     return `[MSG] ${event.displayText}`;
    case 'tool_use': return `[TOOL] ${event.displayText}`;
    case 'tool_result': return `[RESULT] ${event.displayText}`;
    case 'system':   return `[SYS] ${event.displayText}`;
    case 'error':    return `[ERR] ${event.displayText}`;
    case 'result':   return `[DONE] ${event.displayText}`;
    default:         return null;
  }
}
