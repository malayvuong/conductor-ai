#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerReportCommand } from './commands/report.js';
import { registerResumeCommand } from './commands/resume.js';
import { registerConfigCommands } from './commands/config.js';

const program = new Command();

program
  .name('cdx')
  .description('Supervisor for AI coding CLIs')
  .version('2026.3.17');

registerRunCommand(program);
registerTasksCommand(program);
registerLogsCommand(program);
registerReportCommand(program);
registerResumeCommand(program);
registerConfigCommands(program);

program.parse();
