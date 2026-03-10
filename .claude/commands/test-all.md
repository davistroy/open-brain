---
description: Run all unit tests, regression tests, and automatable USER_TEST_PLAN.md tests, then produce a comprehensive results report with failure root causes and fix recommendations.
allowed-tools: Read, Glob, Grep, Bash, Agent
---

# Open Brain — Full Test Suite

Run ALL automated tests for this project and produce a structured results report:

1. Unit tests across all packages (pnpm test)
2. Live API regression tests via SSH on homeserver
3. Web UI tests via browser automation (brain.troy-davis.com)
4. Slack bot command tests via Slack web automation

Then output a full formatted report covering:
- Pass/fail counts per suite
- Full details on every failure (test name, assertion, actual vs expected)
- Root cause analysis for each failure
- Prioritized fix recommendations (P1/P2/P3)
- Infrastructure state at test time (queue health, entity count, capture count)

---

## Step 1 — Unit Tests (all packages)

Run pnpm test at the workspace root and capture results for each package:

```bash
cd $PROJECT_ROOT
pnpm test 2>&1
```

Collect per-package pass/fail counts and the full text of any failures.

The packages and their test files are:
- `@open-brain/shared` — `packages/shared/src/**/__tests__/**`
- `@open-brain/core-api` — `packages/core-api/src/__tests__/**`
- `@open-brain/workers` — `packages/workers/src/__tests__/**`
- `@open-brain/slack-bot` — `packages/slack-bot/src/__tests__/**`
- `@open-brain/web` — `packages/web/src/**/__tests__/**`

---

## Step 2 — Live API Regression Tests

Run via SSH on the homeserver. The regression test hits the live API at http://127.0.0.1:3002.

Retrieve the MCP API key from Bitwarden:
```bash
bws secret list 2>/dev/null | grep -i "open.brain\|mcp" | head -5
```

Then run the regression test:
```bash
ssh root@homeserver.k4jda.net "OPEN_BRAIN_MCP_API_KEY='<KEY>' node /mnt/user/appdata/open-brain/scripts/regression-test.mjs --base-url http://127.0.0.1:3002 --verbose 2>&1"
```

The script covers 13 sections: Health/Stats, Captures CRUD, Pipeline, Search/Synthesize, Entities, Sessions, Bets, Triggers, Skills, Admin, MCP, Slack verification, Cleanup.

Note: brain.k4jda.net does NOT resolve from the local dev machine — always run regression tests via SSH against 127.0.0.1:3002.

---

## Step 3 — Web UI Tests (browser automation)

Use Chrome browser automation to test brain.troy-davis.com. Before calling any mcp__claude-in-chrome__* tool, use ToolSearch to load it.

**Pages to test:**

| Page | URL | Key checks |
|------|-----|------------|
| Dashboard | /dashboard | Stats load, pipeline health banner, Quick Capture submits without 400 |
| Search | /search | Page renders, search input present |
| Timeline | /timeline | Captures listed with date grouping, filters work |
| Entities | /entities | Entity list loads, type filters work |
| Board | /board | Governance buttons visible, bets list loads, no "Invalid Date" on bets |
| Briefs | /briefs | Brief log visible, Run Now button present |
| Settings | /settings | System health, skills, triggers, Danger Zone all render; Version/Uptime not "—" |
| Voice | /voice | Upload form renders with brain view selector |

For each page: note whether it loads, whether API calls succeed (check via JS fetch or console), and any visible errors.

**Quick Capture test**: Submit a capture via the Dashboard Quick Capture form and verify it returns 2xx (not 400). The form needs `capture_type` and `brain_view` — if the form doesn't include them, the fix was to add defaults in the submit handler.

**Bet Invalid Date test**: Load /board and verify no bets show "Invalid Date" in the due date field.

---

## Step 4 — Slack Bot Tests (browser automation)

Navigate to the Slack #open-brain channel: https://app.slack.com/client/T0AHPBS3WJK/C0AJ2P8R31C

Send each command using JavaScript (Slack's rich text editor requires execCommand):
```javascript
const msgBox = document.querySelector('[aria-label="Message to open-brain"]');
msgBox.focus();
msgBox.innerHTML = '';
document.execCommand('insertText', false, '!COMMAND_HERE');
msgBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
```

Wait ~5 seconds after each send, then check for "N replies" on the message to confirm the bot responded.

**Commands to test:**

| TC | Command | Expected |
|----|---------|----------|
| TC-S-003 | `!help` | Bot replies with command list |
| TC-S-030 | `!stats` | Bot replies with capture counts, entity count > 0 |
| TC-S-031 | `!recent 3` | Bot replies with 3 most recent captures |
| TC-S-050 | `!entities` | Bot replies with entity list |
| TC-S-090 | `!pipeline status` | Bot replies with queue counts, all failed=0 |
| TC-S-100 | `!foobar` | Bot replies with "Unknown command" message |
| TC-S-001 | plain capture text | Bot confirms capture created |
| TC-S-002 | question text | Bot synthesizes answer (not a capture confirmation) |

**Important**: Do NOT try to open Slack threads via DOM button clicking — it crashes Slack's web app. Instead verify responses by checking for "N replies" count on the message, or by using SSH to verify API state (e.g., capture count increased after sending a capture).

---

## Step 5 — Infrastructure State Snapshot

Via SSH, capture the current system state:

```bash
ssh root@homeserver.k4jda.net "
curl -s http://127.0.0.1:3002/api/v1/stats
echo '---'
curl -s http://127.0.0.1:3002/api/v1/admin/pipeline/health
echo '---'
curl -s http://127.0.0.1:3002/api/v1/health
"
```

---

## Step 6 — Generate the Report

Output a structured markdown report with these sections:

```
# Open Brain — Test Results Report
Date: <today>

## Executive Summary
<table: suite | tests | pass | fail>

## 1. Unit Tests
<per-package table + any failure details>

### Failures
For each failing test:
- Test: <file>:<line> — <test name>
- Error: <assertion/error message>
- Root cause: <explanation>
- Fix: <code change needed>

## 2. Regression Tests
<section-by-section pass/fail table>
<any failures with curl output and root cause>

## 3. Web UI Tests
<per-page table: loads | API ok | bugs found>
<any failures with symptom, root cause, fix>

## 4. Slack Bot Tests
<per-command table: sent | reply received | correct content>
<any failures>

## 5. Infrastructure State
<stats, queue health, service health at test time>

## 6. Prioritized Fix Recommendations
### P1 — Fix Now (Correctness / User-Visible)
### P2 — Fix Soon (Data Accuracy / UX)
### P3 — Test Infrastructure (Code Quality)

## 7. What to Do Next
<ordered action list>
```

---

## Manual-Only Tests (skip, note in report)

These 3 tests cannot be automated:
1. **TC-S audio** — voice file upload via Slack (requires real audio file through file picker)
2. **TC-S-105** — LiteLLM unavailable simulation (requires taking down a production service)
3. **TC-W-031** — Amber/red pipeline health color states (requires engineered degraded state)

Note them as "manual-only, not run" in the report.
