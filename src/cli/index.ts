#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerRunsCommand } from './commands/runs.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerReportCommand } from './commands/report.js';
import { registerResumeCommand } from './commands/resume.js';
import { registerSessionCommand, registerStatusCommand, registerInspectCommand } from './commands/session.js';
import { registerExecuteCommand } from './commands/execute.js';
import { registerGoalCommand } from './commands/goal.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDoctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('cdx')
  .description('Autonomous execution supervisor for AI coding CLIs')
  .version('2026.03.1');

// Session-first commands (primary UX)
registerSessionCommand(program);
registerExecuteCommand(program);
registerStatusCommand(program);
registerInspectCommand(program);

// Execution layer
registerRunCommand(program);
registerRunsCommand(program);
registerTasksCommand(program);
registerLogsCommand(program);
registerReportCommand(program);
registerResumeCommand(program);

// Internal/advanced
registerGoalCommand(program);

// Configuration & diagnostics
registerConfigCommands(program);
registerDoctorCommand(program);

program.parse();
