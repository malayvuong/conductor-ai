import { execSync } from 'node:child_process';
import type { EngineAdapter, EngineCommand, EngineCommandInput } from './types.js';

export class CodexAdapter implements EngineAdapter {
  name = 'codex';
  streaming = false;

  buildCommand(input: EngineCommandInput): EngineCommand {
    return {
      executable: 'codex',
      args: [
        'exec',
        '--full-auto',
        '-C', input.workspacePath,
      ],
      env: {},
      stdin: input.prompt,
    };
  }

  validateExecutable(): boolean {
    try {
      execSync('which codex', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}
