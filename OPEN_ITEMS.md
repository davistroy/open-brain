# Open Items Registry

**Purpose:** Single index of what's actually open across all implementation plans. Each entry links to the source plan for detail. Update when plans ship items or new plans land.

**Last refreshed:** 2026-05-06

---

## Active plans (with pending work)

### [IMPLEMENTATION_PLAN-POST-REMEDIATION.md](IMPLEMENTATION_PLAN-POST-REMEDIATION.md) — all pending

**Scope:** F1–F8 (Entry 106 architectural audit) + W1, W2, W3, W4, W7, S1, S3, S4, S5, W6 (Entry 107 intent review). Authored 2026-05-06.

| Phase | Items | Effort | Risk |
|---|---|---|---|
| 1 — Quick wins (deps + perf microfixes) | 4 | S | Low |
| 2 — Documentation alignment (README + PRD + TDD) | 3 | M | None |
| 3 — Type system & lint hygiene | 4 | S–M | Med |
| 4 — Workers test rigor (coverage + CI) | 5 | M | Med |
| 5 — Vitest 2.x migration | — | L | **DEFERRED** to its own plan |

**Total:** 16 work items pending. Phases 1–4 mutually independent (no file overlap); recommended sequential 1→2→3→4 in increasing-risk order.

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
| [IMPLEMENTATION_PLAN-ARCH-REVIEW.md](IMPLEMENTATION_PLAN-ARCH-REVIEW.md) | ✅ COMPLETE | PR #175 (2026-05-05) | R1–R12 (R10 dropped); 9 phases |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md) | ✅ COMPLETE | 2026-04-21 | 8/8 phases, 41 work items |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M3.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M3.md) | ✅ COMPLETE | 2026-04-22 (PR #170) | 8/8 phases; entity-brief, commitments, board, settings, onboarding |
| [IMPLEMENTATION_PLAN-CLOUDSCAPE-M4.md](IMPLEMENTATION_PLAN-CLOUDSCAPE-M4.md) | ✅ COMPLETE | 2026-04-22 | 4/4 phases, 8 work items |
| Mobile app blueprint (`docs/superpowers/plans/2026-04-22-mobile-app.md`) | ✅ Substantially SHIPPED | PR #172 (2026-04-22) + PR #174 | 11 screens; deferred items tracked in `mobile-app-deferred.md` |

---

## Cross-plan interaction notes

| Risk | Detail |
|---|---|
| **Post-remediation Phase 3 (`@types/node` align) ↔ Mobile deferred** | If picking up mobile EAS Build before post-remediation Phase 3 lands, ensure mobile package isn't pinned at a different `@types/node`. |
| **Post-remediation Phase 4 (workers CI) ↔ A128 (TanStack Query)** | Both touch testing infrastructure; sequence post-remediation first since it's smaller scope. |
| **A71 (memory-consolidation task key) ↔ Post-remediation Phase 2** | Phase 2 PRD update should add the F-ID for memory-consolidation skill; A71 fix is independent (config edit) but worth bundling for one PR. |
| **P23 (cognitive memory tuning) ↔ A107 (strictLimiter double-reg)** | P23 measures live search behavior; A107 affects rate-limit effective budget — fix A107 before P23 starts to keep measurement clean. |

---

## Maintenance

- **When a plan ships:** mark COMPLETE here with closure date + PR number; move plan reference to "Recently-closed" section.
- **When a new plan lands:** add an entry to "Active plans" with a 1–2 line summary + link.
- **When an action item closes:** strike it from the table OR move to a separate "Closed action items" section if pattern emerges.
- **Authoritative source:** each row in this file links to the plan that owns the work. This file is an index, not a substitute. Detail lives in the source plan.
- **Memory pointer:** add a single line to `~/.claude/projects/<path>/memory/MEMORY.md` pointing to this file so it's discoverable across sessions.
