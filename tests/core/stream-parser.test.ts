import { describe, it, expect } from 'vitest';
import { parseClaudeStreamEvent } from '../../src/core/engine/stream-parser.js';

describe('parseClaudeStreamEvent', () => {
  it('parses system init event', () => {
    const event = JSON.stringify({
      type: 'system', subtype: 'init', model: 'claude-opus-4-6',
    });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toContain('claude-opus-4-6');
    expect(result.display).toContain('[SYS]');
    expect(result.raw).toBe(event);
  });

  it('silences hook events', () => {
    const event = JSON.stringify({
      type: 'system', subtype: 'hook_started', hook_name: 'test',
    });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toBeNull();
  });

  it('extracts text from assistant message', () => {
    const event = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'I found the bug in login.ts' }],
      },
    });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toBe('[MSG] I found the bug in login.ts');
  });

  it('shows tool use from assistant message', () => {
    const event = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/app.ts' } }],
      },
    });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toBe('[TOOL] Edit: /tmp/app.ts');
  });

  it('silences rate limit events', () => {
    const event = JSON.stringify({ type: 'rate_limit_event' });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toBeNull();
  });

  it('parses result event with cost and duration', () => {
    const event = JSON.stringify({
      type: 'result', subtype: 'success',
      total_cost_usd: 0.0542, duration_ms: 12300,
    });
    const result = parseClaudeStreamEvent(event);
    expect(result.display).toContain('success');
    expect(result.display).toContain('$0.0542');
    expect(result.display).toContain('12s');
    expect(result.display).toContain('[DONE]');
  });

  it('returns prefixed text for non-JSON lines', () => {
    const result = parseClaudeStreamEvent('just plain text output');
    expect(result.display).toBe('[MSG] just plain text output');
    expect(result.raw).toBe('just plain text output');
  });
});
