# Conductor v2: Autonomous Execution Supervisor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Conductor from a single-run CLI wrapper into a goal-driven, auto-compacting, auto-resuming execution supervisor that runs until done or hard-blocked.

**Architecture:** Two-layer design — existing Execution Layer (task/run/logs/reports) remains as the low-level engine interface. New Supervisor Layer (session/goal/work_package/snapshot/attempt) orchestrates multiple runs to achieve a goal. The supervisor loop runs until done, auto-compacting between runs and recovering from stalls.

**Tech Stack:** Node.js 22+, TypeScript, better-sqlite3, commander

---

## A. Architecture Proposal

### Overall Architecture

```
┌─────────────────────────────────────────────────┐
│               Supervisor Layer                   │
│                                                  │
│  Session ─→ Goal ─→ WorkPackage[]                │
│                  ↘ Snapshot[]                     │
│                                                  │
│  ┌─────────────────────────────────────────┐     │
│  │         Execution Loop                  │     │
│  │                                         │     │
│  │  1. Pick next WP                        │     │
│  │  2. Build prompt (goal+WP+snapshot)     │     │
│  │  3. Run engine ───────────────────┐     │     │
│  │  4. Parse results                 │     │     │
│  │  5. Update state + progress       │     │     │
│  │  6. Build snapshot for next run   │     │     │
│  │  7. Check: done? stalled? blocked?│     │     │
│  │  8. Loop or exit                  │     │     │
│  └─────────────────────────────────────────┘     │
│                                                  │
│  Components:                                     │
│   - Scheduler (WP ordering + selection)          │
│   - Compactor (snapshot creation)                │
│   - ProgressDetector (real progress vs churn)    │
│   - RecoveryEngine (stall → retry → mutate)      │
│   - BlockerClassifier (soft vs hard)             │
│   - GoalPromptBuilder (state-aware prompts)      │
└────────────────────┬────────────────────────────┘
                     │ delegates individual runs
┌────────────────────┴────────────────────────────┐
│               Execution Layer (existing)         │
│                                                  │
│  Engine Adapters → Process Runner → Log Stream   │
│  Heartbeat Monitor → Report Generator            │
│  Task/Run/RunLog/Report persistence              │
└──────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Existing execution layer preserved.** `cdx run` still works for one-off tasks. New supervisor sits on top.

2. **Each supervisor iteration = one engine run.** The engine runs, exits, Conductor captures state, builds next prompt, runs again. "Auto-compaction" = well-crafted state transfer between runs.

3. **Heartbeat has dual role.** Within a run: detect stalls/stuck. Between runs: the supervisor loop itself is the "outer heartbeat."

4. **Progress = observable state change.** Files created/modified, WP completed, tests passing, blockers resolved. Not just "agent produced output."

5. **Prompt mutation on stall.** If same WP fails repeatedly, Conductor changes prompt strategy: narrower scope, explicit next action, forbid re-scanning.

### State Machine

```
Session states:
  created → active → [paused] → completed | abandoned

Goal states:
  created → active → completed | hard_blocked | abandoned

WorkPackage states:
  pending → active → completed | failed | blocked | skipped

Execution states (per attempt):
  running → completed | failed | stalled | needs_recovery

Supervisor loop states:
  running
  waiting_for_engine        (engine process active)
  compacting                (building snapshot between runs)
  recovering                (stall detected, trying recovery)
  done                      (goal complete)
  hard_blocked              (escalated to user)
  awaiting_user_approval    (needs human decision)
