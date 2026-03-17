# Operational UX Phase — Design Spec

**Date:** 2026-03-17
**Goal:** Shift focus from execution reliability to operational usability. Make Conductor comfortable for daily use.
**Approach:** Two waves — Wave 1 (user-facing UX) then Wave 2 (hygiene + compaction).

---

## Wave 1: User-Facing UX

### 1. Live Progress Output

**Problem:** During `cdx execute ... --until-done`, user sees timestamps + scattered log.info() calls. Hard to track what's happening.

**Solution:** Compact single-line output. One line per state change. No spam, no dots, no animation.

**Output format:**

```
── session: cms-project | goal: Implement CMS ──

[WP 1/3] Scan structure — attempt 1 (normal)
[WP 1/3] ✓ progress — 3 files inspected
[WP 1/3] ✓ completed

[WP 2/3] Implement auth — attempt 1 (normal)
[WP 2/3] ✗ no progress
[WP 2/3] Implement auth — attempt 2 (focused)
[WP 2/3] ✓ progress — 2 files changed
[WP 2/3] ✓ completed

[WP 3/3] Write tests — attempt 1 (normal)
[WP 3/3] ⚠ hard blocker: missing test framework
[WP 3/3] ✗ failed (retries exhausted)

── result: 2/3 completed | 3 attempts | $0.1842 ──
```

**Events that trigger a line:**
- Goal start (header)
- WP start (with attempt number and strategy)
- Progress detected (with detail: files changed/inspected count)
- WP completed
- WP failed
- Hard blocker detected
- Retry (new attempt line)
- Goal end (footer with summary)

**Architecture:**
- New file: `src/core/supervisor/progress-reporter.ts`
- Pure functions — receive event data, return formatted string
- Reporter does not call console.log — caller decides output destination (testable)
- `loop.ts` calls reporter at each state transition instead of scattered `log.info()`
- Header printed once at goal start, footer once at goal end

**Event types** (contract between loop.ts and reporter):

```typescript
type ProgressEvent =
  | { type: 'goal_start'; session: string; goal: string }
  | { type: 'wp_start'; wpIndex: number; wpTotal: number; title: string; attempt: number; strategy: string }
  | { type: 'wp_progress'; wpIndex: number; wpTotal: number; detail: string }
  | { type: 'wp_completed'; wpIndex: number; wpTotal: number }
  | { type: 'wp_failed'; wpIndex: number; wpTotal: number; reason: string }
  | { type: 'hard_blocker'; wpIndex: number; wpTotal: number; detail: string }
  | { type: 'goal_end'; completed: number; total: number; attempts: number; cost: number };
```

**Not doing:**
- No spinner/animation
- No progress bar
- No clear screen / overwrite lines
- No color codes (plain text, works everywhere)
- Suppress existing `process.stdout.write('.')` streaming dots — replaced by progress events

---

### 2. Inspect Drill-Down

**Problem:** `cdx inspect` dumps everything. No way to drill into a specific goal's attempts, snapshot chain, or decisions.

**Solution:** Add filter flags to `cdx inspect`. Keep `cdx session history` as compact timeline.

**History changes (minimal):**
- Add seq number before each goal
- Add attempt count
- Keep compact by default
- `cdx session history --verbose` restores full detail (source, timestamps, snapshot summary) for debugging

```
cdx session history
  1. Scan structure [completed] — 3/3 WPs, 2 attempts
  2. Implement CMS [active] — 1/5 WPs, 4 attempts
  3. Fix login bug [paused] — 0/1 WPs, 1 attempt
```

**Inspect new flags:**

```bash
cdx inspect                          # full dump (existing behavior)
cdx inspect --goal <N>               # single goal detail
cdx inspect --goal <N> --attempts    # attempt timeline
cdx inspect --goal <N> --snapshots   # snapshot chain
cdx inspect --goal <N> --insights    # decisions + assumptions + questions + follow-ups + constraints
```

**Goal lookup:** By seq number (1-based, ordered by `created_at ASC, rowid ASC` within session for deterministic ordering). Not by UUID.

**Display formats:**

`--goal N` (no sub-flag): Goal detail with WPs + latest snapshot + closeout if present.

`--goal N --attempts`:
```
Goal 2: Implement CMS
Attempt 1 [completed] normal — progress, 2 files changed
  WP completed: Scan structure
Attempt 2 [completed] normal — progress, 3 files changed
  WP completed: Setup models
Attempt 3 [failed] focused — no progress
  Blocker: missing migration file
Attempt 4 [running] surgical — in progress
```

`--goal N --snapshots`:
```
Goal 2: Implement CMS
Snap 1 (run_completed) — 1/5 WPs done
  Next: Start "Setup models"
  Files: 3 inspected
Snap 2 (run_completed) — 2/5 WPs done
  Next: Start "Create routes"
  Files: 6 total (3 new)
  Decisions: +1 new
```

