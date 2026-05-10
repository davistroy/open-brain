# ORCHESTRATOR — Autonomous Execution of PHASED_PLAN.md

**Purpose:** Execute the 45-phase roadmap in `PHASED_PLAN.md` one PR at a time with mandatory safety gates. Sonnet 4.6 subagents do the majority of work; Opus reviews at critical junctures; the operator approves high-blast-radius actions.

**Applies to:** This repository only (`C:/Users/Troy Davis/dev/personal/open-brain`). Single-operator context.

**Last updated:** 2026-04-18

---

## Quick start

### Resume an in-progress run
```
User: resume orchestrator
```
Orchestrator reads `.orchestrator-state.json`, verifies git state matches, and continues from the last gate.

### Start a fresh run
```
User: start orchestrator
```
Orchestrator verifies bootstrap preconditions (below), creates state file, begins at `current_phase` (defaults to P04a).

### Stop / pause
```
User: stop orchestrator     OR     pause orchestrator
```
Orchestrator finishes the current gate (never leaves a half-implemented phase), writes `paused_reason` to state, reports last checkpoint + next gate.

---

## Bootstrap (mandatory before autopilot)

**Hard precondition:** Phases `P01`, `P02a`, `P02b`, `P02c`, `P03` MUST be complete (merged to main) before the orchestrator enters autopilot.

**Why:** Those five phases fix the cost-tracking system (`ai-routing.yaml` Zod validation + `estimateTierCostUsd` widening + `callClaude` removal + Composio quota meter). Without them, the budget circuit breaker is blind — running a 40-phase autonomous loop on a broken breaker is exactly how we burned $100 in overnight ingestion on 2026-04-15. These phases are the orchestrator's guardrail installation.

**Bootstrap runs manually** (operator + conventional `/implement-plan` per phase, or operator writes them directly). Expected effort: ~1 week.

**Autopilot entry:** starts at `P04a` (admin reset safety rails — first non-critical phase).

**Verification before start:** orchestrator runs these checks; hard-fails start if any fails:
- [ ] `git rev-parse HEAD` matches `origin/main`
- [ ] `git status --porcelain` is empty
- [ ] `gh auth status` shows active account with push rights on `davistroy/open-brain` (not `davistroy-cfa`)
- [ ] `PHASED_PLAN.md` lists P01-P03 as `✅ Completed`
- [ ] Smoke query against `ai_audit_log`: last 10 rows have non-zero `cost_usd` for paid-provider tiers (proves P03 estimator is live)
- [ ] Monthly cap config loaded: `ai-routing.yaml.budget.monthly_hard_cap_usd` present

---

## State model — `.orchestrator-state.json`

Gitignored. Created on start; updated after every gate; deleted on full-plan completion.

```jsonc
{
  "started_at": "2026-04-19T08:00:00Z",
  "plan_file": "PHASED_PLAN.md",

  // Current phase being worked
  "current_phase": "P04a",
  "current_gate": "gate_3_implement",   // gate_1_plan | gate_2_branch | gate_3_implement | gate_4_review | gate_5_merge | gate_5_homeserver_deploy
  "branch_name": "feat/phase-P04a-admin-reset",
  "pr_number": null,
  "impl_plan_file": "IMPLEMENT_PHASE-P04a.md",

  // Failure + budget tracking
  "failure_count": 0,
  "review_cycle_count": 0,
  "budget_spent_usd": 12.43,
  "budget_cap_usd": 35.00,
  "budget_sampled_at": "2026-04-19T09:15:00Z",

  // History (append-only)
  "completed_phases": [
    { "phase": "P01", "pr": 102, "sha": "abc1234", "merged_at": "2026-04-18T20:00:00Z" },
    // ...
  ],
  "skipped_phases": [],

  // Operator interaction
  "operator_approval_pending": null,   // or: { "phase": "P09a", "reason": "homeserver migration", "since": "..." }
  "last_operator_input": null,
  "paused_reason": null,

  // Checkpointing
  "last_known_good_sha": "abc1234"
}
```

**State file rules:**
- Updated after every gate completion (not after every subagent — only at gate boundaries)
- Read at orchestrator start + whenever main agent needs to check progress
- The main agent reads this file directly (it is small); no subagent needed
- On corruption or ambiguity: halt, surface `last_known_good_sha` for manual recovery

---

