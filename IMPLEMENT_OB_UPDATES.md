# Implementation Plan: Open Brain Value Updates

**Source:** Operational review -- reduce auto-generated noise, encourage human input, surface actionable morning briefings.

**Date:** 2026-04-09
**Status:** Planning

---

## Overview

Four changes to maximize Open Brain's value by reducing auto-generated noise, encouraging human input, and surfacing actionable morning briefings.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Disabling daily-connections loses a useful skill permanently | Low | Skill code untouched, re-enable via PATCH when corpus grows to 200+ captures |
| Daily sweep notify-only loses searchable sweep text | Low | Full results preserved in skills_log; underlying captures are searchable directly |
| Capture reminders become annoying | Low | Simple Pushover notifications can be muted on the device; priority set to lowest (-1) |
| Morning brief open-loop detection has false positives | Medium | Heuristic keyword matching is imperfect; start conservative, tune based on real output |
| Morning brief query performance on growing corpus | Low | All queries use indexed columns (created_at, source, entity_type); no full table scans |

---

## Phase 1: Reduce Noise

**Goal:** Stop auto-generated content from polluting the capture corpus. Disable the repetitive daily-connections skill and make daily-sweep notification-only.

**Depends on:** Nothing

### Work Item 1.1: Disable Daily Connections Skill

**Description:**
PATCH the daily-connections schedule to `0 0 29 2 *` (February 29 -- fires once every 4 years, next: 2028-02-29). This effectively disables it without deleting the skill code. The cron expression `0 0 31 2 *` (February 31) is rejected by cron-parser as invalid, so use Feb 29 instead.

Re-enable when `GET /api/v1/stats` shows 200+ total captures with at least 100 human-originated.

**Files Modified:**
- `config/skills.yaml` (created automatically by the PATCH endpoint if it doesn't exist yet)

**Implementation:**
Run this curl command against the production API (via Tailscale):
```bash
curl -s -X PATCH "http://100.101.61.122:3002/api/v1/skills/daily-connections" \
  -H "Content-Type: application/json" \
  -H "X-Open-Brain-Caller: claude-code" \
  -d '{"schedule": "0 0 29 2 *"}'
```

No code changes. Config-only update persisted to `config/skills.yaml`.

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] PATCH returns 200 with updated schedule
- [x] `GET /api/v1/skills` shows daily-connections with schedule `0 0 29 2 *`
- [x] No daily-connections Pushover notifications after the change
- [x] Skill code in `daily-connections.ts` is untouched

---

### Work Item 1.2: Daily Sweep -- Notify Only, Don't Store Captures

**Description:**
Add a `storeCapture` option to `DailySweepOptions` (default `false`). When false, skip the `POST /api/v1/captures` call. Keep LLM synthesis, skills_log logging, and Pushover notification unchanged.

The skill already logs the full result JSON to `skills_log`, so audit trail is preserved. The capture was redundant -- you'd never search for "what did the sweep say Tuesday" when you can search the underlying captures directly.

**Files Modified:**
- `packages/workers/src/skills/daily-sweep-skill.ts` -- add `storeCapture` option, gate capture creation
- `packages/workers/src/__tests__/daily-sweep-skill.test.ts` -- update tests: default behavior should NOT create capture; add test for `storeCapture: true` to verify opt-in still works
- `packages/workers/src/jobs/skill-execution.ts` -- pass `storeCapture` from job data if provided (default: false)

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Default execution (no options) does NOT create a capture
- [x] `storeCapture: true` in options DOES create a capture (backward-compatible opt-in)
- [x] Pushover notification still sent with headline + decisions/questions
- [x] skills_log still receives full result JSON with all fields
- [x] `DailySweepResult.savedCaptureId` is null when storeCapture is false
- [x] All existing tests pass (updated to reflect new default)

---

### Work Item 1.3: Add Voice Capture Rate to Sweep Notification

**Description:**
Add a "Voice memos this week" line to the daily sweep Pushover notification. Query: `SELECT COUNT(*) FROM captures WHERE source='voice' AND created_at > NOW() - INTERVAL '7 days'`. Also include days since last voice capture.

This creates a habit-reinforcing feedback loop -- seeing the count in the evening nudges you to record more voice memos.

**Files Modified:**
- `packages/workers/src/skills/daily-sweep-skill.ts` -- add voice stats query in execute(), include in Pushover message
- `packages/workers/src/__tests__/daily-sweep-skill.test.ts` -- add test for voice stats in notification

**Status:** COMPLETE 2026-04-09

**Acceptance Criteria:**
- [x] Pushover notification includes "Voice memos this week: N" line
- [x] Includes "last: X days ago" (or "last: today" if same day)
- [x] Gracefully handles zero voice captures (shows "Voice memos this week: 0")
- [x] Query uses indexed `created_at` column -- no full table scan

---

## Phase 2: Encourage Input

**Goal:** Add morning and evening Pushover reminders to nudge voice capture without creating captures or using LLM tokens.

**Depends on:** Nothing (independent of Phase 1, but best deployed after Phase 1 reduces noise)

### Work Item 2.1: Capture Reminder Skill

**Description:**
New lightweight skill that sends two Pushover notifications daily:
- **7:00 AM (weekdays):** "What's on your plate today?" -- nudge for morning voice memo
- **9:00 PM (daily):** Shows today's capture count + time of last capture + "How did the day go?" -- nudge for evening reflection

