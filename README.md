# Conductor

Supervisor for AI coding CLIs. Manages sessions, decomposes goals into work packages, runs engines (Claude, Codex) in a loop, and produces structured reports with full execution history.

```
User
  |
  v
cdx config set engine claude               # one-time setup
cdx doctor                                # check environment
cdx session start my-project
cdx execute plan.md --until-done          # plan mode
cdx execute "fix login bug" --until-done  # no-plan mode
cdx status                                # check progress
cdx inspect                               # deep dive
cdx inspect --goal 1 --insights           # drill into goal
cdx session pause                         # pause current session
cdx session switch other-project          # switch sessions
  |
  v
┌─────────────── Supervisor Layer ───────────────┐
│  Session → Goal → Work Packages → Snapshots    │
│  Compactor (context between runs)              │
│  Scheduler (WP ordering, retries, blockers)    │
│  Progress detection (evidence-based)           │
│  Closeout summary (per goal)                   │
└────────────────────┬───────────────────────────┘
                     |
┌────────────────────v───────────────────────────┐
│  Execution Layer                               │
│  Task → Run → Logs → Report → Heartbeat        │
│  Engine adapters (Claude, Codex)               │
│  Stream parser, log interpreter                │
└────────────────────────────────────────────────┘
                     |
                     v
               SQLite (local)
```

## Architecture

**Two-layer design:**

- **Supervisor Layer** — Sessions, goals, work packages, snapshots, execution attempts. Manages the "what to do next" loop: parse plan → create WPs → dispatch engine → evaluate result → snapshot state → repeat or finish.
- **Execution Layer** — Tasks, runs, logs, reports, heartbeat. Handles the "how to run" mechanics: classify task → build prompt → spawn engine → stream output → generate report.

**Session-first UX:** Sessions are the primary user-facing surface. Goals are internal state managed by the supervisor. Users never need to handle goal IDs in the happy path.

## Prerequisites

- Node.js 22+
- One of the supported AI CLI tools installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)

## Install

```bash
git clone <repo-url> conductor
cd conductor
npm install
npm run build
npm link          # makes `cdx` available globally
```

## Quick Start

```bash
# First time: set defaults (once)
cdx config set engine claude
cdx config set path /path/to/project

# Check environment
cdx doctor

# Start a session
cdx session start my-project

# Execute a plan file (decomposes into WPs, runs in loop)
cdx execute plan.md --until-done

# Or execute an ad-hoc task (no plan file needed)
cdx execute "fix the login API 500 error" --until-done

# Check progress
cdx status

# Deep inspection (WPs, attempts, snapshots, closeout)
cdx inspect

# Resume after interruption (Ctrl+C pauses, next execute resumes)
cdx execute --until-done

# View session history
cdx session history

# Session management
cdx session current                       # which session is active
cdx session pause                         # pause session + goal
cdx session resume                        # resume most recent paused
cdx session switch other-project          # switch sessions
cdx session close                         # close session

# Inspect drill-down
cdx inspect --goal 1                      # single goal detail
cdx inspect --goal 1 --attempts           # attempt timeline
cdx inspect --goal 1 --snapshots          # snapshot chain
cdx inspect --goal 1 --insights           # decisions, assumptions, questions
```

## Commands

### Session Management

#### `cdx session start <name>`

Start or reactivate a session.

```bash
cdx session start my-project                          # uses config defaults
cdx session start my-project --engine codex            # override engine
cdx session start my-project --path /other/project     # override path
```

| Flag | Required | Description |
|------|----------|-------------|
| `--engine` | No | Override default engine. Uses config/env fallback if omitted. |
| `--path` | No | Override workspace path. Uses config default or cwd if omitted. |

If a session with the same name already exists and is paused/created, it will be reactivated.

#### `cdx session list`

List all sessions with status and goal count.

```bash
cdx session list
cdx session list --status active
```

#### `cdx status`

Show current session status: engine, path, active goal, WP progress, retries.

#### `cdx session current`

Show which session is active.

#### `cdx session pause`