## The 5-Gate Pipeline (one per phase)

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ GATE 1       │──▶│ GATE 2       │──▶│ GATE 3       │──▶│ GATE 4       │──▶│ GATE 5       │
│ Plan freshen │   │ Branch       │   │ Implement    │   │ Review       │   │ Merge        │
│ (Sonnet 4.6) │   │ (main agent) │   │ (Sonnet 4.6) │   │ (Opus)       │   │ (main agent  │
│              │   │              │   │              │   │              │   │  + operator) │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
      │                   │                   │                   │                   │
      ▼                   ▼                   ▼                   ▼                   ▼
 IMPLEMENT_PHASE-n.md  branch pushed   commits + tests     APPROVE verdict    PR merged (auto or
 (drift-corrected)                                                            operator-gated)
```

### Gate 1 — PLAN (freshen phase into IMPLEMENT_PHASE-n.md)

**Agent:** `phase-planner` (Sonnet 4.6)

**Inputs:**
- The phase card from `PHASED_PLAN.md` (e.g., the "P04a" section)
- Current state of all files referenced in the card
- LAB_NOTEBOOK entries relevant to the phase area (agent searches by keyword)

**Task:**
1. Read the phase card verbatim
2. Read the actual code files the card references — **verify they still exist + still have the structure the plan assumes**
3. If the code has drifted (e.g., the referenced function was renamed, a file moved, an acceptance criterion became moot), write a "scope diff" section in the output plan flagging each divergence
4. Generate `IMPLEMENT_PHASE-{phase}.md` following the project's `/create-plan` template, with:
   - Current-code-grounded work items (concrete file paths + line ranges + current function signatures)
   - Updated acceptance criteria if scope changed
   - Dependencies on prior phases (names of specific PRs)
   - Explicit deliverables list
   - Rollback plan
   - Effort estimate (may differ from original if scope changed)

**Output:** `IMPLEMENT_PHASE-{phase}.md` written locally (will be committed in Gate 2).

**Termination conditions:**
- **No scope drift** → proceed to Gate 2 autonomously
- **Scope drift detected (any acceptance criterion or file reference invalidated)** → pause; set `operator_approval_pending = {phase, reason: "scope drift", diff_summary}`; surface the diff summary to operator
- **Scope is ambiguous or the phase assumption is wrong** → same pause behavior

### Gate 2 — BRANCH

**Main agent action (no subagent):**

```bash
# Precondition checks
[ on main ] && [ clean tree ] && [ gh auth = davistroy ]

# Create + push branch
git checkout -b feat/phase-{phase}-{slug}    # slug = short-kebab of phase title
git add IMPLEMENT_PHASE-{phase}.md
git commit -m "plan(phase): IMPLEMENT_PHASE-{phase}.md"
git push -u origin feat/phase-{phase}-{slug}

