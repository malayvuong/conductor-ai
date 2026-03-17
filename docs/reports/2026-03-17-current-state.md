# Conductor Current-State Report

**Date:** 2026-03-17
**Version:** 2026.3.17
**Codebase:** ~5,150 lines source / ~3,320 lines tests / 224 test cases / 21 test files

---

## 1. Executive Summary

**What is working:**

Supervisor Layer (new):
- Session-first UX: session start/list/status/inspect/history
- `cdx execute plan.md --until-done` — plan mode with WP decomposition
- `cdx execute "task description" --until-done` — no-plan mode with evidence-based completion
- Resume after interruption: Ctrl+C pauses session/goal, next `cdx execute --until-done` resumes
- Goal lifecycle: created → active → paused/completed/failed/hard_blocked/abandoned
- Auto-pause old goal when starting new task mid-session
- Closeout summary per goal (files, decisions, blockers, next action)
- Decision extraction from run reports
- Prompt strategy escalation: normal → focused → surgical → recovery
- Snapshot compaction between runs preserves full execution context

Execution Layer (stable):
- CLI surface: 10 commands + 3 config subcommands
- Task intake, classification (Vietnamese + English), persistence
- Prompt template system: 4 task types × 2 engines
- SQLite persistence for all entities with auto-migrations
- Claude stream-json adapter with real-time display
- Heartbeat monitoring (state-tracked, no spam)
- Task-type-aware structured report generation
- Resume with curated context from best previous run
- 224 tests pass across 21 test files

**What is partially implemented:**
- `cdx logs` shows raw JSON lines for Claude runs (not parsed human-readable text)
- Codex adapter untested with real engine

**What is not working / risky:**
- No way to filter tasks by status (`cdx tasks --status running`)
- Codex adapter unverified with actual engine

---

## 2. Command Surface Status

| Command | Status | Notes |
|---------|--------|-------|
| `cdx session start <name>` | Working | Creates or reactivates session. Supports --engine, --path. |
| `cdx session list` | Working | Lists sessions with status filter. |
| `cdx session status` / `cdx status` | Working | Shows session, active goal, WP progress, retries. |
| `cdx session inspect` / `cdx inspect` | Working | Deep dive: goals, WPs, attempts, snapshots, closeout. |
| `cdx session history` | Working | Goal history as reference. |
| `cdx execute [source] --until-done` | Working | Plan mode, no-plan mode, resume. Auto-pause on task switch. |
| `cdx run` | Working | Single-run orchestration (execution layer). |
| `cdx resume <taskId>` | Working | Two-layer context selection + structured prompt. |
| `cdx tasks` | Working | Lists all tasks. No status filter. |
| `cdx logs <runId>` | Working (degraded) | Shows raw JSON for Claude runs. |
| `cdx report <runId>` | Working | Task-type-specific display with null suppression. |
| `cdx runs show <runId>` | Working | Run metadata inspection. |
| `cdx set-path / get-path / clear-path` | Working | Config management. |

---

## 3. Supervisor Layer

### Sessions
**Status: Working.** Session is the primary UX surface. `getActiveSession()` prefers active/created, falls back to paused (handles Ctrl+C interrupts). Session resolution: by name or most recent active.

### Goals
**Status: Working.** Goals are internal to the supervisor. Two source types:
- `plan_file` — from plan.md, decomposed into multiple WPs
- `inline_task` — from ad-hoc text, single WP with stricter completion

Lifecycle: created → active → paused/completed/failed/hard_blocked/abandoned. Auto-pause when user starts new task while old goal is active.

### Work Packages
**Status: Working.** Scheduler picks next WP by seq order, skips completed/blocked. Retry budget (3 for plan, 2 for ad-hoc). Blocker tracking (hard/soft with detail).

### Snapshots
**Status: Working.** Compactor builds snapshots between runs capturing: completed/in-progress/remaining items, decisions, constraints, related files, blockers, next action. Decision extraction parses `## Decisions` sections and "decided to..." patterns from reports.

### Execution Attempts
**Status: Working.** Each run is tracked as an attempt with: prompt strategy, progress detection, files changed count, WP completion count, blocker info.

### Progress Detection
**Status: Working.** Two modes:
- Plan mode: completion signal in report summary/final_output is sufficient
- No-plan mode: completion signal + evidence required (files_changed, fix_applied, verification, or what_implemented)

### Closeout Summary
**Status: Working.** Generated at every terminal state (completed, failed, hard_blocked, abandoned). Structured JSON with: source, objective, final status, attempt/WP counts, files touched, key decisions, blockers, next recommended action, cost estimate.

---

## 4. Execution Layer

### Task Intake
**Status: Working.** Task classification via regex for Vietnamese + English keywords. All 4 task types covered (debug_fix, scan_review, implement_feature, verify_only).

### Prompt Generation
**Status: Working.** Templates for all 4 types × 2 engines. Variable substitution. Resume prompt built from curated context.

### Engine Execution
**Status: Working (Claude) / Untested (Codex).** Claude adapter uses `--print --output-format stream-json --verbose --dangerously-skip-permissions`.

### Reporting
**Status: Working.** Report generator uses log interpretation, sub-agent isolation, semantic file classification, markdown section parsing, and task-type gating.

### Resume
**Status: Working.** Two-layer architecture: best-run selection + typed context building + quality-rated prompt rendering. Run linkage via `resumed_from_run_id`.

---

## 5. Readiness Assessment