`--goal N --insights` (decisions only in Wave 1, full insights after Wave 2):
```
Goal 2: Implement CMS
[Snap 1] decided to use PostgreSQL over SQLite
[Snap 2] switched from REST to GraphQL for admin API
[Snap 3] chose Zod for validation over Joi
```
After Wave 2 lands, `--insights` also shows assumptions, open questions, follow-ups, constraints (see Section 5).

**Architecture:**
- Add options to inspect command in `session.ts`
- Each view is a separate display function
- Goal lookup function: `getGoalBySeq(db, sessionId, seq)` — query goals ordered by created_at, pick Nth
- If `--goal` absent, keep existing full dump behavior
- If `--goal` present without sub-flag, show goal detail (WPs + latest snapshot + closeout)

---

### 3. Session Commands

**Problem:** Only `start`, `list`, `status`, `inspect`, `history` exist. Missing daily-use operations for multi-session workflows.

**Solution:** Add `current`, `switch`, `pause`, `resume`, `close`. Session-first — user never manipulates goals directly.

**New commands:**

```bash
cdx session current        # quick check: which session is active
cdx session switch <name>  # switch to another session
cdx session pause          # pause current session + active goal
cdx session resume [name]  # resume paused session (by name, or most recent)
cdx session close          # close session, abandon unfinished goals
```

**Output examples:**

```bash
cdx session current
  cms-project (active)

cdx session switch api-refactor
  ⏸ Paused session: cms-project
  ▶ Switched to: api-refactor (paused → active)

cdx session pause
  ⏸ Paused: cms-project
    Goal "Implement CMS" paused (2/5 WPs done)

cdx session resume
  ▶ Resumed: cms-project
    Continuing goal: Implement CMS (2/5 WPs done)

cdx session resume
  ▶ Resumed: cms-project
    Continuing goal: Implement CMS (2/5 WPs done)

cdx session resume api-refactor    # explicit name
  ▶ Resumed: api-refactor

cdx session close
  Session "cms-project" closed.
    Goals: 2 completed, 1 paused (→ abandoned)
```

**Behavior rules:**

| Command | Session status | Active goal | Other sessions |
|---------|---------------|-------------|----------------|
| `current` | read only | — | — |
| `switch <name>` | target → active | target's paused goal stays as-is | current → paused |
| `pause` | → paused | active goal → paused | — |
| `resume [name]` | → active | most recent paused/created goal → active | — |
| `close` | → abandoned (if unfinished goals) or completed (if all goals done) | unfinished goals → abandoned (with closeout) | — |

**Edge cases:**
- `switch` to a completed/abandoned session → error: "Session 'X' is completed. Use `cdx session start X` to reactivate."
- `resume` with no paused sessions → error: "No paused session to resume."
- `resume` uses `updated_at DESC` to pick most recent paused session (matches existing `getActiveSession` behavior)
- `close` determines session status dynamically: if all goals are completed → session `completed`, otherwise → session `abandoned`

**Key distinction:** `session resume` only reactivates session status. It does NOT start execution. User runs `cdx execute --until-done` separately. Clear separation: session management vs execution.

**Architecture:**
- 5 new actions in `session.ts`, each ~15-30 lines
- `close` iterates goals, marks unfinished → abandoned, generates closeout for each
- `current` is a quick alias — simpler than `status` (just name + status)
- `resume [name]` — if name given, find by name; otherwise pick most recent paused session (by `updated_at DESC`)

**Shared function extraction** (two primitives reused across switch, pause, resume, execute):
- `pauseCurrentSession(db, session)` — (1) pause active goal if unfinished, (2) set session status to paused. Used by: `switch`, `pause`
- `activateSession(db, sessionId)` — set session status to active, set most recent paused/created goal as active_goal_id. Used by: `switch`, `resume`

---

## Wave 2: Hygiene + Compaction

### 4. Session Hygiene Guardrails

**Problem:** Without guardrails, sessions accumulate paused goals and become stale. History gets messy.

**Solution:** Passive warnings + soft nudge. Never block execution.

**Warning triggers:**

| Trigger | Threshold | Where shown |
|---------|-----------|-------------|
| Stale session | `now - session.updated_at` > 7 days | `status`, `session list` |
| Too many paused goals | >= 3 paused | `status`, `execute` |

**Display examples:**

```bash
cdx status
  Session: cms-project [active]
  ⚠ Idle for 9 days. Consider: cdx session pause or cdx session close

cdx session list
  cms-project    Active    3 goals    ⚠ 9d idle
  api-refactor   Paused    1 goal     2h ago

cdx execute "new feature" --until-done
  ⚠ 2 paused goals in session. Review: cdx inspect
  Creating new goal...
```