# Update state
# current_gate = gate_3_implement
# branch_name = "feat/phase-{phase}-{slug}"
```

**Termination:** branch pushed successfully → Gate 3.

### Gate 3 — IMPLEMENT

**Agent:** `implement-executor` (Sonnet 4.6) — reuses existing `/implement-plan` skill machinery

**Task:**
1. Execute `/implement-plan --input IMPLEMENT_PHASE-{phase}.md` from inside the agent
2. Per-work-item cycle:
   - Write LAB_NOTEBOOK pre-action entry (Hypothesis + Rollback Plan) per CLAUDE.md Rule 1 BEFORE first commit of each item
   - Implement
   - Run tests; fix failures; re-run; ≤3 fix attempts per work item
   - Commit with `feat(phase-{phase})/N.M: description` format
   - Update LAB_NOTEBOOK with Result
   - Push
3. On `ALL_COMPLETE`: verify all acceptance criteria from IMPLEMENT_PHASE-n.md are met (grep tests, config files, etc.); proceed to Gate 4
4. On `TESTS_STUCK`: halt, surface to operator with failing-test detail + what was tried

**Termination:**
- `ALL_COMPLETE` → Gate 4
- `TESTS_STUCK` after 3 fix attempts → pause; set `operator_approval_pending = {phase, reason: "tests_stuck", detail}`
- Context exhaustion → pause at current item boundary; `current_gate` stays `gate_3_implement`, subagent state preserved via implement-plan's own state file

**Note:** `/implement-plan` has its own `.implement-plan-state.json`; the orchestrator's state file and implement-plan's state file coexist. Orchestrator inspects implement-plan's state file at resume time to see exactly where work stopped.

### Gate 4 — REVIEW

**Agent:** `code-reviewer` (**OPUS** — this is the load-bearing safety net; Sonnet is insufficient for this judgment work)

**Inputs:**
- Full PR diff (via `gh pr diff`)
- `IMPLEMENT_PHASE-{phase}.md`
- Acceptance criteria list
- LAB_NOTEBOOK entries written during Gate 3
- CI status

**Task:**
1. Verify every **deliverable** listed in IMPLEMENT_PHASE-n.md is present in the diff (specific file + approximate line range check)
2. Verify every **acceptance criterion** has evidence:
   - Test criteria → the specific test file + test case exists + passes
   - Config criteria → the config change is in the diff
   - Behavioral criteria → a test fixture demonstrates the behavior
3. Run CLAUDE.md compliance checks:
   - LAB_NOTEBOOK entry exists for each commit that touched app code (Rule 11)
   - Pre-flight DB audit performed if migration touches CHECK-constraint-eligible columns
   - New operational rules added to CLAUDE.md if any non-trivial finding
4. Identify bugs, risks, design issues missed by the implementer
5. Render verdict: **APPROVE** / **REQUEST_CHANGES** (with specific feedback) / **BLOCK** (fundamental design issue; needs operator)

**Output:** verdict + structured comment posted to the PR via `gh pr review`

**Termination:**
- **APPROVE** + CI green → Gate 5
- **REQUEST_CHANGES** → increment `review_cycle_count`; dispatch `implement-executor` again with review feedback as input
- **BLOCK** → pause; set `operator_approval_pending = {phase, reason: "review_blocked", verdict_detail}`
- **Review cycle cap: 2.** Third round → pause to operator regardless of verdict.

### Gate 5 — MERGE (with approval matrix)

**Decision tree:**

```
             ┌────────────────────────────────┐
             │ Gate 5 entry — check matrix    │
             └─────────────┬──────────────────┘
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
   ┌──────────────┐                  ┌──────────────┐
   │ Auto-merge   │                  │ Operator     │
   │ eligible     │                  │ approval     │
   │ + CI green   │                  │ required     │
   │ + APPROVE    │                  │ (see matrix) │
   └──────┬───────┘                  └──────┬───────┘
          │                                 │
          ▼                                 ▼
   ┌──────────────┐                  ┌──────────────┐
   │ gh pr merge  │                  │ Pause;       │
   │ --squash     │                  │ surface PR + │
   │ --delete-br  │                  │ review +     │
   │              │                  │ next actions │
   └──────┬───────┘                  └──────┬───────┘
          │                                 │
          │                                 ▼
          │                          ┌──────────────┐
          │                          │ Operator says│
          │                          │ merge/reject │
          │                          └──────┬───────┘
          │                                 │
          └────────────┬────────────────────┘
                       ▼
                ┌──────────────┐
                │ Homeserver?  │
                │ If YES:      │
                │  Gate 5.5    │
                │ If NO:       │
                │  → doc sweep │
                └──────────────┘
```

### Gate 5.5 — HOMESERVER DEPLOY (only for homeserver-touching phases)

Triggered when the merged PR includes any of:
- New migration in `packages/shared/drizzle/`
- Docker compose changes
- Observability config
- Any `packages/workers/src/scheduler.ts` schedule change

**Agent:** `homeserver-advisor` (Sonnet 4.6)

**Task:**
1. Generate exact SSH + psql + docker commands for the operator
2. Include pre-flight audit where applicable (MANDATORY per CLAUDE.md for CHECK migrations)
3. Generate rollback commands
4. Surface all commands + expected outputs to operator in a single message

**Orchestrator pauses.** Operator runs commands, confirms success (or failure).

On operator confirmation of success → proceed to doc sweep.
On failure → operator rolls back (guided by homeserver-advisor output); orchestrator pauses.

**Orchestrator does NOT SSH autonomously.** Ever.

### Post-merge doc sweep (always runs after Gate 5 / 5.5)

**Agent:** `doc-updater` (Sonnet 4.6)

**Task:**
1. `PHASED_PLAN.md`:
   - Mark phase header: `### P04a — /admin/reset-data ... ✅ Completed 2026-04-19 (PR #123)`
   - Update Cross-Phase Tracking row
   - If new sub-phases emerged during implementation (e.g., scope surprise that spawned follow-up work), insert them into the plan with proper numbering and cross-refs
2. `LAB_NOTEBOOK.md`:
   - Finalize the entry for this phase (Result section, Duration, Surprises if any)
   - If a non-trivial operational rule emerged, add it to CLAUDE.md + reference the entry