| Area | Status | Detail |
|------|--------|--------|
| Session management | Ready | Start, list, status, inspect, history — all working |
| Plan execution | Ready | Parse → WPs → loop → snapshot → advance |
| No-plan execution | Ready | Single WP with evidence-based completion |
| Resume after interrupt | Ready | Ctrl+C pauses, next execute resumes seamlessly |
| Task switching | Ready | Auto-pause old goal, inform user, activate new |
| Goal lifecycle | Ready | All states covered with proper transitions |
| Closeout summary | Ready | Generated at all terminal states |
| Decision extraction | Ready | From report sections and text patterns |
| Single-run execution | Ready | Full pipeline with diagnostics, streaming, reporting |
| Engine execution | Ready (Claude) / Untested (Codex) | Claude adapter verified |
| Log retrieval | Not ready | `cdx logs` shows raw JSON, not parsed text |
| Reporting | Ready | Task-type-aware extraction, no hallucination |
| Resume | Ready | Quality-rated context, run linkage |
| Persistence | Ready | All entities, auto-migrations, WAL mode |
| Configuration | Ready | Default path, engine, heartbeat settings |

---

## 6. Recommended Development Order

### P0 — Fix remaining degraded functionality

1. **Fix `cdx logs` to display parsed output for JSON log lines**

### P1 — Robustness

2. **End-to-end validation with real engines** — Run full supervisor loop with Claude, verify WP advancement, snapshot quality, and closeout generation.

3. **Wrap multi-step DB operations in transactions** — Goal creation + WP creation should be atomic.

### P2 — Enhancements

4. **Add `cdx tasks --status <status>` filter**

5. **Resume chain visualization** — Show resume history for a task across runs.

6. **Multi-goal execution** — Support executing multiple goals from a single plan file.

---

## 7. Files / Modules

| File | Role |
|------|------|
| **CLI** | |
| src/cli/index.ts | CLI entry point + command registration |
| src/cli/commands/session.ts | Session management + display helpers |
| src/cli/commands/execute.ts | Supervisor execution (plan + no-plan + resume) |
| src/cli/commands/goal.ts | [Internal] Goal management |
| src/cli/commands/run.ts | Single-run orchestration |
| src/cli/commands/resume.ts | Resume with curated context |
| src/cli/commands/tasks.ts | List tasks |
| src/cli/commands/logs.ts | View run logs |
| src/cli/commands/report.ts | Task-type-specific report display |
| src/cli/commands/runs.ts | Run metadata inspection |
| src/cli/commands/config.ts | Config commands |
| **Supervisor** | |
| src/core/supervisor/loop.ts | Main supervisor loop (until-done) |
| src/core/supervisor/scheduler.ts | WP scheduling + status counting |
| src/core/supervisor/plan-parser.ts | Markdown plan → WP decomposition |
| src/core/supervisor/prompt-builder.ts | Supervisor prompt (plan + ad-hoc modes) |
| src/core/supervisor/progress.ts | Evidence-based progress detection |
| src/core/supervisor/compactor.ts | Snapshot builder + decision extraction |
| src/core/supervisor/closeout.ts | Goal closeout summary generation |
| **Storage** | |
| src/core/storage/schema.ts | SQL DDL + migrations |
| src/core/storage/db.ts | SQLite singleton (WAL mode) |
| src/core/storage/repository.ts | Execution layer CRUD |
| src/core/storage/supervisor-repository.ts | Supervisor layer CRUD |
| **Engine** | |
| src/core/engine/types.ts | Adapter interface + factory |
| src/core/engine/claude.ts | Claude CLI adapter |
| src/core/engine/codex.ts | Codex CLI adapter |
| src/core/engine/stream-parser.ts | JSON event parser |
| src/core/engine/log-interpreter.ts | Unified log parsing |
| **Other Core** | |
| src/core/config/service.ts | Config read/write |
| src/core/task/normalizer.ts | Task classification |
| src/core/prompt/builder.ts | Template loading + substitution |
| src/core/runner/process.ts | spawn wrapper |
| src/core/heartbeat/monitor.ts | Heartbeat monitoring |
| src/core/report/generator.ts | Task-type-aware report extraction |
| src/core/resume/context.ts | Best-run selection + typed context |
| src/core/resume/prompt.ts | Resume prompt rendering |
| **Types** | |
| src/types/index.ts | Execution layer types |
| src/types/supervisor.ts | Supervisor layer types |
| **Tests** | |
| tests/ (21 files) | 224 test cases |
| prompts/ (8 files) | Prompt templates |

---

## 8. What Changed Since V1

| Area | V1 (Execution Layer Only) | V2 (Session-First + Supervisor) |
|------|---------------------------|----------------------------------|
| UX surface | `cdx run --task "..."` | `cdx session start` → `cdx execute plan.md --until-done` |
| Architecture | Single execution layer | Two-layer: supervisor + execution |
| Session concept | None | Primary UX surface with name, status, goals |
| Goal management | None | Internal to supervisor, lifecycle states, auto-pause |
| Work packages | None | Ordered, with retry budget, blocker tracking |
| Execution loop | Single run | Supervisor loop: schedule → dispatch → evaluate → snapshot → advance |
| Snapshots | None | Full state captured between runs for context continuity |
| No-plan mode | N/A | Ad-hoc tasks with evidence-based completion |
| Decision tracking | None | Extracted from reports, accumulated across snapshots |
| Closeout summary | None | Structured JSON at terminal states |
| Progress detection | None | Keyword + evidence-based (plan vs ad-hoc modes) |
| Prompt strategy | Static | Escalation: normal → focused → surgical → recovery |
| DB tables | 5 (tasks, runs, logs, heartbeats, reports) | 10 (+ sessions, goals, work_packages, snapshots, execution_attempts) |
| Source lines | ~1,700 | ~5,150 |
| Test cases | 114 across 14 files | 224 across 21 files |
