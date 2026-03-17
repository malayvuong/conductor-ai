/**
 * Resume prompt rendering layer.
 *
 * Takes a ResumeContext and renders it into a structured continuation prompt.
 * Separated from context selection so each can be tested independently.
 */

import type { Task } from '../../types/index.js';
import type { ResumeContext } from './context.js';

interface RenderResumePromptInput {
  task: Task;
  context: ResumeContext;
  newInstruction: string | null;
  workspacePath: string;
}

/**
 * Render a structured resume prompt.
 *
 * Structure:
 * 1. Workspace root
 * 2. Original task
 * 3. Context sections from previous run (typed by task_type)
 * 4. Context quality note (if limited)
 * 5. New instruction (if provided)
 * 6. Continuation guidelines
 */
export function renderResumePrompt(input: RenderResumePromptInput): string {
  const { task, context, newInstruction, workspacePath } = input;

  const parts: string[] = [];

  // Header
  parts.push(`You are working in the directory: ${workspacePath}`);
  parts.push('');

  // Original task
  parts.push('## Original task');
  parts.push(task.raw_input);
  parts.push('');

  // Previous context sections
  parts.push('## Context from previous run');
  parts.push(`Previous run: ${context.sourceRun.id.slice(0, 8)} (${context.sourceRun.status})`);
  parts.push('');

  for (const section of context.sections) {
    parts.push(`### ${section.label}`);
    parts.push(section.content);
    parts.push('');
  }

  // Context quality warning
  if (context.quality === 'limited') {
    parts.push('> Note: Previous run had limited context. You may need to re-investigate some areas.');
    parts.push('');
  }

  // New instruction
  if (newInstruction) {
    parts.push('## New instruction');
    parts.push(newInstruction);
    parts.push('');
  }

  // Continuation guidelines
  parts.push('## Your job');
  parts.push(getContinuationGuidelines(context.taskType, !!newInstruction));

  return parts.join('\n');
}

function getContinuationGuidelines(taskType: string | null, hasNewInstruction: boolean): string {
  const base = [
    '- Continue from previous findings — do not redo completed work unless necessary',
    '- Reuse previous context where relevant',
    '- Report clearly what is newly discovered versus what was already known',
  ];

  if (hasNewInstruction) {
    base.unshift('- Focus on the new instruction above');
  }

  switch (taskType) {
    case 'scan_review':
      base.push('- Do not repeat broad exploration unless the new instruction requires it');
      base.push('- Build on previous findings — add depth, not breadth');
      break;
    case 'debug_fix':
      base.push('- Do not redo completed fixes unless verification shows they are insufficient');
      base.push('- If previous fix was applied, verify it still works before making new changes');
      break;
    case 'implement_feature':
      base.push('- Do not reimplement completed features');
      base.push('- Focus on remaining follow-ups or the new instruction');
      break;
  }

  return base.join('\n');
}