3. GitHub:
   - Close mapped issues per PHASED_PLAN.md Cross-Phase Tracking
   - Closing comment: "Closed by PR #N in phase {phase}. LAB_NOTEBOOK Entry NNN."
   - If new issues emerged, create them with `source:orchestrator` label + appropriate severity/arc
   - Remove `priority:next` label from completed phase; add to the next phase
4. `.orchestrator-state.json`:
   - Append to `completed_phases`
   - Advance `current_phase` to next in sequence
   - Reset `current_gate` to `gate_1_plan`
   - Reset `review_cycle_count` and `failure_count`
   - Update `last_known_good_sha` to new main HEAD

Output: a single human-readable summary line to the operator (see Telemetry below).

---

## Operator-approval matrix (Gate 5)

**Require operator approval before merge** for any phase matching:

| Criterion | Phases affected |
|-----------|-----------------|
| Labeled `severity:critical` | P01, P02a, P02b, P02c, P03 (all in bootstrap — moot for autopilot; but applies to any future critical phase) |
| Edits CLAUDE.md / PRD.md / TDD.md | P02b (bootstrap), P15a, P15b |
| Touches homeserver or applies migrations | P09a, P09b, P09c, P11a, P11b, P12, P17 |
| Includes migration in `packages/shared/drizzle/` touching `captures` or `embeddings` tables | Any phase adding to these tables |
| Failed Gate 4 review twice (escalation) | Whichever phase hits the cap |
| Gate 1 detected scope divergence | Whichever phase regenerated plan |
| Budget ≥ 80% monthly cap | Any phase at that moment |

**Auto-merge eligible:** all other phases. Approximately ~30 of the 45 phases post-bootstrap.

**Estimated operator-touch across the plan:** 15-20 approval gates, each ~2-5 minutes of review, spread over the calendar window.

---

## Homeserver boundary — what orchestrator does NOT do

| Action | Who does it |
|--------|-------------|
| SSH to `homeserver.k4jda.net` | **Operator only** |
| `docker exec open-brain-postgres psql ...` | **Operator only** |
| `docker compose up -d --build` on homeserver | **Operator only** |
| Apply database migrations to production | **Operator only** |
| Pre-flight DB audits | **Operator only** (orchestrator generates the audit command; operator runs it) |
| Commands listed in `homeserver-advisor` output | **Operator only** (orchestrator provides exact commands + expected output) |

The orchestrator treats homeserver as a remote managed system with a human-only interface. This is deliberate — autopilot applying migrations without human pre-flight is exactly how the 9th `'system'` source value would have destroyed 1 row on 2026-04-18 if we had skipped the audit.

---

## Subagent roster

| Agent | Model | Gate | Scope |
|-------|-------|------|-------|
| `phase-planner` | Sonnet 4.6 | 1 | Freshen phase card → `IMPLEMENT_PHASE-n.md` |
| `implement-executor` | Sonnet 4.6 | 3 | Run `/implement-plan` machinery; write code; run tests |
| `code-reviewer` | **Opus** | 4 | Pre-merge judgment; verdict with justification |
| `homeserver-advisor` | Sonnet 4.6 | 5.5 | Generate exact homeserver commands for operator |
| `doc-updater` | Sonnet 4.6 | post-gate-5 | Update PHASED_PLAN.md / LAB_NOTEBOOK / GitHub |
| `triage-surface` | Sonnet 4.6 | any pause | Clean handoff to operator when things go wrong |

**Why Sonnet for most work:** faster, cheaper, pattern-execution is Sonnet's strength. Each subagent operates in a bounded scope with clear input + output — ideal for Sonnet.

**Why Opus for review:** code review is judgment under ambiguity — "is this actually done?" "is this pattern going to break when the caller changes?" "does this test actually cover the acceptance criterion or is it green-by-accident?" Opus is materially better at this class of question. This is the one place where the cost delta is worth it.

**Main agent (orchestrator):** does no implementation work. Only coordination, state management, operator communication. Runs in the user's normal Claude Code session.

---

## Failure handling matrix

