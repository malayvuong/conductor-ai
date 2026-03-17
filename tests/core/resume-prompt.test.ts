import { describe, it, expect } from 'vitest';
import { renderResumePrompt } from '../../src/core/resume/prompt.js';
import type { Task, Run } from '../../src/types/index.js';
import type { ResumeContext } from '../../src/core/resume/context.js';

const makeTask = (overrides?: Partial<Task>): Task => ({
  id: 'task-1', raw_input: 'inspect project structure', workspace_path: '/tmp/project',
  engine: 'claude', task_type: 'scan_review', normalized_json: '{}',
  status: 'completed', created_at: '', updated_at: '',
  ...overrides,
});

const makeRun = (overrides?: Partial<Run>): Run => ({
  id: 'run-1', task_id: 'task-1', engine: 'claude', command: 'claude',
  args_json: '[]', prompt_final: 'prompt', status: 'completed',
  pid: 123, started_at: '2026-03-17T10:00:00Z', finished_at: '2026-03-17T10:05:00Z',
  exit_code: 0, resumed_from_run_id: null, cost_usd: null, duration_seconds: null,
  ...overrides,
});

describe('renderResumePrompt', () => {
  it('includes workspace, original task, context sections, and continuation guidelines', () => {
    const context: ResumeContext = {
      sourceRun: makeRun(),
      taskType: 'scan_review',
      quality: 'full',
      sections: [
        { label: 'Previous run summary', content: 'Scanned 15 files.' },
        { label: 'Findings from previous run', content: 'SQL injection found.' },
      ],
    };

    const prompt = renderResumePrompt({
      task: makeTask(),
      context,
      newInstruction: 'now focus on cms-management area',
      workspacePath: '/tmp/project',
    });

    // Structure checks
    expect(prompt).toContain('You are working in the directory: /tmp/project');
    expect(prompt).toContain('## Original task');
    expect(prompt).toContain('inspect project structure');
    expect(prompt).toContain('## Context from previous run');
    expect(prompt).toContain('### Previous run summary');
    expect(prompt).toContain('Scanned 15 files.');
    expect(prompt).toContain('### Findings from previous run');
    expect(prompt).toContain('SQL injection found.');
    expect(prompt).toContain('## New instruction');
    expect(prompt).toContain('now focus on cms-management area');
    expect(prompt).toContain('## Your job');
    expect(prompt).toContain('Continue from previous findings');
  });

  it('omits new instruction section when no override', () => {
    const context: ResumeContext = {
      sourceRun: makeRun(),
      taskType: 'debug_fix',
      quality: 'full',
      sections: [{ label: 'Previous root cause', content: 'Null check missing' }],
    };

    const prompt = renderResumePrompt({
      task: makeTask({ task_type: 'debug_fix' }),
      context,
      newInstruction: null,
      workspacePath: '/tmp/project',
    });

    expect(prompt).not.toContain('## New instruction');
    expect(prompt).toContain('Continue from previous findings');
  });

  it('includes context quality warning for limited quality', () => {
    const context: ResumeContext = {
      sourceRun: makeRun({ status: 'failed' }),
      taskType: 'debug_fix',
      quality: 'limited',
      sections: [{ label: 'Previous run', content: 'Status: failed' }],
    };

    const prompt = renderResumePrompt({
      task: makeTask({ task_type: 'debug_fix' }),
      context,
      newInstruction: 'retry with narrower scope',
      workspacePath: '/tmp/project',
    });

    expect(prompt).toContain('limited context');
    expect(prompt).toContain('re-investigate');
  });

  it('scan_review guidelines include exploration advice', () => {
    const context: ResumeContext = {
      sourceRun: makeRun(),
      taskType: 'scan_review',
      quality: 'full',
      sections: [],
    };

    const prompt = renderResumePrompt({
      task: makeTask(),
      context,
      newInstruction: null,
      workspacePath: '/tmp',
    });

    expect(prompt).toContain('Do not repeat broad exploration');
  });

  it('debug_fix guidelines include fix verification advice', () => {
    const context: ResumeContext = {
      sourceRun: makeRun(),
      taskType: 'debug_fix',
      quality: 'full',
      sections: [],
    };

    const prompt = renderResumePrompt({
      task: makeTask({ task_type: 'debug_fix' }),
      context,
      newInstruction: null,
      workspacePath: '/tmp',
    });

    expect(prompt).toContain('Do not redo completed fixes');
  });

  it('includes run ID in context header', () => {
    const context: ResumeContext = {
      sourceRun: makeRun({ id: 'abcdef12-3456-7890-abcd-ef1234567890' }),
      taskType: 'scan_review',
      quality: 'full',
      sections: [],
    };

    const prompt = renderResumePrompt({
      task: makeTask(),
      context,
      newInstruction: null,
      workspacePath: '/tmp',
    });

    expect(prompt).toContain('abcdef12');
    expect(prompt).toContain('completed');
  });

  it('shows "Focus on the new instruction" when new instruction is provided', () => {
    const context: ResumeContext = {
      sourceRun: makeRun(),
      taskType: 'scan_review',
      quality: 'full',
      sections: [],
    };

    const prompt = renderResumePrompt({
      task: makeTask(),
      context,
      newInstruction: 'focus on auth module',
      workspacePath: '/tmp',
    });

    expect(prompt).toContain('Focus on the new instruction');
  });
});
