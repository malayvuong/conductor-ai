import { describe, it, expect } from 'vitest';
import { runProcess } from '../../src/core/runner/process.js';
import type { EngineCommand } from '../../src/core/engine/types.js';

describe('runProcess', () => {
  it('runs a simple command and captures output', async () => {
    const lines: { stream: string; line: string }[] = [];

    const result = await runProcess(
      { executable: 'echo', args: ['hello world'], env: {} },
      {
        onLine: (stream, line) => lines.push({ stream, line }),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].line).toContain('hello world');
  });

  it('captures stderr', async () => {
    const lines: { stream: string; line: string }[] = [];

    const result = await runProcess(
      { executable: 'sh', args: ['-c', 'echo error >&2'], env: {} },
      {
        onLine: (stream, line) => lines.push({ stream, line }),
      }
    );

    expect(result.exitCode).toBe(0);
    expect(lines.some(l => l.stream === 'stderr' && l.line.includes('error'))).toBe(true);
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await runProcess(
      { executable: 'sh', args: ['-c', 'exit 1'], env: {} },
      { onLine: () => {} }
    );

    expect(result.exitCode).toBe(1);
  });

  it('reports pid', async () => {
    let capturedPid: number | undefined;

    await runProcess(
      { executable: 'echo', args: ['test'], env: {} },
      {
        onLine: () => {},
        onPid: (pid) => { capturedPid = pid; },
      }
    );

    expect(capturedPid).toBeDefined();
    expect(capturedPid).toBeGreaterThan(0);
  });
});