| Failure | Where | Response |
|---------|-------|----------|
| Scope divergence in Gate 1 | Gate 1 | Pause; operator reviews IMPLEMENT_PHASE-n.md diff summary; approves / redirects / skips |
| CI fails during Gate 3 after 3 fix attempts | Gate 3 | TESTS_STUCK surface per `/implement-plan` protocol (rollback / skip / pause) |
| Code reviewer blocks 2× | Gate 4 | Escalate; operator redirects or skips phase |
| PR merges but post-merge CI on main fails | post-Gate-5 | Pause; revert is operator's call (high-blast-radius) |
| Budget ≥ 50% of monthly cap | any gate | Informational notification to operator; continue |
| Budget ≥ 80% | any gate | Pause; operator reviews `ai_audit_log` + decides continue / halt |
| Budget ≥ 100% | any gate | **HARD STOP** regardless of pending work |
| Subagent context exhaustion | Gate 3 or 4 | Pause at item boundary; resume next session from state |
| Network / homeserver unreachable | Gate 5.5 | Pause; retry on operator resume |
| Dependency unmet (state-file bug) | Gate 1 | Pause; surface to operator for manual state audit |
| Subagent output malformed (rare) | any gate | Retry once with explicit structured-output prompt; if still malformed, pause |

All failure paths produce a single-message operator surface via `triage-surface` agent: what happened, what was tried, what files are in what state, recommended next action.

---

## Budget tracking

- Queried at every Gate 5 completion via `ai_audit_log` (sum `cost_usd` for current calendar month)
- Written to `.orchestrator-state.json` `budget_spent_usd`
- Thresholds trigger the Failure Handling matrix above

**Depends on P03 being merged.** Without P03's `estimateTierCostUsd` widening, `cost_usd` is 0 for openai_compat / litellm / openai tiers and budget tracking is blind. This is the main reason bootstrap is mandatory.

---

## Telemetry — what orchestrator reports

**Per-gate completion (concise):**
```
[ORCH] P04a · Gate 4 → APPROVE · PR #123 · CI green · auto-merging
```

**Per-phase summary (post-Gate-5):**
```
[ORCH] P04a ✅ complete
  PR: #123 squashed as abc1234
  Issues closed: #104
  LAB_NOTEBOOK: Entry 092
  Reviewer: APPROVE (first cycle)
  Tests added: +4 (workers suite: 950 → 954)
  Duration: 47 min wall-clock
  Budget: $12.43 / $35.00
  Remaining phases: 40
  Next: P04b (backup secret redaction)
```

**Operator-approval pause (when hit):**
```
[ORCH] PAUSED — P09a requires operator approval
  Reason: homeserver migration in diff
  PR: #135 (ready to merge, CI green, reviewer APPROVE)
  Pre-merge actions required:
    1. Review PR at {url}
    2. Run homeserver commands in message below ↓↓↓
    3. Confirm "applied" or "rejected" here
```

**Completion:**
```
[ORCH] ALL 45 PHASES COMPLETE
  Total duration: 67 days calendar, 84 hours orchestrator work
  Total PRs: 45 merged, 0 rejected
  Issues closed: 32 + 1 (#77 superseded)
  Budget: $94.17 spent across the window ($28/month avg, within cap)
  State file deleted. Backlog zero.
```

---

## Resume semantics

1. User says "resume orchestrator"
2. Main agent reads `.orchestrator-state.json`
3. Verifies git state matches state file:
   - Is `branch_name` checked out? If not, switch.
   - Does `pr_number` correspond to an open PR on that branch? If not, investigate.
   - Does `last_known_good_sha` match `origin/main`? If not, investigate.
4. Verifies the stated `current_gate` is the correct resume point:
   - If `current_gate = gate_3_implement`, read the implement-plan state file too; resume from there
   - If `current_gate = gate_4_review`, check if a review was partially posted
5. Resumes the gate

If state is ambiguous or corrupt: surface the `last_known_good_sha`, the last 5 `completed_phases`, and the last subagent output for manual recovery. Never guess.

---

## What orchestrator does NOT do

- Never SSHes to homeserver (always surfaces commands for operator)
- Never auto-merges phases in the operator-approval matrix
- Never bypasses code-reviewer gate or CI
- Never edits CLAUDE.md / PRD / TDD without operator approval
- Never proceeds past review cycle cap (2)
- Never enters autopilot before bootstrap (P01-P03) is complete
- Never force-pushes (`git push --force`)
- Never bypasses commit hooks (`--no-verify`)
- Never touches the operator's git credentials (Windows Credential Manager, `gh auth`)
- Never runs outside the operator's active Claude Code session — this is a procedure, not a daemon

---

## Starting the orchestrator (operator checklist)

