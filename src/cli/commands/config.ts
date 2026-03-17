import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, getConfigPath } from '../../core/config/service.js';
import { log } from '../../utils/logger.js';

export function registerConfigCommands(program: Command): void {
  program
    .command('set-path <path>')
    .description('Set default workspace path')
    .action((inputPath: string) => {
      const resolved = path.resolve(inputPath);
      if (!fs.existsSync(resolved)) {
        log.error(`Path does not exist: ${resolved}`);
        process.exit(1);
      }
      const config = loadConfig();
      config.defaultPath = resolved;
      saveConfig(config);
      log.info(`Default path set: ${resolved}`);
    });

  program
    .command('get-path')
    .description('Show default workspace path')
    .action(() => {
      const config = loadConfig();
      if (config.defaultPath) {
        console.log(config.defaultPath);
      } else {
        console.log('No default path set. Use: conductor set-path <path>');
      }
    });

  program
    .command('clear-path')
    .description('Clear default workspace path')
    .action(() => {
      const config = loadConfig();
      delete config.defaultPath;
      saveConfig(config);
      log.info('Default path cleared.');
    });
}
