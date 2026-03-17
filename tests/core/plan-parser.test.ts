import { describe, it, expect } from 'vitest';
import { parsePlan, createSingleWPPlan } from '../../src/core/supervisor/plan-parser.js';

describe('parsePlan', () => {
  it('parses ### Task N: Title format', () => {
    const content = `# My Plan

Some description here.

### Task 1: Scan project structure

Look at all files and understand the layout.

### Task 2: Implement API endpoints

Create CRUD endpoints for users.

### Task 3: Write tests

Unit tests for all endpoints.
`;

    const plan = parsePlan(content);
    expect(plan.title).toBe('My Plan');
    expect(plan.workPackages).toHaveLength(3);
    expect(plan.workPackages[0].seq).toBe(1);
    expect(plan.workPackages[0].title).toBe('Scan project structure');
    expect(plan.workPackages[0].description).toContain('Look at all files');
    expect(plan.workPackages[1].title).toBe('Implement API endpoints');
    expect(plan.workPackages[2].title).toBe('Write tests');
  });

  it('parses ## Task N: Title format', () => {
    const content = `# Plan

## Task 1: First thing

Do the first thing.

## Task 2: Second thing

Do the second thing.
`;

    const plan = parsePlan(content);
    expect(plan.workPackages).toHaveLength(2);
    expect(plan.workPackages[0].title).toBe('First thing');
  });

  it('extracts plan description between title and first task', () => {
    const content = `# Feature Plan

This plan implements the user management system.
It covers API, UI, and testing.

### Task 1: API

Build the API.
`;

    const plan = parsePlan(content);
    expect(plan.description).toContain('user management system');
    expect(plan.description).toContain('API, UI, and testing');
  });

  it('handles empty plan gracefully', () => {
    const plan = parsePlan('');
    expect(plan.title).toBe('Untitled Plan');
    expect(plan.workPackages).toHaveLength(0);
  });

  it('handles plan with no tasks', () => {
    const plan = parsePlan('# My Plan\n\nJust some notes.');
    expect(plan.title).toBe('My Plan');
    expect(plan.workPackages).toHaveLength(0);
  });

  it('preserves multi-line WP descriptions', () => {
    const content = `# Plan

### Task 1: Complex task

Step 1: Do this
Step 2: Do that

- [ ] Verify step 1
- [ ] Verify step 2

### Task 2: Next
`;

    const plan = parsePlan(content);
    expect(plan.workPackages[0].description).toContain('Step 1');
    expect(plan.workPackages[0].description).toContain('Step 2');
    expect(plan.workPackages[0].description).toContain('Verify step 1');
  });
});

describe('createSingleWPPlan', () => {
  it('creates a plan with one WP', () => {
    const plan = createSingleWPPlan('Fix the login bug in auth module');
    expect(plan.workPackages).toHaveLength(1);
    expect(plan.workPackages[0].seq).toBe(1);
    expect(plan.workPackages[0].description).toBe('Fix the login bug in auth module');
  });

  it('truncates long titles', () => {
    const long = 'A'.repeat(100);
    const plan = createSingleWPPlan(long);
    expect(plan.title.length).toBe(80);
  });
});
