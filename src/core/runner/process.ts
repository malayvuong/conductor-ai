import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EngineCommand } from '../engine/types.js';

export interface ProcessCallbacks {
  onLine: (stream: 'stdout' | 'stderr', line: string) => void;
  onPid?: (pid: number) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  pid: number | undefined;
}

export function runProcess(
  command: EngineCommand,
  callbacks: ProcessCallbacks,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: undefined, // Will be set by caller if needed
      env: { ...process.env, ...command.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      callbacks.onPid?.(child.pid);
    }

    const stdoutRl = createInterface({ input: child.stdout! });
    const stderrRl = createInterface({ input: child.stderr! });

    stdoutRl.on('line', (line) => callbacks.onLine('stdout', line));
    stderrRl.on('line', (line) => callbacks.onLine('stderr', line));

    child.on('error', (err) => {
      reject(new Error(`Failed to start process: ${err.message}`));
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code,
        pid: child.pid,
      });
    });
  });
}