Pause current session and its active goal.

#### `cdx session resume [name]`

Resume a paused session. Without name, resumes most recent paused session.

#### `cdx session switch <name>`

Switch to another session (pauses current, activates target).

#### `cdx session close`

Close current session. Completed goals stay completed, unfinished goals are abandoned with closeout summaries.

#### `cdx status`

Show current session status: engine, path, active goal, WP progress, retries. Includes hygiene warnings for stale sessions and too many paused goals.

#### `cdx inspect`

Detailed inspection of current session. Supports drill-down flags:

```bash
cdx inspect                          # full dump (default)
cdx inspect --goal <N>               # single goal detail
cdx inspect --goal <N> --attempts    # attempt timeline
cdx inspect --goal <N> --snapshots   # snapshot chain
cdx inspect --goal <N> --insights    # decisions, assumptions, questions, follow-ups, constraints
```

#### `cdx session history`

View session goal history. Compact by default, `--verbose` for full detail.

### Execution

#### `cdx execute [source] --until-done`

The main execution command. Behavior depends on input:

| Input | Mode | Behavior |
|-------|------|----------|
| `cdx execute plan.md --until-done` | Plan mode | Parse plan → create WPs → run loop |
| `cdx execute "fix bug" --until-done` | No-plan mode | Create single WP → run with evidence-based completion |
| `cdx execute --until-done` | Resume | Continue active unfinished goal |

**Resume vs New Goal rules:**
- Source provided (file or text) → always creates new goal. If an active unfinished goal exists, it is auto-paused.
- No source → resume only. Continues the active unfinished goal.

### Execution Layer (Low-Level)

#### `cdx run`

Run a single task directly (bypasses supervisor layer).

```bash
cdx run --engine claude --task "fix the login bug"
```

#### `cdx resume <taskId>`

Resume a task with curated context from previous runs.

#### `cdx tasks`

List all tasks with status.

#### `cdx logs <runId>`

View saved logs for a run.

#### `cdx report <runId>`

View the structured report for a run.

#### `cdx runs show <runId>`

Inspect run metadata.

### Configuration

#### `cdx config set <key> <value>`

Set a global config value. Short aliases supported.

```bash
cdx config set engine claude        # set default engine
cdx config set path /path/to/project  # set default workspace path
cdx config set heartbeat 30         # heartbeat interval (seconds)
cdx config set stuck-threshold 120  # stall detection threshold (seconds)
```

#### `cdx config get <key>`

Get a single config value.

```bash
cdx config get engine               # → claude
```

#### `cdx config show`

Show all config values. On fresh install, shows quick-start guide.

#### `cdx config unset <key>`

Remove a config value.

```bash
cdx config unset engine
```

| Key | Alias for | Description |
|-----|-----------|-------------|
| `engine` | `defaultEngine` | Default engine: `claude` or `codex` |
| `path` | `defaultPath` | Default workspace path |
| `heartbeat` | `heartbeatIntervalSec` | Heartbeat check interval (seconds, default 15) |
| `stuck-threshold` | `stuckThresholdSec` | Stall detection threshold (seconds, default 60) |

**Legacy aliases:** `cdx set-path`, `cdx get-path`, `cdx clear-path` still work.

#### `cdx doctor`

Check environment and configuration. Shows what's set up, what's missing, and what to do next.

```bash
cdx doctor
```

```
  [OK] Config file          ~/.conductor/config.json
  [OK] Default engine       claude
  [OK] Engine: claude       found in PATH
  [--] Engine: codex        not found in PATH
  [OK] Default path         /Users/me/projects/my-app
  [OK] Active session       my-project [active]

Ready to go.
```

## Configuration

Persistent config at `~/.conductor/config.json`:

```json
{
  "defaultPath": "/Users/me/projects/my-app",
  "defaultEngine": "claude",
  "heartbeatIntervalSec": 15,
  "stuckThresholdSec": 60
}
```

### Engine Resolution

Engine is resolved with a priority chain — no need to specify `--engine` every time:

1. `--engine` flag on current command
2. Engine stored in session
3. `defaultEngine` in config
4. `DEFAULT_ENGINE` environment variable
5. Helpful error with onboarding instructions

```bash
# One-time setup
cdx config set engine claude

# Then just use sessions
cdx session start my-project
```

## Supervisor Loop

The supervisor loop (`cdx execute ... --until-done`) works as follows:

1. **Parse input** — Plan file → decompose into work packages. Ad-hoc text → single WP.
2. **Schedule** — Pick next WP by seq order, skip completed/blocked.
3. **Build prompt** — Include goal context, WP description, snapshot from previous run (if any), done criteria.
4. **Dispatch engine** — Spawn Claude/Codex with the prompt.
5. **Evaluate** — Parse report, detect progress, check WP completion.
6. **Snapshot** — Capture state (completed items, in-progress, remaining, decisions, files, blockers) for next run's context.
7. **Advance or retry** — Complete WP → next WP. No progress → retry with escalated prompt strategy. Exhausted retries → mark failed.
8. **Finalize check** — After each WP result, immediately check if all WPs are done. If yes, finalize atomically (goal + session + closeout in one transaction). This prevents the SIGINT race where Ctrl+C during the last engine run could leave stale state.
9. **Loop** until all WPs done or hard-blocked.

**Prompt strategy escalation:** normal → focused → surgical → recovery (based on retry count).

**Evidence-based completion** (ad-hoc mode): Completion signal alone is not enough — needs evidence (files_changed, fix_applied, verification, or what_implemented).

**Goal lifecycle:** created → active → paused/completed/failed/hard_blocked/abandoned.

**Closeout summary:** Generated at every terminal state with objective, files touched, decisions, blockers, and next recommended action.

### State Consistency Guarantees

The supervisor loop ensures that DB state is always consistent with execution reality:

- **Transactional finalization** — Goal status + session status + closeout summary are written in a single SQLite transaction. No partial writes possible.
- **SIGINT-safe completion** — After each WP completes, the loop checks for goal completion _before_ checking the interrupted flag. If Ctrl+C fires during the last engine run, the goal still finalizes as completed.
- **Interrupt safety net** — The interrupt path also checks if all WPs are actually done before marking as paused. If the goal completed, it finalizes correctly regardless of interrupt timing.
- **No silent error swallowing** — Closeout generation errors propagate rather than being silently logged.

### Live Progress During Execution

While the loop runs, periodic heartbeat events show real-time status:

```
── session: my-project | goal: Implement CMS ──
[WP 1/5] Scan structure — attempt 1 (normal)
[WP 1/5] heartbeat: alive | files: 3 | idle: 2s | last: Read | strategy: normal
[WP 1/5] heartbeat: alive | files: 8 | idle: 0s | last: Edit | strategy: normal
[WP 1/5] completed
[WP 2/5] Build models — attempt 1 (normal)
[WP 2/5] heartbeat: alive | files: 14 | idle: 5s | last: Write | strategy: normal
[WP 2/5] no output for 65s — possible stall
```

Each heartbeat shows:
- **status**: alive, idle, suspected_stuck, recovered
- **files**: unique files touched during current run
- **idle**: seconds since last engine output
- **last**: most recent tool used (Read, Edit, Write, etc.)
- **strategy**: current prompt strategy

**Stall detection:** When no engine output exceeds the stuck threshold (default 60s), a visible warning is emitted. Heartbeat events are also persisted to the database for post-run analysis.

### Live Status While Running

`cdx status` and `cdx inspect` show live run info when a session is actively executing:

```
Session:  my-project [Running]
Engine:   claude
Path:     /path/to/project

Goal:     Implement CMS [active]
Progress: 2/5 WPs completed
Current:  Build models

Run:      3m 42s elapsed | strategy: focused
Heartbeat: idle | idle: 35s
```

## Data Storage

SQLite at `data/conductor.db` with two layers:

**Supervisor tables:**
- **sessions** — name, title, engine, path, status, active_goal_id, working_summary, decisions
- **goals** — title, description, type, source_type, status, completion_rules, closeout_summary
- **work_packages** — seq, title, status, retry_count/budget, blocker_type/detail, done_criteria
- **snapshots** — trigger, summary, completed/in-progress/remaining items, decisions, files, blockers, next_action, assumptions, unresolved_questions, follow_ups
- **execution_attempts** — attempt_no, status, prompt_strategy, progress_detected, files_changed_count

**Execution tables:**
- **tasks** — raw_input, workspace, engine, classification, status
- **runs** — command, prompt, PID, exit code, timestamps, resumed_from_run_id, cost_usd
- **run_logs** — stdout/stderr/system lines, sequenced
- **heartbeat_events** — alive/idle/suspected_stuck/recovered
- **run_reports** — structured post-run analysis with task-type-specific fields

Schema migrations run automatically on startup.

## Project Structure

```
conductor/
  src/
    cli/
      index.ts                        # CLI entry + command registration
      commands/
        session.ts                    # Session management + display helpers
        execute.ts                    # Supervisor execution (plan + no-plan)
        goal.ts                       # [Internal] Goal management
        run.ts                        # Single-run orchestration
        resume.ts                     # Resume with curated context
        tasks.ts                      # List tasks
        logs.ts                       # View run logs
        report.ts                     # Task-type-specific report display
        runs.ts                       # Run metadata inspection
        config.ts                     # cdx config set/get/show/unset + legacy aliases
        doctor.ts                     # cdx doctor — environment check
    core/
      config/service.ts               # Config read/write, resolveEngine(), key aliases
      supervisor/
        loop.ts                       # Main supervisor loop (transactional finalization, SIGINT-safe)
        scheduler.ts                  # WP scheduling, status counting
        plan-parser.ts                # Markdown plan → WP decomposition
        prompt-builder.ts             # Supervisor prompt (plan + ad-hoc)
        progress.ts                   # Evidence-based progress detection
        compactor.ts                  # Snapshot builder + decision extraction
        closeout.ts                   # Goal closeout summary generation
        progress-reporter.ts            # Live progress event formatting
        live-tracker.ts                 # Real-time file/tool tracking during runs
        hygiene.ts                      # Session health warnings
      storage/
        schema.ts                     # SQL DDL + migrations
        db.ts                         # SQLite singleton (WAL mode)
        repository.ts                 # Execution layer CRUD
        supervisor-repository.ts      # Supervisor layer CRUD
      task/normalizer.ts              # Keyword-based task classification
      prompt/builder.ts               # Template loading + substitution
      engine/
        types.ts                      # EngineAdapter interface + factory
        claude.ts                     # Claude CLI adapter (stream-json)
        codex.ts                      # Codex CLI adapter
        stream-parser.ts              # JSON event parser
        log-interpreter.ts            # Unified log parsing into typed events
      runner/process.ts               # child_process.spawn wrapper
      heartbeat/monitor.ts            # State-tracked output monitoring
      report/generator.ts             # Task-type-aware report extraction
      resume/
        context.ts                    # Best-run selection + typed context
        prompt.ts                     # Structured resume prompt rendering
    types/
      index.ts                        # Execution layer types
      supervisor.ts                   # Supervisor layer types
    utils/
      logger.ts                       # Timestamped console logger
      lookup.ts                       # Short-ID prefix resolution
  prompts/                            # Prompt templates per engine/task type
  data/                               # SQLite DB (gitignored)
  tests/                              # Vitest test suite (299 tests, 29 files)
```

## Development

```bash
npm run dev -- <command>     # Run CLI in dev mode (tsx)
npm test                     # Run all tests (299 tests)
npm run test:watch           # Watch mode
npm run build                # Compile TypeScript to dist/
npm link                     # Link cdx command globally
```

## Tech Stack

- **Runtime:** Node.js 22+, TypeScript
- **CLI:** commander
- **Validation:** zod
- **Database:** better-sqlite3 (WAL mode, foreign keys)
- **Process:** child_process.spawn with stdin pipe
- **Tests:** vitest

## License

MIT
