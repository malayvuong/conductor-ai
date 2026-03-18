# Conductor Current-State Report

**Date:** 2026-03-18
**Version:** 2026.3.18
**Codebase:** ~6,200 lines source / ~4,500 lines tests / 299 test cases / 29 test files

---

## 1. Executive Summary

**What is working:**

Supervisor Layer:
- Session-first UX: session start/list/status/inspect/history + current/pause/resume/switch/close
- `cdx execute plan.md --until-done` — plan mode with WP decomposition
- `cdx execute "task description" --until-done` — no-plan mode with evidence-based completion
- Resume after interruption: Ctrl+C pauses session/goal, next `cdx execute --until-done` resumes
- Transactional finalization: goal + session + closeout written atomically, SIGINT-safe completion
- Goal lifecycle: created → active → paused/completed/failed/hard_blocked/abandoned
- Auto-pause old goal when starting new task mid-session
- Closeout summary per goal (files, decisions, blockers, next action)
- Enhanced insight extraction: decisions, assumptions, open questions, follow-ups, constraints
- Prompt strategy escalation: normal → focused → surgical → recovery
- Snapshot compaction between runs preserves full execution context
- Live progress output: compact single-line events replacing scattered log.info() calls
- Inspect drill-down: `--goal N`, `--attempts`, `--snapshots`, `--insights` flags
- Session management: current, pause, resume, switch, close commands
- Session hygiene: passive warnings for stale sessions (>7 days) and paused goal accumulation (>=3)
- History: compact format with seq numbers, `--verbose` for full detail

Operational UX:
- Configuration layer: `cdx config set/get/show/unset` with short key aliases (engine, path, heartbeat, stuck-threshold)
- Engine resolution chain: CLI flag → session → config → env → helpful onboarding error
- `cdx doctor` — environment and configuration diagnostic with actionable next steps
- Live heartbeat visibility during execution: file count, idle time, last tool, strategy, stall warnings
- Live run info in `cdx status` and `cdx inspect`: run age, heartbeat status, strategy
- `LiveRunTracker` — real-time file/tool tracking from streaming engine output

Execution Layer (stable):
- CLI surface: 15 commands + 5 session subcommands + 4 config subcommands + doctor
- Task intake, classification (Vietnamese + English), persistence
- Prompt template system: 4 task types × 2 engines
- SQLite persistence for all entities with auto-migrations
- Claude stream-json adapter with real-time display
- Heartbeat monitoring (state-tracked, no spam)
- Task-type-aware structured report generation
- Resume with curated context from best previous run
- 299 tests pass across 29 test files

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
| `cdx session status` / `cdx status` | Working | Shows session, active goal, WP progress, retries, hygiene warnings. |
| `cdx session inspect` / `cdx inspect` | Working | Full dump or drill-down with --goal, --attempts, --snapshots, --insights. |
| `cdx session history` | Working | Compact format with seq numbers. --verbose for full detail. |
| `cdx session current` | Working | Shows which session is active. |
| `cdx session pause` | Working | Pauses session + active goal. |
| `cdx session resume [name]` | Working | Resumes paused session (by name or most recent). |
| `cdx session switch <name>` | Working | Pauses current, activates target session. |
| `cdx session close` | Working | Closes session. Unfinished goals → abandoned with closeout. |
| `cdx execute [source] --until-done` | Working | Plan mode, no-plan mode, resume. Live progress output. |
| `cdx run` | Working | Single-run orchestration (execution layer). |
| `cdx resume <taskId>` | Working | Two-layer context selection + structured prompt. |
| `cdx tasks` | Working | Lists all tasks. No status filter. |
| `cdx logs <runId>` | Working (degraded) | Shows raw JSON for Claude runs. |
| `cdx report <runId>` | Working | Task-type-specific display with null suppression. |
| `cdx runs show <runId>` | Working | Run metadata inspection. |
| `cdx config set/get/show/unset` | Working | Full config management with key aliases. |
| `cdx doctor` | Working | Environment diagnostic: config, engines, session, env vars. |
| `cdx set-path / get-path / clear-path` | Working (legacy) | Legacy aliases for config path. |

---

## 3. Supervisor Layer

### Sessions
**Status: Working.** Session is the primary UX surface. `getActiveSession()` prefers active/created, falls back to paused (handles Ctrl+C interrupts). Session resolution: by name or most recent active. Full lifecycle: current, pause, resume, switch, close. Shared primitives `pauseCurrentSession()` and `activateSession()` used across commands.

### Goals
**Status: Working.** Goals are internal to the supervisor. Two source types:
- `plan_file` — from plan.md, decomposed into multiple WPs
- `inline_task` — from ad-hoc text, single WP with stricter completion

Lifecycle: created → active → paused/completed/failed/hard_blocked/abandoned. Auto-pause when user starts new task while old goal is active. Goal lookup by seq number (1-based, ordered by `created_at ASC, rowid ASC`).

### Work Packages
**Status: Working.** Scheduler picks next WP by seq order, skips completed/blocked. Retry budget (3 for plan, 2 for ad-hoc). Blocker tracking (hard/soft with detail).

