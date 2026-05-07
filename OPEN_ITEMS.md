# Open Items Registry

**Purpose:** Single index of what's actually open across all implementation plans. Each entry links to the source plan for detail. Update when plans ship items or new plans land.

**Last refreshed:** 2026-05-07

---

## Active plans (with pending work)

_(none — IMPLEMENTATION_PLAN-POST-REMEDIATION.md closed via PR #183 on 2026-05-07; see Recently-closed section below.)_

---

### [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — LLM model consolidation — verification residue

**Scope:** Move hardcoded LLM model references into `config/ai-routing.yaml`. Authored 2026-04-21.

**Real status:** Implementation looks done — `[x]` checkboxes for code changes; `[ ]` checkboxes are verification boxes ("existing tests pass") that haven't been ticked. Most likely the work shipped and box-ticking lapsed.

| Phase | Status | Action |
|---|---|---|
| 1.1 — Add missing task_routing entries | Code likely done; verification box unticked | Run `pnpm --filter @open-brain/core-api test` and tick if green |
| 1.2 — Wire configService to wiki-ingest | Code done (3/4 boxes); test box unticked | Same |
| 1.3 — Wire configService to wiki-lint | Same shape | Same |
| 1.4 — Wire configService to monthly-reflection | Same shape | Same |
| 1.6 — Update tests for new model resolution | Verification sweep | Run full test suite, tick |
| Phase 2 verification | TypeScript clean + grep for hardcoded models | One-shot audit |

**Recommendation:** ~30-min close-out session — run tests, grep, tick boxes, mark plan COMPLETE.

---

### [IMPLEMENT_MASTER_PLAN.md](IMPLEMENT_MASTER_PLAN.md) + [PHASED_PLAN.md](PHASED_PLAN.md) — 5 gated tail items

**Scope:** Master roadmap (Arcs 0–5) and 45-PR phased rollout. ~85% of items shipped via PRs P01–P32 + Cloudscape arc; tail items are all gated by external triggers.

| Item | Source | Gate | Effort |
|---|---|---|---|
| P23 — Cognitive memory tuning | Master 4C / Phased Wave 5 | **Data-gated:** ≥4 weeks search activity since P06 producer wiring (2026-04-19). Earliest start ~2026-05-17. | S |
| P24 — Pipecat voice soak test | Master 0D / Phased Wave 6 | **Manual:** 2-week structured conversation soak; needs Troy time. | Manual / 2 wk |
| P25 — Voice architecture decision | Master 1C / Phased Wave 6 | **Depends on P24** results. Likely "keep both unless Pipecat gains HTTP upload". | S |
| P33 — Qdrant evaluation | Phased Wave 9 | **Scale-gated:** fires when embeddings count ≥ 50K (currently ~11K). | M |
| P34 — RTX PRO 2000 deployment | Master 5A / Phased Wave 9 | **Hardware:** purchase decision; eliminates API embedding cost when local. | Hardware / 1 wk |

**Plus stragglers from Master Plan:** "Observability & Monitoring" + "LiteLLM Cost Routing" already substantially shipped (Loki, Grafana, Prometheus live; LiteLLM retired in CS5) — likely close-out items.

---

### Mobile deferred — see [mobile-app-deferred.md](~/.claude/projects/.../memory/mobile-app-deferred.md) memory

**Scope:** Mobile app blueprint at `docs/superpowers/plans/2026-04-22-mobile-app.md` shipped via PR #172 (11 screens) + PR #174 (Expo SDK 54 upgrade). Items intentionally deferred from that initial release:

| Item | Notes |
|---|---|
| Streaming transcript UI | Real-time transcript display during voice capture |
| Push notifications | iOS/Android push for proactive briefings |
| EAS Build | TestFlight / production app store distribution |
| Cloudflare Tunnel for voice | Voice endpoint not yet behind tunnel (mobile uses Bearer auth) |
| Shared types export path | `@open-brain/shared` types accessible to mobile |
| Web `Voice.tsx` field bug | Pre-existing bug in deleted `packages/web` — irrelevant after Phase 8b deletion |

**Source plan:** `docs/superpowers/plans/2026-04-22-mobile-app.md` (3,936 lines — blueprint, not work-tracking; the 80 task items in it are mostly shipped per git log).

---

## Tracked action items — arch-review registry

From [IMPLEMENTATION_PLAN-ARCH-REVIEW.md §Deferred Items](IMPLEMENTATION_PLAN-ARCH-REVIEW.md#deferred-items-action-item-registry). Most A-numbers are CLOSED; below is the active subset:

| ID | Description | Class | Trigger to address |
|---|---|---|---|
| A71 | memory-consolidation task key (`'search_synthesis'` placeholder; real key `'memory_consolidation'` not in `ai-routing.yaml`) | Operational | ~1 hr filler work |
| A107 | `strictLimiter` double-registered on `/captures` (halves effective rate-limit budget) | Operational | Phase 5 D candidate |
| A110 | Settings `GET` has no whitelist gate — non-whitelisted key returns 404 instead of 400 | Operational | Future scope |
| A111 | `email_allowlist` has no array validator in `SETTINGS_VALIDATORS` | Operational | With A110 |
| A113 | UUID validation on briefs/sessions `:id` path param | Operational | Future scope |
| A114 | `sessions` `status_filter` silently dropped instead of 400-rejected | Operational | Future scope |
| A125 | `init-schema.sql` missing migration 0025 CHECK constraints (parity audit) | Operational | Schema parity sweep |
| A127 | 24 `react/no-unescaped-entities` lint errors in `HelpContent.tsx` | Pre-existing baseline | Targeted cleanup PR |
| A128 | TanStack Query hooks extraction (Phase 8a follow-up) | Pre-existing baseline | Separate plan; design work |
| A129 | Root `pnpm test:integration` script is not Windows-safe; PowerShell/pnpm parsed `test:integration;` as a script name, so use explicit compose up → package test → compose down sequence locally | Operational | Cross-platform script cleanup PR |
| A130 | `eslint-config-next` ^15 → ^16 bump (post-remediation Phase 3.3) implicitly requires ESLint 8 → 9 + flat-config migration. v16 config under ESLint 8 hits circular-JSON crash in `@eslint/eslintrc`. Reverted in PR #182; needs its own plan covering `eslint`, `eslint-config-next`, `.eslintrc.json` → `eslint.config.{js,mjs}` migration, plugin compat audit, and any new lint rules surfaced by the v16 ruleset | Operational | Separate plan/PR — "ESLint 9 + flat-config migration" |
| A116 | Vitest 2.x bump for per-file glob threshold support | Pre-existing baseline | See post-remediation Phase 5 (deferred) |
| A117 | SSE `onAbort` / post-promise cleanup branches unreachable | Pre-existing baseline | Excluded via `/* v8 ignore */` |
| A106 | TS2502 in `entity-resolution.test.ts:345` | Pre-existing baseline | Out of scope |
| A120 | TS2345 in `MPill.test.tsx` + `TabBar.test.tsx` (React 19 / react-test-renderer drift) | Pre-existing baseline | Separate PR |

**Operational items (8):** real follow-ups that should land in a future plan.
**Pre-existing baselines (6):** long-term debt; do not bundle into operational work.

---

## Recently-closed plans (archive references)

| Plan | Status | Closed | Notes |
|---|---|---|---|
| [IMPLEMENTATION_PLAN-POST-REMEDIATION.md](IMPLEMENTATION_PLAN-POST-REMEDIATION.md) | ✅ COMPLETE (Phase 3.3 escalated to A130) | PRs #180/#181/#182/#183 (2026-05-06 → 2026-05-07) | 4 phases / 16 items shipped; Phase 5 (Vitest 2.x) deferred to its own plan as authored. Phase 3.3 (`eslint-config-next` ^16) escalated to A130 — ESLint 9 + flat-config migration. Lab notebook Entries 131–135. |
| [IMPLEMENTATION_PLAN-ARCH-REVIEW.md](IMPLEMENTATION_PLAN-ARCH-REVIEW.md) | ✅ COMPLETE | PR #175 (2026-05-05) | R1–R12 (R10 dropped); 9 phases |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md) | ✅ COMPLETE | 2026-04-21 | 8/8 phases, 41 work items |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M3.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M3.md) | ✅ COMPLETE | 2026-04-22 (PR #170) | 8/8 phases; entity-brief, commitments, board, settings, onboarding |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M4.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M4.md) | ✅ COMPLETE | 2026-04-22 | 4/4 phases, 8 work items |
| Mobile app blueprint (`docs/superpowers/plans/2026-04-22-mobile-app.md`) | ✅ Substantially SHIPPED | PR #172 (2026-04-22) + PR #174 | 11 screens; deferred items tracked in `mobile-app-deferred.md` |

---

## Cross-plan interaction notes

| Risk | Detail |
|---|---|
| **A71 (memory-consolidation task key)** | Standalone — Phase 2 (PR #181) shipped without adding an F-ID for memory-consolidation; A71 remains an independent ~1 hr config edit. |
| **A125 partial closure ↔ workers integration tests** | PR #178 (2026-05-06) added migration 0025 CHECKs to `init-schema.sql` but did not add `capture_associations` (migration 0011). Phase 4 (PR #183) bridged this with a `setup.ts` supplement carrying an explicit removal comment. Full A125 closure should patch `init-schema.sql` directly so the supplement can be removed. |
| **A128 (TanStack Query hooks extraction) ↔ A130 (ESLint 9 + flat-config migration)** | Both touch the web-next package. A130 migrates lint config; A128 restructures hooks. Sequence A130 first if both pick up — flat-config rules may surface lint errors that A128's restructure should respect. |
| **P23 (cognitive memory tuning) ↔ A107 (strictLimiter double-reg)** | P23 measures live search behavior; A107 affects rate-limit effective budget — fix A107 before P23 starts to keep measurement clean. |

---

## Maintenance

- **When a plan ships:** mark COMPLETE here with closure date + PR number; move plan reference to "Recently-closed" section.
- **When a new plan lands:** add an entry to "Active plans" with a 1–2 line summary + link.
- **When an action item closes:** strike it from the table OR move to a separate "Closed action items" section if pattern emerges.
- **Authoritative source:** each row in this file links to the plan that owns the work. This file is an index, not a substitute. Detail lives in the source plan.
- **Memory pointer:** add a single line to `~/.claude/projects/<path>/memory/MEMORY.md` pointing to this file so it's discoverable across sessions.