```
[ ] Bootstrap complete: P01, P02a, P02b, P02c, P03 merged to main
[ ] `git status` clean on main
[ ] `git pull origin main` up to date
[ ] `gh auth status` confirms active account = davistroy (not davistroy-cfa)
[ ] ai_audit_log smoke query returns non-zero cost_usd for recent rows
[ ] Monthly cap configured in ai-routing.yaml
[ ] User invokes: "start orchestrator"
```

Orchestrator does its own verification of all items above on start; any failure aborts before Gate 1 begins.

---

## End-to-end worked example: P04b

**Input:** orchestrator at `current_phase = P04b, current_gate = gate_1_plan`.

**Gate 1 (phase-planner, Sonnet):**
- Reads P04b card from PHASED_PLAN.md: "Backup `.env.secrets` redaction"
- Reads `scripts/backup.sh`; finds the copy on line 81 still present
- Reads current `backup.sh` to check for any drift in surrounding lines
- Writes `IMPLEMENT_PHASE-P04b.md` with:
  - Work item 1.1: remove line 81 `cp .env.secrets $BACKUP_DIR/`
  - Work item 1.2: add test `scripts/test-backup-secrets-redaction.sh` that greps a fresh backup for known secret vars; asserts 0 matches
  - Acceptance: `grep -cE "BWS_ACCESS_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY" /tmp/test-backup/` returns 0
- No scope drift → proceeds

**Gate 2 (main):**
- `git checkout -b feat/phase-P04b-backup-secrets-redact`
- Adds + commits IMPLEMENT_PHASE-P04b.md
- Pushes
- State update: `current_gate = gate_3_implement`

**Gate 3 (implement-executor, Sonnet):**
- Runs `/implement-plan --input IMPLEMENT_PHASE-P04b.md`
- Writes LAB_NOTEBOOK entry 092 pre-action (Hypothesis + Rollback)
- Modifies `backup.sh`
- Writes test
- Commits: `feat(phase-P04b)/1.1: remove .env.secrets from backup payload`
- Commits: `feat(phase-P04b)/1.2: test — fresh backup has no secret vars`
- CI: green
- `ALL_COMPLETE` → Gate 4

**Gate 4 (code-reviewer, Opus):**
- Reviews diff
- Checks: line 81 of backup.sh gone? ✓
- Checks: test file exists + asserts the right thing? ✓
- Checks: LAB_NOTEBOOK entry present with Hypothesis + Rollback? ✓
- No red flags
- Verdict: APPROVE
- Posts review to PR

**Gate 5 (main, auto-merge path):**
- P04b not in approval matrix (not critical, not homeserver, not docs)
- CI green + APPROVE → `gh pr merge --squash --delete-branch`
- `git checkout main && git pull`

**Post-gate-5 (doc-updater, Sonnet):**
- PHASED_PLAN.md: P04b header marked ✅ 2026-04-19 (PR #124)
- Cross-Phase Tracking: P04b row updated
- LAB_NOTEBOOK entry 092: Result section finalized ("redaction verified in test; no production backup yet contains the change — rehearsal will catch at next cron run")
- GitHub: #107 (Theme 5) comment added noting P04b is done; partial close requires P16 + P17 to fully close
- State file: P04b → completed_phases; current_phase = P05; current_gate = gate_1_plan

**Telemetry:**
```
[ORCH] P04b ✅ complete
  PR: #124 squashed as def5678
  Issues closed: (partial of #107 — 2 remaining phases)
  LAB_NOTEBOOK: Entry 092
  Reviewer: APPROVE (first cycle)
  Duration: 31 min
  Budget: $12.79 / $35.00
  Next: P05 (autonomy gating uniform)
```

**Operator touch:** zero.

---

## Maintenance

- This procedure evolves. After every meaningful orchestrator learning (a new failure mode, a better way to surface something, a confirmed bad assumption), update this file and reference the learning in LAB_NOTEBOOK.
- Review this procedure after Wave 1 + Wave 2 complete (~8 phases post-bootstrap) — revise based on actual failure patterns encountered.
- If any section becomes wrong in practice, FIX THIS FILE before continuing. Do not diverge from documented procedure silently.

---

## Cross-references

- `PHASED_PLAN.md` — the 45-phase roadmap this orchestrator executes
- `CLAUDE.md` — operational rules the orchestrator must respect (Rule 1 Hypothesis/Rollback, Rule 11 LAB_NOTEBOOK-before-commit, pre-flight DB audit rule)
- `arch-review/reports/executive-summary.md` — risk context for the hardening phases
- `LAB_NOTEBOOK.md` — decision log + per-phase results
