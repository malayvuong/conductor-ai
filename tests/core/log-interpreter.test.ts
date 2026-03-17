import { describe, it, expect } from 'vitest';
import { interpretLogLine, formatEventForDisplay } from '../../src/core/engine/log-interpreter.js';

describe('interpretLogLine', () => {
  // --- stderr ---
  it('interprets stderr as error event', () => {
    const event = interpretLogLine('stderr', 'Something went wrong');
    expect(event.type).toBe('error');
    expect(event.displayText).toBe('Something went wrong');
    expect(event.severity).toBe('error');
  });

  // --- system ---
  it('interprets system log as system event', () => {
    const event = interpretLogLine('system', 'engine=claude cwd=/tmp');
    expect(event.type).toBe('system');
    expect(event.displayText).toBe('engine=claude cwd=/tmp');
  });

  // --- stdout plain text ---
  it('interprets non-JSON stdout as text', () => {
    const event = interpretLogLine('stdout', 'Hello world');
    expect(event.type).toBe('text');
    expect(event.displayText).toBe('Hello world');
  });

  // --- Claude JSON: system init ---
  it('parses system init event', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('system');
    expect(event.displayText).toContain('claude-opus-4-6');
  });

  // --- Claude JSON: hook (silent) ---
  it('silences hook events', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('silent');
    expect(event.displayText).toBeNull();
  });

  // --- Claude JSON: assistant text ---
  it('extracts text from assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Found the bug in auth.ts' }] },
    });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('text');
    expect(event.displayText).toBe('Found the bug in auth.ts');
  });

  // --- Claude JSON: assistant tool_use ---
  it('extracts tool name and file path from tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/app/src/auth.ts' } }],
      },
    });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('tool_use');
    expect(event.toolName).toBe('Edit');
    expect(event.filePath).toBe('/app/src/auth.ts');
    expect(event.displayText).toBe('Edit: /app/src/auth.ts');
  });

  it('handles tool_use without file path', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
      },
    });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('tool_use');
    expect(event.toolName).toBe('Bash');
    expect(event.filePath).toBeNull();
    expect(event.displayText).toBe('Bash');
  });

  // --- Claude JSON: tool_result ---
  it('extracts tool result preview', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      content: 'Tests passed: 5/5',
    });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('tool_result');
    expect(event.displayText).toContain('Tests passed');
  });

  // --- Claude JSON: result ---
  it('parses result event', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success',
      total_cost_usd: 0.15, duration_ms: 45000,
    });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('result');
    expect(event.displayText).toContain('success');
    expect(event.displayText).toContain('45s');
    expect(event.displayText).toContain('$0.1500');
  });

  // --- Claude JSON: rate limit (silent) ---
  it('silences rate limit events', () => {
    const line = JSON.stringify({ type: 'rate_limit_event' });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('silent');
  });

  // --- Claude JSON: unknown type (silent) ---
  it('silences unknown JSON event types', () => {
    const line = JSON.stringify({ type: 'some_future_event' });
    const event = interpretLogLine('stdout', line);
    expect(event.type).toBe('silent');
  });
});

describe('formatEventForDisplay', () => {
  it('formats text event with [MSG] prefix', () => {
    const event = interpretLogLine('stdout', 'plain text');
    expect(formatEventForDisplay(event)).toBe('[MSG] plain text');
  });

  it('formats tool_use with [TOOL] prefix', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    const event = interpretLogLine('stdout', line);
    expect(formatEventForDisplay(event)).toBe('[TOOL] Read: /a.ts');
  });

  it('formats error with [ERR] prefix', () => {
    const event = interpretLogLine('stderr', 'bad stuff');
    expect(formatEventForDisplay(event)).toBe('[ERR] bad stuff');
  });

  it('formats system with [SYS] prefix', () => {
    const event = interpretLogLine('system', 'engine=claude');
    expect(formatEventForDisplay(event)).toBe('[SYS] engine=claude');
  });

  it('formats result with [DONE] prefix', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 5000 });
    const event = interpretLogLine('stdout', line);
    expect(formatEventForDisplay(event)).toBe('[DONE] success 5s');
  });

  it('returns null for silent events', () => {
    const line = JSON.stringify({ type: 'rate_limit_event' });
    const event = interpretLogLine('stdout', line);
    expect(formatEventForDisplay(event)).toBeNull();
  });
});