No LLM call, no capture creation. Just a database query (today's capture count and last timestamp) and a Pushover send. ~50 lines of code following the `pipeline-health` pattern (constructor with db + pushover, execute method, top-level entry function).

Two separate scheduled jobs: `capture-reminder-morning` (cron `0 7 * * 1-5`) and `capture-reminder-evening` (cron `0 21 * * *`).

**Files Created:**
- `packages/workers/src/skills/capture-reminder.ts`

**Files Modified:**
- `packages/workers/src/scheduler.ts` -- register two repeatable jobs
- `packages/workers/src/jobs/skill-execution.ts` -- add dispatcher cases for both reminder jobs
- `packages/core-api/src/services/skill-config.ts` -- add both to DEFAULT_SKILLS

**Status:** PENDING

**Acceptance Criteria:**
- [ ] Morning reminder sends Pushover at 7 AM weekdays with "What's on your plate today?"
- [ ] Evening reminder sends Pushover at 9 PM daily with capture count + last capture time
- [ ] Pushover priority is -1 (lowest) -- these are nudges, not alerts
- [ ] No capture created, no LLM call
- [ ] Both skills appear in `GET /api/v1/skills` and are manually triggerable
- [ ] Gracefully handles zero captures today ("No captures today")
- [ ] Schedule editable via PATCH (same as other skills)

---

## Phase 3: Surface Value

**Goal:** Build a morning briefing that pulls yesterday's context, open loops, and people to follow up into a single actionable Pushover notification.

**Depends on:** Phases 1 and 2 should be deployed first so the morning brief queries clean data (no auto-generated noise captures)

### Work Item 3.1: Morning Brief Skill

**Description:**
New skill that runs at 7:15 AM weekdays (15 min after capture-reminder-morning, so any morning voice memo is captured first). Assembles a structured morning briefing from database queries -- no LLM call.

**Sections:**

1. **YESTERDAY'S THREAD** -- Query captures from previous day (excluding auto-generated: filter out tags containing 'skill-output'). Truncate each to first sentence or 100 chars.

2. **OPEN LOOPS** -- Scan recent captures (3 days) for forward-looking phrases: "need to", "waiting on", "follow up", "approval", "should", "tomorrow", "next step". Extract the sentence containing the phrase. Deduplicate by content similarity (simple substring matching).

3. **PEOPLE TO FOLLOW UP** -- Query entities of type 'person' mentioned in captures from the last 3 days. For each person, include the most recent capture context (first 80 chars of the capture where they appear). Exclude self-references (Troy, Troy Davis).

4. **TODAY'S ITEMS** -- Scan yesterday's evening captures for mentions of today's day name or "tomorrow" + an activity. This is heuristic and may be empty -- that's fine.

**Output:** Pushover notification only -- NOT stored as a capture. Title: "Morning Brief -- [date]". Priority: 0 (normal).

Also logs to skills_log for audit trail.

**Files Created:**
- `packages/workers/src/skills/morning-brief.ts`
- `packages/workers/src/__tests__/morning-brief.test.ts`

**Files Modified:**
- `packages/workers/src/scheduler.ts` -- register repeatable job (cron `15 7 * * 1-5`)
- `packages/workers/src/jobs/skill-execution.ts` -- add dispatcher case
- `packages/core-api/src/services/skill-config.ts` -- add to DEFAULT_SKILLS

**Status:** PENDING

**Acceptance Criteria:**
- [ ] Runs at 7:15 AM weekdays via BullMQ scheduler
- [ ] YESTERDAY'S THREAD shows human captures from previous day (excludes skill-output tagged)
- [ ] OPEN LOOPS extracts forward-looking phrases from last 3 days of captures
- [ ] PEOPLE section lists recently mentioned people with capture context
- [ ] No LLM call -- all template-based formatting
- [ ] Pushover notification sent with structured sections
- [ ] Gracefully handles empty sections (omits section header if no data)
- [ ] Does NOT create a capture
- [ ] Logs full result to skills_log
- [ ] Skill appears in `GET /api/v1/skills` and is manually triggerable
- [ ] Schedule editable via PATCH

---

## Implementation Sequence

```
Phase 1 (Reduce Noise)
  1.1 Disable daily-connections (config only, no code)
  1.2 Daily sweep notify-only
  1.3 Voice rate in sweep notification
      |
Phase 2 (Encourage Input)
  2.1 Capture reminder skill
      |
Phase 3 (Surface Value)
  3.1 Morning brief skill
```

Phase 1 items are independent and can be parallelized (1.2 and 1.3 touch the same file but different sections). Phase 2 is independent. Phase 3 should come last.

---

## Scope Boundaries

**In scope:**
- Disabling daily-connections via config
- Making daily-sweep capture-optional (default off)
- Voice capture rate metric in sweep notification
- Capture reminder skill (morning + evening Pushover nudges)
- Morning brief skill (structured query + Pushover, no LLM)

**Out of scope:**
- iOS Shortcut changes (Watch complication, quick brain dump variant -- user does this manually)
- Changes to weekly-brief skill (keep as-is, captures are valuable at 1/week)
- Changes to drift-monitor skill
- Web UI changes
- Schema or migration changes
- LLM-powered morning brief summarization (future enhancement if raw output is too verbose)

**Follow-up work:**
- Re-enable daily-connections when corpus reaches 200+ captures (~May 2026)
- Add LLM summarization option to morning brief if raw query output is too verbose
- Consider applying the same notify-only pattern to daily-connections when re-enabled
- Track morning brief engagement to tune section content and timing
