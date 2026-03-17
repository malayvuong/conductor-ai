# Conductor Current-State Report

**Date:** 2026-03-17
**Version:** 2026.3.17
**Codebase:** ~1,700 lines source / ~1,200 lines tests / 114 test cases / 14 test files

---

## 1. Executive Summary

**What is working:**
- CLI surface fully wired: 6 commands + 3 config subcommands, all callable
- Task intake, classification, and persistence work correctly
- Prompt template system works for all 4 task types x 2 engines (8 templates)
- SQLite persistence for tasks, runs, logs, heartbeats, reports — all functional
- Config service at ~/.conductor/config.json — functional
- Heartbeat tracks state transitions without spam
- Process runner supports cwd propagation and stdin pipe
- Stream parser extracts readable output from Claude's stream-json events
- **Report generator produces task-type-aware structured reports** — uses markdown section parsing, semantic file classification, and sub-agent isolation
- **Resume command builds curated context from best previous run** — two-layer architecture (context selection + prompt rendering), run linkage tracking
- **Report display renders task-type-specific fields** — scan_review, debug_fix, implement_feature each show only relevant fields
- CI/CD pipelines defined for GitHub Actions
- 114 tests pass across 14 test files

**What is partially implemented:**
- Log display: `cdx logs` shows raw JSON lines for Claude runs, not parsed human-readable text

**What is not working / risky:**
- `cdx logs` displays raw stream-json lines — not useful for human inspection after the fact
- No `runs show <runId>` command exists for inspecting run metadata directly
- No way to filter tasks by status (`cdx tasks --status running`)
- Codex adapter untested with real engine

---

## 2. Command Surface Status

| Command | Status | Notes |
|---------|--------|-------|
| `cdx run` | Working | Full orchestration with config fallbacks, streaming, diagnostics, task-type-aware report generation |
| `cdx tasks` | Working | Lists all tasks. No status filter. |
| `cdx logs <runId>` | Working (degraded) | Works but shows raw JSON for Claude runs. Short ID supported. |
| `cdx report <runId>` | Working | Task-type-specific display (scan_review, debug_fix, implement_feature, generic). Null fields hidden. |
| `cdx resume <taskId>` | Working | Two-layer architecture: best-run selection + typed context + structured prompt. Supports --task/--engine/--path overrides. Run linkage via resumed_from_run_id. |
| `cdx set-path <path>` | Working | Validates path exists, saves to config |
| `cdx get-path` | Working | Shows default path or hint |
| `cdx clear-path` | Working | Removes default path |
| `cdx runs show <runId>` | Missing | No way to inspect run metadata directly |
| `cdx --version` | Working | Shows 2026.3.17 |

---

## 3. Core Pipeline Status

### Task Intake
**Status: Working.** Task is created in SQLite with raw_input, workspace_path, engine. Classification via regex is functional for Vietnamese + English keywords. All 4 task types covered.

### Prompt Generation
**Status: Working.** Templates exist for all 4 types x 2 engines. Variable substitution works. Resume prompt built from curated context with task-type-specific continuation guidelines.

### Engine Execution
**Status: Working (Claude) / Untested (Codex).** Claude adapter uses `--print --output-format stream-json --verbose --dangerously-skip-permissions` with prompt piped via stdin. Process runner passes cwd correctly.

### Log Streaming
**Status: Working for terminal display, degraded for persistence retrieval.** During execution, stream-parser extracts human-readable text from JSON events and displays it. Raw JSON is persisted to DB. However, `cdx logs` displays the raw JSON — not the parsed version.

### Heartbeat
**Status: Working.** State-tracked transitions: alive → idle → suspected_stuck → recovered. Only emits on transitions (no spam). Configurable interval and threshold via config.

### Persistence
**Status: Working.** All 5 tables populated correctly. Foreign keys enforced. WAL mode enabled. Schema migrations run automatically (new report columns, resumed_from_run_id).

### Reporting
**Status: Working.** Report generator (340 lines) uses:
- **Log interpretation** — typed events (text, tool_use, tool_result, error, result)
- **Sub-agent isolation** — position-based separation prevents sub-agent `[DONE]` results from contaminating summary/final_output
- **Semantic file classification** — Edit/Write/NotebookEdit = changed, Read/Grep/Glob/Bash/Agent = inspected
- **Markdown section parsing** — `extractSections()` + `findSection()` extract structured fields from `## Header` sections in the agent's final report block
- **Task-type gating** — fields only populated when they match the task type (findings for scan_review, root_cause for debug_fix, what_implemented for implement_feature)
- **Strict verification** — only concrete evidence accepted ("15 tests passed"), tables and vague mentions rejected
- **No hallucination** — fields stay null unless the agent writes matching markdown sections

### Resume
**Status: Working.** Two-layer architecture:
1. **Context selection** (`selectBestRun`) — picks best previous run by priority: completed+report > failed+report > any+report
2. **Context building** (`buildResumeContext`) — extracts task-type-specific sections from the report, rates quality as full/partial/limited
3. **Prompt rendering** (`renderResumePrompt`) — structured continuation prompt with workspace, original task, context sections, quality warning, new instruction, task-type-specific continuation guidelines
4. **Run linkage** — `resumed_from_run_id` column traces resume chains

### Report Display
**Status: Working.** Task-type-specific rendering:
- `scan_review` → Summary, Findings, Risks, Recommendations, Files Inspected
- `debug_fix` → Summary, Root Cause, Fix Applied, Files Changed, Verification, Remaining Risks
- `implement_feature` → Summary, What Was Implemented, Files Changed, Validation, Follow-up Notes
- generic → Summary, Files Inspected, Files Changed, Verification

