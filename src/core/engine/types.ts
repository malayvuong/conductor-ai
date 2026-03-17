export interface EngineCommand {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  stdin?: string;
}

export interface EngineAdapter {
  name: string;
  buildCommand(input: EngineCommandInput): EngineCommand;
  validateExecutable(): boolean;
}

export interface EngineCommandInput {
  prompt: string;
  workspacePath: string;
}

import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

const adapters: Record<string, () => EngineAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
};

export function getEngine(name: string): EngineAdapter {
  const factory = adapters[name];
  if (!factory) {
    throw new Error(`Unknown engine: ${name}. Available: ${Object.keys(adapters).join(', ')}`);
  }
  return factory();
}
