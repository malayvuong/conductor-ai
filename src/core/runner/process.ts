import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineCommand } from '../engine/types.js';

export interface ProcessCallbacks {
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
  onPid?: (pid: number) => void;
}

export interface ProcessOptions extends ProcessCallbacks {
  timeoutMs?: number;
  cwd?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  pid: number | undefined;
}

export function runProcess(
  command: EngineCommand,
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      options.onPid?.(child.pid);
    }

    const stdoutRl = createInterface({ input: child.stdout! });
    const stderrRl = createInterface({ input: child.stderr! });

    stdoutRl.on('line', (line) => options.onLine('stdout', line));
    stderrRl.on('line', (line) => options.onLine('stderr', line));

    // Timeout handling
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000);
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start process: ${err.message}`));
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        exitCode: code,
        pid: child.pid,
      });
    });
  });
}