Null fields hidden automatically.

---

## 4. Readiness Assessment

| Area | Status | Detail |
|------|--------|--------|
| Run command | Ready | Full pipeline wired with diagnostics, streaming, config fallbacks |
| Engine execution | Ready (Claude) / Untested (Codex) | Claude adapter flags are correct. Codex adapter unverified. |
| Log streaming (terminal) | Ready | Stream-parser extracts readable content during execution |
| Log retrieval (after run) | Not ready | `cdx logs` shows raw JSON, not human-readable parsed text |
| Reporting | Ready | Task-type-aware extraction with markdown parsing, no regex heuristics |
| Report display | Ready | Task-type-specific rendering with null suppression |
| Resume | Ready | Two-layer context selection + prompt rendering, quality-rated, run linkage |
| Heartbeat | Ready | State-tracked, configurable, no spam |
| Persistence | Ready | All entities persisted correctly, schema migrations automated |
| Configuration | Ready | Default path, engine, heartbeat settings all functional |

---

## 5. Recommended Development Order

### P0 — Fix remaining degraded functionality

1. **Fix `cdx logs` to display parsed output for JSON log lines**
   The same log-interpreter used during execution and report generation should be applied when displaying logs. Currently logs show raw JSON which is useless for debugging.

### P1 — Add missing observability

2. **Add `cdx runs show <runId>` command**
   Display run metadata: engine, command, args, cwd, pid, status, started_at, finished_at, exit_code, prompt length, resumed_from_run_id. Essential for debugging.

3. **Add `cdx tasks --status <status>` filter**
   Practical for managing multiple tasks.

### P2 — Robustness

4. **Add `--dangerously-skip-permissions` acceptance check**
   Before launching Claude, verify that the permission mode has been accepted. Fail with a clear message if not.

5. **Wrap multi-step DB operations in transactions**
   Create task + create run + update status should be atomic.

### P3 — Enhancements

6. **End-to-end validation with real engines**
   Run `cdx run` with Claude, verify report extraction produces correct structured fields from actual output.

7. **Resume chain visualization**
   Show resume history for a task: original run → resumed run → resumed run, with context quality at each step.

---

## 6. Files / Modules

| File | Lines | Role |
|------|-------|------|
| src/cli/index.ts | 24 | CLI entry point |
| src/cli/commands/run.ts | 216 | Main orchestration |
| src/cli/commands/resume.ts | 207 | Resume with curated context (two-layer architecture) |
| src/cli/commands/tasks.ts | 21 | List tasks |
| src/cli/commands/logs.ts | 62 | View run logs |
| src/cli/commands/report.ts | 112 | Task-type-specific report display |
| src/cli/commands/config.ts | 44 | Config commands |
| src/core/config/service.ts | 37 | Config read/write |
| src/core/engine/types.ts | 34 | Adapter interface + factory |
| src/core/engine/claude.ts | 30 | Claude adapter |
| src/core/engine/codex.ts | 29 | Codex adapter |
| src/core/engine/stream-parser.ts | 14 | Wrapper for backward compat |
| src/core/engine/log-interpreter.ts | 212 | Unified log parsing into typed events |
| src/core/runner/process.ts | 74 | spawn wrapper |
| src/core/heartbeat/monitor.ts | 72 | Heartbeat with state tracking |
| src/core/task/normalizer.ts | 63 | Task classification |
| src/core/prompt/builder.ts | 39 | Template loading + substitution |
| src/core/report/generator.ts | 340 | Task-type-aware report extraction |
| src/core/resume/context.ts | 187 | Best-run selection + typed context building |
| src/core/resume/prompt.ts | 101 | Structured resume prompt rendering |
| src/core/storage/schema.ts | 100 | SQL DDL + migrations |
| src/core/storage/db.ts | 42 | SQLite singleton |
| src/core/storage/repository.ts | 157 | All CRUD operations |
| src/types/index.ts | 73 | Shared types |
| src/utils/logger.ts | 10 | Timestamped logger |
| src/utils/lookup.ts | 29 | Short ID prefix resolver |
| tests/ (14 files) | ~1,200 | 114 test cases |
| prompts/ (8 files) | ~90 | Prompt templates |
| .github/workflows/ (2 files) | 59 | CI + Release pipelines |

---

## 7. What Changed Since Initial Build

| Area | Before | After |
|------|--------|-------|
| Report generator | 76 lines, regex-based extraction on random text, all fields attempted for all task types | 340 lines, markdown section parsing, semantic file classification, sub-agent isolation, task-type gating, strict verification |
| Report display | Single generic render showing all fields | 4 render paths (scan_review, debug_fix, implement_feature, generic), null suppression |
| Resume command | Shallow context (report summary + last 20 raw log lines), no overrides | Two-layer architecture (context selection + prompt rendering), quality-rated, typed sections, --task/--engine/--path overrides, run linkage |
| Resume context | None (inline in command) | Dedicated `context.ts` (187 lines): selectBestRun, buildResumeContext, quality determination |
| Resume prompt | None (inline in command) | Dedicated `prompt.ts` (101 lines): renderResumePrompt with task-type-specific continuation guidelines |
| Schema | 5 tables, basic columns | 5 tables + migrations for 8 new report columns + resumed_from_run_id |
| Types | Basic Run/RunReport | Run has resumed_from_run_id; RunReport has files_inspected_json, final_output, findings, risks, recommendations, what_implemented, follow_ups |
| Tests | 51 tests, 11 files | 114 tests, 14 files |