**Architecture:**
- New file: `src/core/supervisor/hygiene.ts`
- Pure functions, no side effects:
  - `checkStaleSession(session: Session): Warning | null`
  - `checkPausedGoals(goals: Goal[]): Warning | null`
  - `getSessionWarnings(session: Session, goals: Goal[]): Warning[]`
- Warning type: `{ level: 'info' | 'warn', message: string, suggestion: string }`
- Inject into: `showSessionStatus()`, session list rendering, execute flow
- Thresholds at top of file as constants:
  ```typescript
  const STALE_DAYS = 7;
  const MAX_PAUSED_GOALS = 3;
  ```

**Constraint enforcement:** 1 active goal per session already enforced in execute.ts (auto-pause). Guardrails only add visibility to accumulation.

---

### 5. Enhanced Compaction

**Problem:** Compactor only extracts decisions. Missing: constraints, assumptions, unresolved questions, follow-up items. Resume quality suffers for long tasks.

**Solution:** Prompt-guided extraction with pattern matching fallback.

**Prompt addition** — appended to supervisor prompt-builder output:

```
At the end of your work, include these sections if applicable:

## Assumptions Made
- List any assumptions you made during this work

## Open Questions
- List anything unclear that needs human input

## Follow-up Items
- List work that should be done next but is outside current scope

## Constraints Discovered
- List any technical/business constraints you encountered
```

**Extraction pipeline:**

1. **Structured parse** (high confidence) — look for `## Assumptions Made`, `## Open Questions`, `## Follow-up Items`, `## Constraints Discovered` markdown sections
2. **Pattern fallback** (lower confidence, restricted to `summary`, `final_output`, `what_implemented` fields only — not raw code) — "assuming that...", "TODO:", "need to...", "question:", "unclear...", "constraint:", "limitation:"
3. **Merge** with previous snapshot — deduplicate by content string
4. **Store** in snapshot fields

**Schema change:**

```sql
ALTER TABLE snapshots ADD COLUMN assumptions TEXT;           -- JSON: string[]
ALTER TABLE snapshots ADD COLUMN unresolved_questions TEXT;  -- JSON: string[]
ALTER TABLE snapshots ADD COLUMN follow_ups TEXT;            -- JSON: string[]
```

`constraints` and `decisions` fields already exist.

**Migration note:** Existing snapshots will have `null` for new fields. All display and merge code must handle null gracefully (already the pattern used for existing nullable snapshot fields).

**Code changes:**

Rename `extractDecisionsFromReport()` → `extractInsightsFromReport()`:

```typescript
interface ExtractedInsights {
  decisions: Array<{ decision: string; reason?: string }>;
  assumptions: string[];
  unresolved_questions: string[];
  follow_ups: string[];
  constraints: string[];
}
```

Section parsing first, pattern matching fallback. Same merge/dedup logic as decisions.

**Inspect integration:**

`--insights` flag (same flag from Wave 1, now shows full data):

```bash
cdx inspect --goal 2 --insights
  Goal 2: Implement CMS

  Decisions:
    [Snap 1] Use PostgreSQL over SQLite
    [Snap 2] Switch from REST to GraphQL

  Assumptions:
    [Snap 1] Database already has user table
    [Snap 2] Auth middleware handles JWT

  Open Questions:
    [Snap 2] Should admin API require 2FA?

  Follow-ups:
    [Snap 1] Add rate limiting to API
    [Snap 3] Write integration tests for auth flow

  Constraints:
    [Snap 1] Must support PostgreSQL 14+
```

**Snapshot type update:**

```typescript
export interface Snapshot {
  // ... existing fields ...
  assumptions: string | null;           // JSON: string[]
  unresolved_questions: string | null;  // JSON: string[]
  follow_ups: string | null;           // JSON: string[]
}
```

---

## File Impact Summary

**New files:**
- `src/core/supervisor/progress-reporter.ts` — live progress formatting
- `src/core/supervisor/hygiene.ts` — session warning checks

**Modified files:**
- `src/core/supervisor/loop.ts` — replace log.info with progress-reporter calls
- `src/cli/commands/session.ts` — new commands (current, switch, pause, resume, close) + inspect flags + history seq numbers + warning injection
- `src/cli/commands/execute.ts` — extract shared pause logic, add hygiene warnings
- `src/core/supervisor/compactor.ts` — rename to extractInsightsFromReport, add new extraction types
- `src/core/supervisor/prompt-builder.ts` — add insight section instructions to prompts
- `src/core/storage/schema.ts` — migration for 3 new snapshot columns
- `src/core/storage/supervisor-repository.ts` — getGoalBySeq helper
- `src/types/supervisor.ts` — Snapshot type update

**Test files (new):**
- `tests/core/progress-reporter.test.ts`
- `tests/core/hygiene.test.ts`
- `tests/core/inspect-drilldown.test.ts`
- `tests/core/session-commands.test.ts`
- `tests/core/enhanced-compaction.test.ts`
