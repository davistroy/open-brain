# Skill Inventory — Open Brain Workers

**Generated:** 2026-04-21 (Phase 4.4, Cloudscape M2)
**Source:** `packages/workers/src/skills/` + `packages/workers/src/scheduler.ts`

All BaseSkill subclasses in the workers package. Used as source of truth for Phase 6 (brief-producing skill extensions) and any future skill additions.

---

## Concurrency Notes

All scheduled skills run via the `skill-execution` BullMQ queue. The worker uses concurrency = 1 (singleton) for LLM-heavy skills; the default is 2 per the CLAUDE.md registry. Per-skill concurrency overrides are documented in the table where they apply. The `skill-execution` queue itself has `priority: 3` with 3 attempts and exponential backoff (10s → 20s → 40s).

---

## Skill Table

| Name | File Path | Schedule | Brief-Producing | Concurrency | minimum_autonomy |
|------|-----------|----------|-----------------|-------------|-----------------|
| `capture-reminder-morning` | `packages/workers/src/skills/capture-reminder.ts` | `45 6 * * 1-5` (6:45 AM weekdays) | N | 1 (singleton — no-op if sent twice) | — |
| `capture-reminder-evening` | `packages/workers/src/skills/capture-reminder.ts` | `0 21 * * *` (9 PM daily) | N | 1 (singleton — no-op if sent twice) | — |
| `capture-dedup-sweep` | `packages/workers/src/skills/capture-dedup-sweep.ts` | `0 4 * * 6` (4 AM Saturdays) | N | 1 | `observe` |
| `container-health` | `packages/workers/src/skills/container-health.ts` | `*/15 * * * *` (every 15 min) | N | 2 (default) | — |
| `cost-analysis` | `packages/workers/src/skills/cost-analysis.ts` | `20 6 * * *` (6:20 AM daily) | N | 1 | `observe` |
| `daily-connections` | `packages/workers/src/skills/daily-connections.ts` | `10 6 * * *` (6:10 AM daily) | N | 1 | `observe` |
| `daily-sweep-skill` | `packages/workers/src/skills/daily-sweep-skill.ts` | `0 20 * * *` (8 PM daily) | **Y** | 1 | `assist` |
| `drift-monitor` | `packages/workers/src/skills/drift-monitor.ts` | `15 7 * * *` (7:15 AM daily) | N | 1 | `observe` |
| `email-classify` | `packages/workers/src/skills/email-classify.ts` | `0 5 * * *` (5 AM daily) | N | 1 | — |
| `email-compose` | `packages/workers/src/skills/email-compose.ts` | on-demand | N | 1 | `advise` |
| `memory-consolidation` | `packages/workers/src/skills/memory-consolidation.ts` | `0 4 * * 0` (4 AM Sundays) | N | 1 (documented singleton — destructive) | `assist` |
| `monthly-reflection` | `packages/workers/src/skills/monthly-reflection.ts` | `0 9 1 * *` (9 AM 1st of month) | **Y** | 1 | `assist` |
| `morning-brief` | `packages/workers/src/skills/morning-brief.ts` | `30 6 * * 1-5` (6:30 AM weekdays) | **Y** | 1 | `observe` |
| `pipeline-health` | `packages/workers/src/skills/pipeline-health.ts` | `0 */6 * * *` (every 6 hours) | N | 1 | — |
| `secret-rotation` | `packages/workers/src/skills/secret-rotation.ts` | `0 10 1 * *` (10 AM 1st of month) | N | 1 | — |
| `stale-captures` | `packages/workers/src/skills/stale-captures.ts` | on-demand | N | 2 (default) | — |
| `storage-audit` | `packages/workers/src/skills/storage-audit.ts` | `0 3 * * 0` (3 AM Sundays) | N | 1 | — |
| `weekly-brief` | `packages/workers/src/skills/weekly-brief.ts` | on-demand (manually triggered or via skill queue) | **Y** | 1 | `observe` |
| `wiki-ingest` | `packages/workers/src/skills/wiki-ingest.ts` | on-demand (queued by wiki-synthesis) | N | 1 (documented singleton — git serialization) | — |
| `wiki-lint` | `packages/workers/src/skills/wiki-lint.ts` | `0 5 * * 0` (5 AM Sundays) | N | 1 | — |
| `wiki-synthesis` | `packages/workers/src/skills/wiki-synthesis.ts` | `0 6 * * *` (6 AM daily) | N | 1 | — |

---

## Brief-Producing Skills (Phase 6 targets)

These 4 skills will be extended in Phase 6 to write structured output to the `briefs` table (migration 0030):

| Skill | Kind (briefs.kind) | Rationale |
|-------|--------------------|-----------|
| `weekly-brief` | `weekly` | Already saves a capture; Phase 6 extends to also write `briefs` row with HTML body, TOC, sources |
| `daily-sweep-skill` | `daily` | Evening LLM summary; extends to write `briefs` row |
| `morning-brief` | `morning` | Structured morning briefing; extends to write `briefs` row |
| `monthly-reflection` | `monthly` | Long-form agent synthesis; extends to write `briefs` row |

---

## Non-BaseSkill Pipeline Skills (not in table above)

These are pipeline-stage workers, NOT BaseSkill subclasses. They process individual captures reactively and must never declare `static minimum_autonomy`.

| Job | Queue | Trigger |
|-----|-------|---------|
| `capture-pipeline` | `capture-pipeline` | POST /captures |
| `embed-capture` | `embed-capture` | After pipeline received |
| `extract-entities` | `extract-entities` | After embed |
| `link-entities` | (inline in pipeline) | After extract |
| `document-pipeline` | `document-pipeline` | POST /documents |
| `wiki-ingest-worker` | `wiki-ingest` | Queued by wiki-synthesis |
| `ingest-process` | `ingest-process` | Ingest sidecar |
| `check-triggers` | `check-triggers` | After pipeline complete |
| `update-access-stats` | `access-stats` | After search |
| `budget-check` | `budget-check` | `0 7 * * *` (7 AM daily) |
| `daily-sweep` | `daily-sweep` | `0 3 * * *` (3 AM daily) — re-queues stuck captures |
| `prune-associations` | `prune-associations` | `30 3 * * 0` (3:30 AM Sundays) |

---

## Scheduler Slot Registry (Sunday slots)

| Time (Sunday) | Job |
|---------------|-----|
| `0 3 * * 0` | storage-audit |
| `30 3 * * 0` | prune-associations |
| `0 4 * * 0` | memory-consolidation |
| `0 4 * * 6` | capture-dedup-sweep (Saturday) |
| `0 5 * * 0` | wiki-lint |

---

## Maintenance Notes

- Adding a new skill: update this table, register in `scheduler.ts` (check slot registry), add dispatcher case in `jobs/skill-execution.ts`, and add to `KNOWN_SKILLS` in `core-api/src/routes/skills.ts`.
- Brief-producing: adding a brief-producing skill requires extending the skill to call `BriefsService.createFromSkill()` (Phase 5) with structured HTML body.
- Autonomy gates: skills that proactively send notifications or create captures should declare `static minimum_autonomy`. Pipeline-reactive skills (wiki-ingest, extract-entities, embed, etc.) must NOT declare it.
