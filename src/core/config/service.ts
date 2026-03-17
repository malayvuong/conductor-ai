import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ConductorConfig {
  defaultPath?: string;
  defaultEngine?: string;
  heartbeatIntervalSec?: number;
  stuckThresholdSec?: number;
}

const CONFIG_DIR = path.join(os.homedir(), '.conductor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function ensureDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): ConductorConfig {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveConfig(config: ConductorConfig): void {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