### Snapshots
**Status: Working.** Compactor builds snapshots between runs capturing: completed/in-progress/remaining items, decisions, constraints, related files, blockers, next action, assumptions, unresolved questions, follow-ups. Enhanced insight extraction via structured markdown sections (`## Assumptions Made`, `## Open Questions`, etc.) with pattern matching fallback.

### Execution Attempts
**Status: Working.** Each run is tracked as an attempt with: prompt strategy, progress detection, files changed count, WP completion count, blocker info.

### Progress Detection
**Status: Working.** Two modes:
- Plan mode: completion signal in report summary/final_output is sufficient
- No-plan mode: completion signal + evidence required (files_changed, fix_applied, verification, or what_implemented)

### Live Progress Output
**Status: Working.** `formatProgressEvent()` pure functions format 9 event types as compact single-line output (7 original + heartbeat + stall_warning). Integrated into supervisor loop with real-time heartbeat visibility: file count, idle time, last tool, strategy. `LiveRunTracker` accumulates file/tool stats from streaming engine output. Stall detection emits visible warning when no output exceeds threshold.

### Session Hygiene
**Status: Working.** Pure function guardrails: `checkStaleSession()` warns after 7 days idle, `checkPausedGoals()` warns at 3+ paused goals. Injected into status display. Passive warnings only — never blocks execution.

### State Consistency & Finalization
**Status: Fixed (was P0 bug).** Transactional finalization ensures goal + session + closeout are written atomically via `db.transaction()`. SIGINT race condition fixed: completion check runs at end of loop body (after WP update) AND in the interrupt path, preventing the scenario where all WPs complete but goal/session are incorrectly set to 'paused'. `persistCloseout()` now propagates errors instead of silently swallowing them. 11 regression tests cover all finalization paths.

### Closeout Summary
**Status: Working.** Generated at every terminal state (completed, failed, hard_blocked, abandoned). Structured JSON with: source, objective, final status, attempt/WP counts, files touched, key decisions, blockers, next recommended action, cost estimate.

---

## 4. Execution Layer

### Task Intake
**Status: Working.** Task classification via regex for Vietnamese + English keywords. All 4 task types covered (debug_fix, scan_review, implement_feature, verify_only).

### Prompt Generation
**Status: Working.** Templates for all 4 types × 2 engines. Variable substitution. Resume prompt built from curated context. Supervisor prompts now include insight section instructions (Assumptions Made, Open Questions, Follow-up Items, Constraints Discovered).

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
| Session management | Ready | Start, list, status, inspect, history, current, pause, resume, switch, close |
| Plan execution | Ready | Parse → WPs → loop → snapshot → advance |
| No-plan execution | Ready | Single WP with evidence-based completion |
| Resume after interrupt | Ready | Ctrl+C pauses, next execute resumes seamlessly |
| Task switching | Ready | Auto-pause old goal, inform user, activate new |
| Goal lifecycle | Ready | All states covered with proper transitions |
| Closeout summary | Ready | Generated at all terminal states |
| Insight extraction | Ready | Decisions, assumptions, questions, follow-ups, constraints from reports |
| Live progress output | Ready | Compact single-line events during execution |
| Inspect drill-down | Ready | --goal, --attempts, --snapshots, --insights flags |
| Session hygiene | Ready | Passive warnings for stale sessions and paused goal accumulation |
| Single-run execution | Ready | Full pipeline with diagnostics, streaming, reporting |
| Engine execution | Ready (Claude) / Untested (Codex) | Claude adapter verified |
| Log retrieval | Not ready | `cdx logs` shows raw JSON, not parsed text |
| Reporting | Ready | Task-type-aware extraction, no hallucination |
| Resume | Ready | Quality-rated context, run linkage |
| Persistence | Ready | All entities, auto-migrations, WAL mode, transactional finalization |
| State consistency | Ready (fixed) | SIGINT-safe completion, atomic goal+session+closeout writes, 11 regression tests |
| Configuration | Ready | `cdx config` set/get/show/unset, engine resolution chain, `cdx doctor` |
| Live heartbeat | Ready | Real-time file/tool tracking, stall detection, visible in status/inspect |

---

## 6. Recommended Development Order

### P0 — Fix remaining degraded functionality

1. **Fix `cdx logs` to display parsed output for JSON log lines**

### P1 — Robustness

2. **End-to-end validation with real engines** — Run full supervisor loop with Claude, verify WP advancement, snapshot quality, and closeout generation.

