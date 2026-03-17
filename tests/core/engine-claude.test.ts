import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/core/engine/claude.js';

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('claude');
  });

  it('builds command with prompt via stdin', () => {
    const cmd = adapter.buildCommand({
      prompt: 'Fix the bug in login handler',
      workspacePath: '/Users/test/project',
    });

    expect(cmd.executable).toBe('claude');
    expect(cmd.args).toContain('--print');
    expect(cmd.args).toContain('--dangerously-skip-permissions');
    expect(cmd.stdin).toBe('Fix the bug in login handler');
    // prompt should NOT be in args (delivered via stdin)
    expect(cmd.args.some(a => a.includes('Fix the bug'))).toBe(false);
  });
});
