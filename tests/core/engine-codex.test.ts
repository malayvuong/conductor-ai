import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../../src/core/engine/codex.js';

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();

  it('has correct name', () => {
    expect(adapter.name).toBe('codex');
  });

  it('builds command with prompt via stdin', () => {
    const cmd = adapter.buildCommand({
      prompt: 'Review the API endpoints',
      workspacePath: '/Users/test/project',
    });

    expect(cmd.executable).toBe('codex');
    expect(cmd.args).toContain('--quiet');
    expect(cmd.args).toContain('--auto-edit');
    expect(cmd.stdin).toBe('Review the API endpoints');
    expect(cmd.args.some(a => a.includes('Review'))).toBe(false);
  });
});