```

---

## B. Data Model

### New entities (Supervisor Layer)

```sql
-- Persistent execution session
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_path TEXT NOT NULL,
  engine TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  -- CHECK (status IN ('created','active','paused','completed','abandoned'))
  active_goal_id TEXT,
  working_summary TEXT,
  decisions TEXT,           -- JSON: [{decision, reason, wp_id, at}]
  constraints TEXT,         -- JSON: string[]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the user wants accomplished
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  goal_type TEXT,           -- 'execute_plan', 'implement', 'debug', 'review', 'custom'
  status TEXT NOT NULL DEFAULT 'created',
  -- CHECK (status IN ('created','active','completed','hard_blocked','abandoned'))
  completion_rules TEXT,    -- JSON: criteria for "done"
  source_file TEXT,         -- path to plan file if from a plan
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Decomposed units of work
CREATE TABLE IF NOT EXISTS work_packages (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  parent_wp_id TEXT REFERENCES work_packages(id),
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  -- CHECK (status IN ('pending','active','completed','failed','blocked','skipped'))
  done_criteria TEXT,       -- what counts as done for this WP
  dependencies TEXT,        -- JSON: [wp_id, ...]
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_budget INTEGER NOT NULL DEFAULT 3,
  last_progress_at TEXT,
  blocker_type TEXT,        -- NULL, 'soft', 'hard'
  blocker_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- State capture between runs (the "compact" output)
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  current_wp_id TEXT REFERENCES work_packages(id),
  trigger TEXT NOT NULL,    -- 'run_completed', 'run_failed', 'manual', 'stall_recovery'
  summary TEXT NOT NULL,
  completed_items TEXT,     -- JSON: [{wp_id, title, result_summary}]
  in_progress_items TEXT,   -- JSON: [{wp_id, title, progress_so_far}]
  remaining_items TEXT,     -- JSON: [{wp_id, title}]
  decisions TEXT,           -- JSON: [{decision, reason}]
  constraints TEXT,         -- JSON: string[]
  related_files TEXT,       -- JSON: string[]
  blockers_encountered TEXT,-- JSON: [{type, detail, resolution}]
  next_action TEXT NOT NULL,-- explicit: what the agent should do next
  run_id TEXT,              -- which run produced this snapshot
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each engine invocation within a goal
CREATE TABLE IF NOT EXISTS execution_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  wp_id TEXT REFERENCES work_packages(id),
  attempt_no INTEGER NOT NULL DEFAULT 1,
  run_id TEXT REFERENCES runs(id),           -- links to existing execution layer
  snapshot_id TEXT REFERENCES snapshots(id),  -- snapshot used as input
  status TEXT NOT NULL DEFAULT 'running',
  -- CHECK (status IN ('running','completed','failed','stalled','needs_recovery'))
  progress_detected INTEGER NOT NULL DEFAULT 0,  -- boolean
  files_changed_count INTEGER NOT NULL DEFAULT 0,
  wp_completed_count INTEGER NOT NULL DEFAULT 0,
  prompt_strategy TEXT,     -- 'normal', 'focused', 'surgical', 'recovery'
  blocker_type TEXT,
  blocker_detail TEXT,
  notes TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
CREATE INDEX IF NOT EXISTS idx_wps_goal ON work_packages(goal_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_goal ON execution_attempts(goal_id);
CREATE INDEX IF NOT EXISTS idx_attempts_wp ON execution_attempts(wp_id);
```

### Relationship diagram

```
Session 1:N Goal
Goal 1:N WorkPackage (tree via parent_wp_id)
Goal 1:N Snapshot
WorkPackage 1:N ExecutionAttempt
ExecutionAttempt 1:1 Run (existing layer)
ExecutionAttempt N:1 Snapshot (input context)
```

### Key: Supervisor → Execution Layer bridge

Each `execution_attempt` creates a `run` in the existing layer. The attempt tracks supervisor-level metadata (progress, strategy, blocker). The run tracks execution-level data (logs, heartbeat, report). This keeps layers clean.

---

## C. Execution Flow

### Goal Lifecycle

```
1. User: cdx goal create "Execute CMS plan" --plan ./plan.md
   → Parse plan file → Create session + goal + work_packages
   → Status: created

2. User: cdx execute <goalId> --until-done
   → Enter supervisor loop

3. Supervisor loop (detailed below)

4. Exit conditions:
   a. All WPs completed → goal=completed, session=completed
   b. Hard blocker → goal=hard_blocked, show reason
   c. User interrupts (Ctrl+C) → session=paused, snapshot saved
   d. Awaiting approval → goal=awaiting_approval, show question
```

### Supervisor Loop (the core algorithm)

```
function executeGoal(session, goal):
  while true:
    // 1. Load current state
    snapshot = getLatestSnapshot(goal.id) or buildInitialSnapshot(goal)
    wps = getWorkPackages(goal.id)

    // 2. Check exit conditions
    if allWPsCompleted(wps):
      markGoalComplete(goal)
      log "Goal completed"
      break

    // 3. Select next WP
    wp = selectNextWP(wps, snapshot)
    if !wp:
      // All remaining WPs are blocked
      markGoalBlocked(goal, "All remaining WPs blocked")
      break

    // 4. Check retry budget
    if wp.retry_count >= wp.retry_budget:
      markWPBlocked(wp, "Retry budget exhausted")
      continue  // try next WP

    // 5. Determine prompt strategy
    strategy = determineStrategy(wp, snapshot)
    // normal → focused → surgical → recovery (escalating specificity)

    // 6. Build prompt
    prompt = buildGoalPrompt({
      goal, wp, snapshot, strategy,
      session.decisions, session.constraints
    })

    // 7. Create execution attempt + run
    attempt = createAttempt(session, goal, wp, snapshot, strategy)
    run = createRun(attempt, prompt)

    // 8. Execute engine (delegates to existing layer)
    result = runEngine(run, session.engine, session.project_path)

    // 9. Parse results
    report = generateReport(result.task, result.run, result.logs)

    // 10. Detect progress
    progress = detectProgress(report, snapshot, wp)

    // 11. Update attempt
    updateAttempt(attempt, {
      status: result.exitCode === 0 ? 'completed' : 'failed',
      progress_detected: progress.hasProgress,
      files_changed_count: progress.filesChanged,
      wp_completed_count: progress.wpsCompleted,
    })

    // 12. Update WP status based on results
    updateWPFromResult(wp, report, progress)

    // 13. Build snapshot for next iteration
    newSnapshot = buildSnapshot({
      session, goal, wp, report, progress, previousSnapshot: snapshot
    })
    saveSnapshot(newSnapshot)

    // 14. Stall check
    if !progress.hasProgress:
      wp.retry_count++
      if wp.retry_count >= wp.retry_budget:
        classifyBlocker(wp, report)
        // → soft: try next WP or decompose
        // → hard: escalate
        continue
      // Will loop with mutated strategy on next iteration

    // 15. Log iteration summary
    logIterationSummary(attempt, wp, progress)
```

### Heartbeat Integration (within each run)

The existing HeartbeatMonitor runs during each engine execution (step 8). If it detects `suspected_stuck`:

```
onHeartbeat('suspected_stuck', ...):
  stuckSeconds += heartbeatInterval
  if stuckSeconds > maxStuckSeconds:
    // Kill the process
    killProcess(childPid)
    // Attempt will end with failed status
    // Supervisor loop will handle recovery in step 14
```

### Compaction Flow (between runs)

Compaction = building a high-quality snapshot after each run. Not a separate phase — it happens at step 13 of every iteration.

```
function buildSnapshot(input):
  { session, goal, wp, report, progress, previousSnapshot } = input

  // Gather completed WPs
  allWPs = getWorkPackages(goal.id)
  completed = allWPs.filter(w => w.status === 'completed')
  inProgress = allWPs.filter(w => w.status === 'active')
  remaining = allWPs.filter(w => w.status === 'pending')

  // Extract decisions from report
  newDecisions = extractDecisions(report)
  allDecisions = [...(previousSnapshot?.decisions || []), ...newDecisions]

  // Extract related files
  files = new Set([
    ...(previousSnapshot?.related_files || []),
    ...parseFileList(report.files_inspected_json),
    ...parseFileList(report.files_changed_json),
  ])

  // Determine next action
  nextAction = determineNextAction(wp, remaining, report, progress)

  return {
    session_id, goal_id, current_wp_id: wp.id,
    trigger: 'run_completed',
    summary: buildCompactSummary(report, progress),
    completed_items: completed.map(formatWPSummary),
    in_progress_items: inProgress.map(formatWPProgress),
    remaining_items: remaining.map(formatWPBrief),
    decisions: allDecisions,
    constraints: session.constraints,
    related_files: [...files],
    blockers_encountered: gatherBlockers(allWPs),
    next_action: nextAction,
    run_id: report.run_id,
  }
```

### Recovery Flow

```
function determineStrategy(wp, snapshot):
  if wp.retry_count === 0:
    return 'normal'
  if wp.retry_count === 1:
    return 'focused'      // narrower scope, explicit next action
  if wp.retry_count === 2:
    return 'surgical'     // single specific task, forbid exploration
  return 'recovery'       // minimal prompt, just the one thing

function buildGoalPrompt(input):
  { goal, wp, snapshot, strategy } = input

  parts = []

  // Header
  parts.push("You are working in: " + session.project_path)

  // Goal context (always)
  parts.push("## Goal\n" + goal.description)

  // Current WP
  parts.push("## Current work package\n" + wp.title + "\n" + wp.description)
  if wp.done_criteria:
    parts.push("Done when: " + wp.done_criteria)

  // State from snapshot
  if snapshot:
    if snapshot.completed_items.length > 0:
      parts.push("## Already completed (DO NOT redo)")
      for item in snapshot.completed_items:
        parts.push("- " + item.title + ": " + item.result_summary)

    if snapshot.decisions.length > 0:
      parts.push("## Decisions already made (follow these)")
      for d in snapshot.decisions:
        parts.push("- " + d.decision + " (reason: " + d.reason + ")")

    if snapshot.related_files.length > 0:
      parts.push("## Files involved so far")
      for f in snapshot.related_files:
        parts.push("- " + f)

    if snapshot.blockers_encountered.length > 0:
      parts.push("## Blockers encountered and resolved")
      for b in snapshot.blockers_encountered:
        parts.push("- " + b.detail + " → " + b.resolution)

  // Strategy-specific instructions
  switch strategy:
    case 'normal':
      parts.push("## Instructions\nComplete the current work package.")
    case 'focused':
      parts.push("## Instructions (focused retry)")
      parts.push("Previous attempt did not make sufficient progress.")
      parts.push("Focus specifically on: " + snapshot.next_action)
      parts.push("Do NOT re-scan or re-explore what was already done.")
    case 'surgical':
      parts.push("## Instructions (surgical)")
      parts.push("Multiple attempts have not resolved this WP.")
      parts.push("Do ONLY this one thing: " + snapshot.next_action)
      parts.push("Do not explore. Do not scan. Just do the action.")
    case 'recovery':
      parts.push("## Instructions (recovery mode)")
      parts.push("This WP has failed multiple times.")
      parts.push("Analyze what went wrong and either:")
      parts.push("1. Complete the specific action: " + snapshot.next_action)
      parts.push("2. Report clearly what is blocking you if you cannot.")

  // Remaining work (brief, for context)
  if snapshot and snapshot.remaining_items.length > 0:
    parts.push("## Remaining work packages (for context, not for now)")
    for item in snapshot.remaining_items:
      parts.push("- " + item.title)

  return parts.join("\n\n")
```

---

## D. Blocker Policy

### Soft Blockers (Conductor self-recovers)

| Blocker | Recovery |
|---------|----------|
| Context full / run exits | Auto-compact snapshot + resume |
| Output stalled mid-run | Kill process + snapshot + retry |
| Agent output truncated | Capture partial, retry with focused prompt |
| Test fails (fixable) | Retry with error context in prompt |
| Agent drifts off-scope | Retry with surgical prompt |
| Prompt too broad | Mutate to focused/surgical strategy |
| Missing working summary | Build from available logs/report |
| WP too large | Decompose into sub-WPs (future) |

### Hard Blockers (Escalate to user)

| Blocker | Escalation message |
|---------|-------------------|
| Missing critical source file | "Cannot find {file}. Is the repo complete?" |
| Repository inconsistent | "Repo state is broken: {detail}" |
| Spec contradiction | "Spec says X but also Y. Which is correct?" |
| Permission denied | "Need permission for: {action}" |
| Destructive action needed | "About to {action}. Approve? (y/n)" |
| Retry budget exhausted on all WPs | "All WPs blocked after {N} retries. See details." |
| Risk of breaking system | "Continuing may {risk}. Approve? (y/n)" |

### Escalation Rules

1. Soft blocker → retry with mutated strategy (up to retry_budget)
2. After retry_budget exhausted → classify as soft or hard
3. If soft and other WPs available → skip, try other WPs first
4. If all remaining WPs blocked → hard block the goal
5. Hard blocker → immediate escalation with context

### Retry Budget

- Default per WP: 3 attempts
- Each attempt uses escalating strategy: normal → focused → surgical → recovery
- Can be overridden per WP via done_criteria configuration

---

## E. CLI Proposal

### New Commands

```bash
# Goal lifecycle
cdx goal create <title> --plan <file> [--engine <engine>] [--path <path>]
cdx goal create <title> --task "<description>" [--engine <engine>] [--path <path>]
cdx goal list [--status <status>]
cdx goal status <goalId>
cdx goal inspect <goalId>          # detailed: WPs, snapshots, attempts

# Main execution
cdx execute <goalId> [--until-done] [--wp <wpId>]

# Session management
cdx session list
cdx session show <sessionId>
cdx session pause <sessionId>
cdx session resume <sessionId>
```

### Example Usage

```bash
# Create a goal from a plan file
cdx goal create "Implement CMS management" \
  --plan ./docs/plans/cms-management.md \
  --engine claude \
  --path /Users/me/project

# Execute until done
cdx execute abc123 --until-done

# Check status mid-execution (from another terminal)
cdx goal status abc123

# Output:
# Goal: Implement CMS management [active]
# Progress: 3/7 WPs completed
#
# Completed:
#   [x] WP1: Scan project structure
#   [x] WP2: Design API schema
#   [x] WP3: Implement CRUD endpoints
#
# Active:
#   [>] WP4: Add validation middleware (attempt 2/3, focused strategy)
#
# Remaining:
#   [ ] WP5: Write integration tests
#   [ ] WP6: Update UI components
#   [ ] WP7: Final verification
#
# Last snapshot: 2m ago
# Current run: def456 (running, 45s)
# Total cost: $1.2345
# Total duration: 12m 30s

# Inspect detailed state
cdx goal inspect abc123
# Shows: all snapshots, all attempts, blocker history, decisions made
```

### Existing Commands (unchanged)

All existing commands (`cdx run`, `cdx tasks`, `cdx runs`, `cdx logs`, `cdx report`, `cdx resume`, config) remain unchanged. They operate on the execution layer directly.

---

## F. Implementation Plan

### Phase 1: Data Model Foundation

New types, schema, migrations, repository CRUD for all 5 new entities.

**Files:**
- Create: `src/types/supervisor.ts`
- Modify: `src/core/storage/schema.ts` (add tables + indexes)
- Create: `src/core/storage/supervisor-repository.ts`
- Create: `tests/storage/supervisor-repository.test.ts`

### Phase 2: Goal + WP Creation from Plan

Parse a plan markdown file into goal + work packages. Support both `--plan <file>` and `--task "<description>"` (single WP).

**Files:**
- Create: `src/core/supervisor/plan-parser.ts`
- Create: `src/cli/commands/goal.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/core/plan-parser.test.ts`

### Phase 3: Execution Loop Core

The main supervisor loop: pick WP → build prompt → run engine → parse results → update state → loop.

**Files:**
- Create: `src/core/supervisor/loop.ts`
- Create: `src/core/supervisor/scheduler.ts`
- Create: `src/core/supervisor/prompt-builder.ts`
- Create: `src/cli/commands/execute.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/core/supervisor-loop.test.ts`
- Create: `tests/core/supervisor-scheduler.test.ts`

### Phase 4: Compaction + Snapshots

Build high-quality snapshots between runs. This is the "auto-compact" — transferring state from one run to the next.

**Files:**
- Create: `src/core/supervisor/compactor.ts`
- Create: `tests/core/compactor.test.ts`

### Phase 5: Progress Detection + Stall Recovery

Detect real progress, handle stalls, mutate prompt strategy, classify blockers.

**Files:**
- Create: `src/core/supervisor/progress.ts`
- Create: `src/core/supervisor/recovery.ts`
- Create: `tests/core/progress.test.ts`
- Create: `tests/core/recovery.test.ts`

### Phase 6: Goal Status + Inspect Commands

CLI commands for monitoring goals.

**Files:**
- Modify: `src/cli/commands/goal.ts` (add status, inspect, list)
- Create: `src/cli/commands/session.ts`

---

## Acceptance Criteria

### Outcome 1: Goal-driven execution
```bash
cdx goal create "implement feature" --plan plan.md --engine claude --path ./project
cdx execute <goalId> --until-done
# → Conductor runs through all WPs autonomously
# → Only stops when done or hard-blocked
```

### Outcome 2: Auto-compact + auto-resume
```
Run 1: Engine works on WP3, exits after 200s
  → Conductor captures report, builds snapshot
  → Conductor builds new prompt with snapshot context
  → Conductor starts Run 2 automatically
Run 2: Continues from where Run 1 left off
  → No user intervention needed
```

### Outcome 3: Stall recovery
```
Attempt 1: WP4 fails (test error)
  → retry_count=1, strategy=focused
Attempt 2: WP4 fails again (same error)
  → retry_count=2, strategy=surgical
Attempt 3: WP4 still fails
  → retry_budget exhausted → classify blocker → skip or escalate
  → NOT infinite retry loop
```

### Outcome 4: Observable state
```bash
cdx goal status <id>
# Shows: which goal, which WP, what's done, what's left, why stopped
```
