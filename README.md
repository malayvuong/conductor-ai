# Conductor

Supervisor for AI coding CLIs. Takes natural-language tasks, generates prompts, runs the selected engine, streams real-time logs, and produces structured reports.

```
User
  |
  v
cdx run --engine claude --path ./project --task "fix the login bug"
  |
  v
Task Normalizer --> Prompt Builder --> Engine Adapter --> Process Runner
                                                              |
                                                              v
                                                   Stream JSON + Heartbeat
                                                              |
                                                              v
                                                      Report Generator
                                                              |
                                                              v
                                                     SQLite (local)
```

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
# Set default workspace (optional, avoids --path every time)
cdx set-path /path/to/project

# Run a task
cdx run --engine claude --task "fix the login bug"

# Run with explicit path (overrides default)
cdx run --engine claude --path /other/project --task "fix the login bug"

# View past tasks
cdx tasks

# View logs for a run
cdx logs <runId>

# View the generated report
cdx report <runId>

# Resume a failed/incomplete task
cdx resume <taskId>

# Resume with a different task description
cdx resume <taskId> --task "focus on the auth module only"
```

Short IDs work everywhere -- you only need the first few characters (e.g. `cdx logs a1b2c3`).

## Commands

### `cdx run`

Run a new task against a workspace.

```bash
cdx run --engine <engine> --path <workspace> --task "<description>"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--engine` | No* | `claude` or `codex` (*required if no `defaultEngine` in config) |
| `--path` | No* | Workspace path (*required if no default path set) |
| `--task` | Yes | Natural-language task description |

What happens:
1. Creates a task record in SQLite
2. Classifies the task type (`debug_fix`, `scan_review`, `implement_feature`, `verify_only`)
3. Builds a prompt from the matching template
4. Validates the engine executable exists
5. Pipes the prompt to the engine via stdin
6. Streams real-time JSON events from the engine, parsing and displaying as they arrive
7. Persists every event (raw JSON) to the database for later inspection
8. Monitors heartbeat — warns once if no output for 60s+, detects recovery
9. On completion, generates a structured report
10. Handles Ctrl+C gracefully

### `cdx tasks`

List all tasks with their status.

```bash
cdx tasks
```

```
[a1b2c3d4] completed  claude   fix the login bug
[e5f6g7h8] failed     codex    review all API endpoints
```

### `cdx logs <runId>`

View saved logs for a run.

```bash
cdx logs <runId>
cdx logs <runId> --tail 20        # last 20 lines
cdx logs <runId> --stream stderr  # only stderr
```

### `cdx report <runId>`

View the structured report generated after a run.

```bash
cdx report <runId>
```

Shows: summary, root cause, fix applied, files changed, verification notes, remaining risks.

### `cdx resume <taskId>`

Create a new run for an existing task, injecting context from the previous run (report summary + last 20 log lines) into the prompt.

```bash
cdx resume <taskId>
cdx resume <taskId> --task "new instructions for this attempt"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--task` | No | Override the task description for this run |

### `cdx set-path <path>`

Set the default workspace path. Saved to `~/.conductor/config.json`.

```bash
cdx set-path /Users/me/projects/my-app
```

### `cdx get-path`

Show the current default workspace path.

### `cdx clear-path`

Remove the saved default workspace path.

## Configuration

Persistent config is stored at `~/.conductor/config.json`:

```json
{
  "defaultPath": "/Users/me/projects/my-app",
  "defaultEngine": "claude",
  "heartbeatIntervalSec": 15,
  "stuckThresholdSec": 60
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `defaultPath` | — | Workspace path used when `--path` is omitted |
| `defaultEngine` | — | Engine used when `--engine` is omitted |
| `heartbeatIntervalSec` | 15 | Seconds between heartbeat checks |
| `stuckThresholdSec` | 60 | Seconds of no output before warning |

## Task Classification

Tasks are auto-classified based on keywords (Vietnamese and English):

| Type | Triggers |
|------|----------|
| `debug_fix` | fix, bug, error, broken, crash, fail, loi, sua, khong load... |
| `scan_review` | review, scan, audit, check, inspect, analyze, kiem tra... |
| `implement_feature` | add, create, build, implement, feature, them, tao... |
| `verify_only` | verify, validate, confirm, test only, xac nhan... |

Ambiguous input defaults to `debug_fix`.

## Prompt Templates

Templates live in `prompts/<engine>/<task_type>.md` and use `{{variable}}` substitution:

```
prompts/
  claude/
    debug_fix.md
    scan_review.md
    implement_feature.md
    verify_only.md
  codex/
    debug_fix.md
    scan_review.md
    implement_feature.md
    verify_only.md
```

Edit these files to customize what gets sent to each engine.

## Streaming

The Claude adapter uses `--output-format stream-json --verbose` to stream real-time JSONL events as Claude works. Each event is:

- Persisted as raw JSON in `run_logs` for full traceability
- Parsed for terminal display (assistant text, tool calls, results)
- Fed to the heartbeat monitor so it knows the engine is alive

This means logs are captured **continuously** during a run, not just at the end. You can inspect them in real-time or after the fact with `cdx logs <runId>`.

## Data Storage

All data is stored locally in SQLite at `data/conductor.db`:

- **tasks** -- input, workspace, engine, classification, status
- **runs** -- command, prompt, PID, exit code, timestamps
- **run_logs** -- every stdout/stderr/system line, sequenced (raw JSON for streaming engines)
- **heartbeat_events** -- periodic health checks (alive/idle/suspected_stuck/recovered)
- **run_reports** -- structured post-run analysis

The database is created automatically on first run.

## Project Structure

```
conductor/
  src/
    cli/                # Commander entry point + commands
      commands/
        run.ts          # Main orchestration flow
        tasks.ts        # List tasks
        logs.ts         # View run logs
        report.ts       # View run reports
        resume.ts       # Resume previous task
        config.ts       # set-path, get-path, clear-path
    core/
      config/service.ts     # ~/.conductor/config.json read/write
      task/normalizer.ts    # Keyword-based task classification
      prompt/builder.ts     # Template loading + variable substitution
      engine/
        types.ts            # EngineAdapter interface + factory
        claude.ts           # Claude CLI adapter (stream-json)
        codex.ts            # Codex CLI adapter
        stream-parser.ts    # JSON event parser for streaming engines
      runner/process.ts     # child_process.spawn wrapper (stdin pipe)
      heartbeat/monitor.ts  # State-tracked output monitoring
      report/generator.ts   # Post-run report extraction
      storage/
        schema.ts           # SQL DDL
        db.ts               # SQLite init (WAL mode)
        repository.ts       # All CRUD operations
    types/index.ts          # Shared TypeScript types
    utils/
      logger.ts             # Timestamped console logger
      lookup.ts             # Short-ID prefix resolution
  prompts/                  # Prompt templates per engine/task type
  data/                     # SQLite DB (gitignored)
  tests/                    # Vitest test suite
```

## Development

```bash
npm run dev -- <command>     # Run CLI in dev mode (tsx)
npm test                     # Run all tests (51 tests)
npm run test:watch           # Watch mode
npm run build                # Compile TypeScript to dist/
npm link                     # Link cdx command globally
```

## Tech Stack

- **Runtime:** Node.js 22+, TypeScript
- **CLI:** commander
- **Validation:** zod
- **Database:** better-sqlite3
- **Process:** child_process.spawn with stdin pipe
- **Tests:** vitest

## License

MIT