3. ~~**Wrap multi-step DB operations in transactions**~~ — Done. Goal finalization (status + closeout) now uses `db.transaction()`. Goal creation + WP creation still non-transactional (low risk, single-user CLI).

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
| src/cli/commands/session.ts | Session management (start/list/status/inspect/history/current/pause/resume/switch/close) + display helpers |
| src/cli/commands/execute.ts | Supervisor execution (plan + no-plan + resume) with progress output |
| src/cli/commands/goal.ts | [Internal] Goal management |
| src/cli/commands/run.ts | Single-run orchestration |
| src/cli/commands/resume.ts | Resume with curated context |
| src/cli/commands/tasks.ts | List tasks |
| src/cli/commands/logs.ts | View run logs |
| src/cli/commands/report.ts | Task-type-specific report display |
| src/cli/commands/runs.ts | Run metadata inspection |
| src/cli/commands/config.ts | Config commands (set/get/show/unset + legacy aliases) |
| src/cli/commands/doctor.ts | Environment diagnostic command |
| **Supervisor** | |
| src/core/supervisor/loop.ts | Main supervisor loop (transactional finalization, SIGINT-safe, progress events) |
| src/core/supervisor/scheduler.ts | WP scheduling + status counting |
| src/core/supervisor/plan-parser.ts | Markdown plan → WP decomposition |
| src/core/supervisor/prompt-builder.ts | Supervisor prompt (plan + ad-hoc modes) + insight instructions |
| src/core/supervisor/progress.ts | Evidence-based progress detection |
| src/core/supervisor/compactor.ts | Snapshot builder + enhanced insight extraction |
| src/core/supervisor/closeout.ts | Goal closeout summary generation |
| src/core/supervisor/progress-reporter.ts | Live progress event formatting (pure functions, 9 event types) |
| src/core/supervisor/live-tracker.ts | Real-time file/tool tracking from streaming output |
| src/core/supervisor/hygiene.ts | Session health warnings (stale, paused goals) |
| **Storage** | |
| src/core/storage/schema.ts | SQL DDL + migrations (incl. enhanced compaction columns) |
| src/core/storage/db.ts | SQLite singleton (WAL mode) |
| src/core/storage/repository.ts | Execution layer CRUD |
| src/core/storage/supervisor-repository.ts | Supervisor layer CRUD + getGoalBySeq |
| **Engine** | |
| src/core/engine/types.ts | Adapter interface + factory |
| src/core/engine/claude.ts | Claude CLI adapter |
| src/core/engine/codex.ts | Codex CLI adapter |
| src/core/engine/stream-parser.ts | JSON event parser |
| src/core/engine/log-interpreter.ts | Unified log parsing |
| **Other Core** | |
| src/core/config/service.ts | Config read/write, resolveEngine(), key aliases, onboarding messages |
| src/core/task/normalizer.ts | Task classification |
| src/core/prompt/builder.ts | Template loading + substitution |
| src/core/runner/process.ts | spawn wrapper |
| src/core/heartbeat/monitor.ts | Heartbeat monitoring |
| src/core/report/generator.ts | Task-type-aware report extraction |
| src/core/resume/context.ts | Best-run selection + typed context |
| src/core/resume/prompt.ts | Resume prompt rendering |
| **Types** | |
| src/types/index.ts | Execution layer types |
| src/types/supervisor.ts | Supervisor layer types (incl. enhanced Snapshot) |
| src/core/engine/types.ts | Adapter interface + factory + getAvailableEngines() |
| **Tests** | |
| tests/ (29 files) | 299 test cases |
| prompts/ (8 files) | Prompt templates |

---

## 8. What Changed Since V1

| Area | V1 (Execution Layer Only) | V2 (Session-First + Supervisor) |
|------|---------------------------|----------------------------------|
| UX surface | `cdx run --task "..."` | `cdx session start` → `cdx execute plan.md --until-done` |
| Architecture | Single execution layer | Two-layer: supervisor + execution |
| Session concept | None | Primary UX surface with name, status, goals |
| Session management | None | current, pause, resume, switch, close |
| Goal management | None | Internal to supervisor, lifecycle states, auto-pause |
| Work packages | None | Ordered, with retry budget, blocker tracking |
| Execution loop | Single run | Supervisor loop: schedule → dispatch → evaluate → snapshot → advance |
| Live progress | None | Compact single-line events + heartbeat visibility + stall detection |
| Configuration | `set-path` only | `cdx config` set/get/show/unset + engine resolution chain + `cdx doctor` |
| Snapshots | None | Full state captured between runs for context continuity |
| No-plan mode | N/A | Ad-hoc tasks with evidence-based completion |
| Insight extraction | None | Decisions, assumptions, questions, follow-ups, constraints |
| Closeout summary | None | Structured JSON at terminal states |
| Progress detection | None | Keyword + evidence-based (plan vs ad-hoc modes) |
| Inspect drill-down | None | --goal, --attempts, --snapshots, --insights flags |
| Session hygiene | None | Passive warnings for stale sessions and paused goal accumulation |
| Prompt strategy | Static | Escalation: normal → focused → surgical → recovery |
| DB tables | 5 (tasks, runs, logs, heartbeats, reports) | 10 (+ sessions, goals, work_packages, snapshots, execution_attempts) |
| State consistency | None | Transactional finalization, SIGINT-safe completion, 11 regression tests |
| Source lines | ~1,700 | ~6,200 |
| Test cases | 114 across 14 files | 299 across 29 files |
