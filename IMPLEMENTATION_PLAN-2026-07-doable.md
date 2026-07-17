# Implementation Plan — 2026-07 "Everything Code-Doable"

**Created:** 2026-07-17 · **Source:** `/ultra-plan` (Phases 0–5) · **Status:** APPROVED, PENDING execution

Covers the six open items that are code-doable now: **#281** (D145 kill compose secret-interpolation), **#340** (fix wrong BWS map names), **OA-26/#300** (ingest-trigger-secret — collapses into #340), **#71** (related-captures wiring + #335 doc cleanup), **#290** (obvm decommission code half), **#286** (Cobb EMC power build).

> **This plan does NOT overwrite** `IMPLEMENTATION_PLAN-2026-07-backlog.md` (which still has pending items). It is a standalone plan for the approved subset above.

> **BLOCKING precondition for execution:** per CLAUDE.md, a current `LAB_NOTEBOOK.md` entry (Objective / Hypothesis / Rollback) must exist **before the first commit** of each change set. One entry may cover a whole change set (= one phase here).

---

## Pre-Plan Gates (Phase 0 constraints — every change must comply)

| Constraint | Applies to |
|---|---|
| **Secrets in Bitwarden only**; new secret = 3-step lockstep (`deploy/.env.secrets.template` + `scripts/lib/secrets-map.sh` + consumer). `.env` is interpolation-source-only, never injected. | P1, P4 |
| **Deploy safety:** never `--remove-orphans` / never `compose down`; config-diff gate; postgres/redis stay **raw binds**; `br0` `external: true`; cloudflared distroless (no `sh -c`). | P4 |
| **Cost-tiering:** deterministic parse is T0 (no LLM). | P5 |
| **Public repo — no PII/account IDs/financial data in tracked files** (host-only + gitignored; creds BWS). | P5 |
| **BYPASS_CALLERS:** internal caller needs `X-Open-Brain-Caller` + bypass entry; removal must prove no in-repo live caller uses it. | P3 |
| **DB/migrations:** no auto-migration; `init-schema.sql` generated + parity gate on any new migration; enum change = 4-surface lockstep + drift tests. | (none add migrations here) |
| **Testing/CI:** coverage gates (core-api 80/80, workers 78/81); `tsc` on test files is CI-blocking; commit `pnpm-lock.yaml` with any `package.json`; `parseUUIDParam()` on new `:id` routes. | P2 |
| **Definition of done:** LAB_NOTEBOOK entry before first commit; branch → PR; 4 required checks green. | all |

---

## Scope & Exclusions

**In scope (code/repo):** everything in the phases below.

**Explicitly OUT of scope (operator/deploy handoffs — tracked in "Operator Handoffs" at the bottom, not code I write):**
- The postgres/redis/cloudflared **deploy window** for P4 (config-diff gate, recreate) — and bundling **OA-10** (`shm_size`) into it.
- obvm **VM decommission** + disabling its `0 5` email cron (P3 gate).
- The **SmartHub probe** for #286 (yours to run) and any host-cron install under `/boot/config` (P5).
- The **force-push + clone reset** after the P5 git-history scrub.

---

## Unknowns Register

| ID | Unknown | Severity | Affects | Resolution |
|----|---------|----------|---------|-----------|
| U1 | Is 2FA off on the Cobb EMC SmartHub account (does the downloader return CSV)? | High | P5 | **Your probe** before P5.2 build; fallback = manual Green Button CSV (same parser) |
| U2 | History-scrub decision | **RESOLVED** | P5.0 | Gitignore **+ scrub history** (force-push + clone reset) |
| U3 | Co-schedule OA-10 (`shm_size`) into the P4 postgres recreate? | Med | P4 deploy | Deploy-window logistics, your call at deploy time |
| U4 | Does the surviving `EmailClassifier` read `config/email-categories.yaml`? | Low | P3.5 | Verify rules provenance before deleting the YAML |
| U5 | Which Slack channel should the morning brief post to? | Low | P4.6 | **Troy** confirms the channel ID (non-secret config value) before wiring 4.6 |

---

## Risk Mitigation

| Phase | Top risk | Mitigation / Rollback |
|---|---|---|
| P1 | Promoting a not-yet-created optional to REQUIRED → reconcile exit-2 blocks all secrets | Keep the 5 uncreated ones OPTIONAL; only rename the 4 real-item keys. Rollback: `git revert` (no deploy) |
| P4 | Wrong `$$` escaping breaks redis auth; missed `environment:` removal re-clobbers a var; cloudflared token-name split | CI `compose config` gate + local diff pre-deploy; postgres/redis never recreated on `git revert`; deploy is operator-gated |
| P2 | Hot capture-page N-hop cost; hop-2 inert (sparse related) reads as broken | `max_related=10` cap built-in; graceful empty state; default-off on HTTP. Revert web-next component |
| P3 | Removing bypass before obvm cron off → 429s | Strict ordering gate (P3.1 parity → operator cron-off → P3.2). Rollback: re-add one line |
| P5 | SmartHub 2FA on / auth breaks; widening public leak | Probe before build (U1); Green Button fallback; leak scrub is a prerequisite (P5.0) |

---

## Phase 1 — CS-1 PR-A: Secrets-map name corrections (#340 + OA-26/#300)

**Merges immediately. No deploy** (inert until next `load-secrets.sh` reconcile). Independent of all other phases.

### 1.1 Correct the 3 "real-item-exists" BWS key names
- **Files:** `scripts/lib/secrets-map.sh` (`:74`, `:84`, `:98`)
- **Change:** rename mapped BWS names to the real keys —
  - `open-brain-slack-user-token` → `slack-user-token`
  - `dev/open-brain/mobile-api-key` → `MOBILE_API_KEY`
  - `dev/open-brain/ingest-trigger-secret` → `open-brain-ingest-trigger-secret` *(this is OA-26/#300 — the BWS item already exists; a rename, not a creation)*
- **Acceptance:** all three resolve against the live store; none is promoted out of OPTIONAL.
- **Verify:** `source ~/.config/claude-env.sh && bash scripts/verify-secrets.sh --target-dir <prod>` shows the formerly-dropped optionals now `present`.

### 1.1b Remove the vestigial `GRAFANA_ADMIN_PASSWORD` (backlog WI-5.5)
- **Files:** `scripts/lib/secrets-map.sh:81`, `deploy/.env.secrets.template:162`
- **Change:** **remove** the `open-brain-grafana-admin-password` → `GRAFANA_ADMIN_PASSWORD` map entry (do NOT rename it). Post-ADR-0004 there is **no Grafana service in this repo** — nothing reads it (grep-confirmed: 0 consumers in `docker-compose.yml`/`packages/`). Keeping it writes dead config to `.env.secrets`. It belongs to the standalone `observability` project.
- **Acceptance:** map no longer references grafana; `load-secrets.sh` still exit-0; observability project unaffected.

### 1.2 Reconcile mirror comments in the template
- **Files:** `deploy/.env.secrets.template` (`:60`, `:103`, `:162`, `:77`)
- **Change:** update the `# Bitwarden:` comments to the corrected names (lockstep hygiene).
- **Acceptance:** template comments == map keys.

### 1.3 Document (do NOT promote) the 5 not-yet-created optionals
- **Files:** `scripts/lib/secrets-map.sh` (SMTP×4 `:77-80`, voice `:89`)
- **Change:** leave OPTIONAL; add an inline note that these BWS items don't exist yet and must be created (to the canonical name) when the feature is enabled.
- **Acceptance:** `load-secrets.sh` still exit-0 with them absent; no REQUIRED promotion.

### 1.4 Close the structural blind spot — recorded real-BWS-key inventory guard
- **Files:** `scripts/test-secrets-roundtrip.sh` (add a fixture + assertion at the `:118-131` gap it already names)
- **Change:** add a committed **keys-only** inventory of the real BWS store and assert every REQUIRED + real-item-OPTIONAL map key is present in it (so a wrong name fails CI instead of silently dropping). No values.
- **Acceptance:** test goes RED against a deliberately-wrong map key; GREEN with 1.1 applied.
- **Verify:** `bash scripts/test-secrets-roundtrip.sh`

### 1.5 Doc reconciliation
- **Files:** `OPERATOR_ACTIONS.md` (OA-26 → DONE, "rename not creation"), `OPEN_ITEMS.md` (#300/#340)
- **Acceptance:** OA-26 marked done with the corrected root cause; #340 references the 9-item breakdown.

**Phase 1 DoD:** verify-secrets clean · roundtrip guard green · PR merged · no deploy.

---

## Phase 2 — CS-2: Related-captures (#71 sub-part 2) + #335 doc cleanup

**Parallelizable.** Deploy = app recreate (core-api + web-next), low risk.

### 2.1 Doc cleanup — temporal_weight bug is already fixed
- **Files:** `IMPLEMENTATION_PLAN-2026-07-backlog.md:274`, `OPEN_ITEMS.md:44`
- **Change:** mark the GET/POST `temporal_weight` mismatch DONE (commit `fc5bafd` / PR #335); stop describing it in the present tense.
- **Acceptance:** no doc claims the bug is open.

### 2.2 (Hardening) shared temporal-weight default constant
- **Files:** new const in `packages/shared/src/types/search.ts`; consumed by `packages/core-api/src/routes/search.ts:17` + `schemas/search.ts:28`
- **Change:** extract `DEFAULT_TEMPORAL_WEIGHT = 0.0` so GET/POST can never re-diverge.
- **Acceptance:** both schemas import the constant; `tsc` clean; rebuild `@open-brain/shared` before dependents.

### 2.3 New capture-seeded related endpoint
- **Files:** `packages/core-api/src/routes/captures.ts` (new `GET /api/v1/captures/:id/related`); `packages/core-api/src/services/search.ts` (reuse `findRelatedCaptures()` `:353`; surface `hop_count`)
- **Change:** endpoint validates `:id` with `parseUUIDParam()` (400 on malformed), calls `findRelatedCaptures([id])`, returns `{ related_results: SearchResult[] }` with `hop_count` added to each element.
- **Acceptance:** `curl /api/v1/captures/<valid-id>/related` → `related_results` array; malformed id → 400; deleted captures excluded (`0032` filter already in the SQL fn).
- **Verify:** `pnpm --filter @open-brain/core-api exec vitest run` (route test); manual curl.

### 2.4 Web-next client + component
- **Files:** `packages/web-next/lib/api/captures.ts` + `captures.hooks.ts` (new `related(id)` method + hook, mirror `entitiesApi.related`); `packages/web-next/lib/types.ts` + `lib/api/search.ts` (add `related_results` / related-capture typing); new `packages/web-next/components/capture/RelatedCaptures.tsx`
- **Change:** typed client + hook; component renders capture preview + score badge + optional hop-count badge; **graceful empty state** ("No related captures yet" — hop-2 is data-gated).
- **Acceptance:** component renders array; empty state clean; type-drift tests still green.

### 2.5 Wire into capture-detail
- **Files:** `packages/web-next/app/(shell)/captures/[id]/page.tsx` (fetch + render `RelatedCaptures` in the sidebar/new block)
- **Acceptance:** opening a capture shows the Related section; no hydration warnings (`useClientNow` pattern if any dates).

### 2.6 Tests + coverage
- **Acceptance:** core-api coverage stays ≥ 80/80; web-next type-drift + component tests green; `pnpm-lock.yaml` committed if deps change.

**Flagged follow-up (NOT in this phase):** activate the dormant read-side Hebbian boost by populating `recentCaptureIds` from a caller and making the hardcoded `0.1` (`services/search.ts:330`) configurable. Separate issue — needs a UX decision on "recent captures" provenance.

**Phase 2 DoD:** endpoint live · UI renders (with empty-state) · tests + coverage green · PR merged · app-recreate deploy.

---

## Phase 3 — CS-3: obvm decommission code (#290)

**GATED on OA-29** (07-17 parity) **+ operator disabling obvm's `0 5` email cron.** Deploy = core-api recreate.

### 3.1 Parity confirmation (run FIRST, no host access)
- **Query:**
  ```sql
  SELECT provider, COUNT(*), MIN(processed_at), MAX(processed_at)
  FROM email_classifications
  WHERE processed_at > now() - interval '1 day'
  GROUP BY provider;
  ```
- **Pass condition:** two rows (`gmail` + `hotmail`), both non-zero, from the 07-17 05:00 ET run.
- **Acceptance:** pass condition met → proceed; else STOP and investigate the in-stack skill.

### 3.2 Remove the bypass entry (AFTER obvm cron is off)
- **Files:** `packages/core-api/src/middleware/rate-limit.ts:51`
- **Change:** delete `'internal:email-pipeline',` (18 → 17). Keep `email-classify`, `email-compose-skill`, `email-worker`.
- **Acceptance:** grep proves no live-stack caller emits `email-pipeline`; the 3 sibling entries remain.
- **Verify:** `grep -rn "X-Open-Brain-Caller" packages/ cloudflare/ docker/` shows no `email-pipeline` from live code.

### 3.3 + 3.4 Docs
- **Files:** `CLAUDE.md:51` (bypass count 18→17, drop `email-pipeline`); `OPERATOR_ACTIONS.md` (OA-24/OA-29); `LAB_NOTEBOOK.md` (D144 resolved, #284 closed-by-decommission).

### 3.5 (Follow-up, flagged) retire the in-repo Python source
- **Files:** `scripts/email-pipeline.py` + siblings; `config/email-categories.yaml`
- **Gate (U4):** verify the surviving `EmailClassifier`/`EmailRules` does NOT read `email-categories.yaml` before deleting it.
- **Note:** inert once the cron's off and the bypass is gone; do as a separate cleanup PR.

**Phase 3 DoD:** parity green · obvm cron off (operator) · bypass line removed · docs updated · core-api recreate.

---

## Phase 4 — CS-1 PR-B: D145 eliminate secret interpolation (#281)

**Depends on Phase 1.** Code merges after PR-A; **DEPLOY HELD** for the stateful window (recreates postgres/redis/cloudflared — bundle with OA-10 per U3).

### 4.1 Compose: env_file + drop secret interpolation
- **Files:** `docker-compose.yml`
- **Changes:**
  - **postgres** (`:61-88`): add `env_file: .env.secrets`; drop `POSTGRES_PASSWORD: ${...:?}` (image reads the var directly).
  - **redis** (`:90-109`): add `env_file: .env.secrets`; wrap `command:` in `sh -c` using `$$REDIS_PASSWORD`; `$$`-escape the healthcheck (`redis-cli -a "$$REDIS_PASSWORD"`).
  - **cloudflared** (`:450-470`): add `env_file: .env.secrets`; drop `TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}` (distroless — **no `sh -c`**; relies on `.env.secrets` exposing `TUNNEL_TOKEN`, see 4.2).
  - **core-api / workers / slack-bot** (`:122-123`, `:180-182`, `:264`): remove the `POSTGRES_URL`/`REDIS_URL` `environment:` overrides (they'd clobber the env_file values — the GITEA_TOKEN failure mode).
- **Acceptance:** no secret-bearing `${...}` remains in the file; postgres/redis still fail loud on a genuinely-absent password; `br0` network ownership unchanged.

### 4.2 load-secrets.sh: synthesize URLs + emit TUNNEL_TOKEN
- **Files:** `scripts/load-secrets.sh`
- **Change:** after loading the password vars, synthesize and write `POSTGRES_URL=postgresql://openbrain:<pw>@postgres:5432/openbrain` and `REDIS_URL=redis://:<pw>@redis:6379` into `.env.secrets` (Option A, zero app churn — apps already read the URL). Emit `TUNNEL_TOKEN` (cloudflared's real var). Preserve atomic-write + 0600 + `BWS_ACCESS_TOKEN` preservation.
- **Acceptance:** a fresh `.env.secrets` contains `POSTGRES_URL`, `REDIS_URL`, `TUNNEL_TOKEN`.

### 4.3 Map/template: TUNNEL_TOKEN
- **Files:** `scripts/lib/secrets-map.sh` (`:58`), `deploy/.env.secrets.template` (`:137`)
- **Change:** align the cloudflared env-var to `TUNNEL_TOKEN` (rename or emit alongside `CLOUDFLARE_TUNNEL_TOKEN`).

### 4.4 CI guard (the durable class-wide fix)
- **Files:** `.github/workflows/ci.yml` (new job)
- **Change:** `docker compose -f docker-compose.yml config` with an **empty `.env`**; fail if stderr contains `Defaulting to a blank string`.
- **Acceptance:** job RED on any bare secret interpolation; GREEN after 4.1–4.3.
- **Verify:** `docker compose -f docker-compose.yml config 2>&1 | grep -i "defaulting to a blank"` → no matches.

### 4.6 Fix the `MORNING_BRIEF_SLACK_CHANNEL` live bug (backlog WI-5.4)
- **Files:** `docker-compose.yml` (workers `environment:`); a non-secret value in `.env`/compose
- **Finding (LIVE, grep-confirmed):** `MORNING_BRIEF_SLACK_CHANNEL` appears in **no** `docker-compose.yml` service, so `workers` sees `undefined`, `morning-brief.ts:414` resolves `''`, and the morning brief's Slack post is **silently skipped** (A145; `skill-execution.ts:263-264` documents the contract). It is a **non-secret config value**, not a DR secret.
- **Change:** deliver the channel to workers via `environment:` (or `.env` → `environment:` — NOT `env_file`, since it's not a secret). **Needs the target channel value from Troy** (see note below). *(Aside: the stale `dist/main.js` carries a hardcoded `?? "D0AR39RNG4E"` fallback the source lacks — ignore the dist; fix source delivery.)*
- **Deploy:** **workers-only recreate** — this does NOT need the stateful postgres/redis/cloudflared window and can ship ahead of it.
- **Verify:** `docker exec open-brain-workers printenv MORNING_BRIEF_SLACK_CHANNEL`; `slackSent: true` in the next morning-brief log.

### 4.7 Post-D145 backup `.env` cleanup (backlog WI-4.2)
- **Files:** `scripts/backup.sh:110-114`
- **Change:** once D145 (4.1–4.3) lands and `.env` holds no secrets, revisit the `cp .env → dot-env` copy — the "non-sensitive only" comment (`:110`) becomes literally true; consider dropping the copy entirely (`.env.example` already carries the template). **Sequence AFTER 4.1–4.3.**
- **Acceptance:** backup no longer carries any live-credential file; redaction guard (`test-backup-secrets-redaction.sh`) stays green.

### 4.5 Deploy (OPERATOR handoff — not code)
- Config-diff gate pre/post (`docker compose config --format json` → `jq -S` diff = intended delta only); postgres/redis render as **binds**; `--force-recreate --no-deps postgres redis cloudflared` + the app services whose URL env lines changed; confirm tunnel up + DB reachable. Bundle OA-10 `shm_size` here (U3).

**Phase 4 DoD:** CI compose-config gate green · code merged · `MORNING_BRIEF` delivered + workers-recreated (4.6, can ship early) · **stateful deploy held** (operator window).

---

## Phase 5 — CS-4: Cobb EMC power (#286)

**Probe-gated (U1).** Deploy = ingest-sidecar rebuild (**shared with financial-ingest — recreate both**) + utility-ingest + new host cron.

### 5.0 PREREQUISITE (security) — scrub the public config leak
- **Files:** `config/utility/utility-config.yaml` (untrack), `.gitignore` (add), git history
- **Change:** `git rm --cached config/utility/utility-config.yaml`; add to `.gitignore` (keep only `.example`); `git filter-repo` to purge from history.
- **Operator handoff:** force-push `main`; reset the homeserver clone at `/mnt/user/appdata/open-brain` and the VM clone (history rewritten).
- **Acceptance:** file untracked; `git log --all -- config/utility/utility-config.yaml` empty after scrub. **Treat the already-exposed account IDs as public going forward.**

### 5.1 GATE — SmartHub probe (OPERATOR)
- Confirm 2FA off; run pinned `electric-usage-downloader` v2.4.1 against `cobbemc.smarthub.coop` with real creds → interval CSV. Green-lights 5.2+. If it fails → Green Button manual-CSV fallback (same parser, 5.2 still applies).

### 5.2 New T0 CSV parser
- **Files:** new `scripts/lib/power_csv_parse.py` (pure stdlib, arithmetic-anchored — mirror `gas_bill_parse.py`)
- **Change:** parse columns `StartUnixMillis,EndUnixMillis,WattHours,CostInCents,MeterName`; aggregate interval → daily (`WattHours/1000 → kWh`, `CostInCents/100 → $`). **No LLM (T0).**
- **Acceptance:** deterministic; self-validating on unit arithmetic.

### 5.3 Parser unit tests
- **Files:** new `docker/ingest-sidecar/tests/test_power_csv_parse.py` (mirror `test_gas_bill_parse.py`)
- **Verify:** `python -m pytest docker/ingest-sidecar/tests/test_power_csv_parse.py`

### 5.4 Rewrite the ingest stub
- **Files:** `scripts/utility-pipeline.py:663-696` (`cmd_power_summary`)
- **Change:** replace the TODO stub — glob persistent CSV dir, call `power_csv_parse`, idempotent upsert into `power_readings(date, kwh, cost_estimate)` keyed on `date`; **keep `_JSON_ERRORS.append` fail-loud** (configured-but-empty = `status: error`, per the #275 lesson).
- **Acceptance:** a dry run with sample CSV writes rows; empty dir → `status: error`.

### 5.5 Fix the downloader config schema + BWS templating
- **Files:** `config/utility/electric-usage-downloader-config.yaml`
- **Change:** real flat schema (`smarthub.api_url: https://cobbemc.smarthub.coop`, `account`, `service_location`, `timezone`, top-level `extract_days`); template creds from BWS (`COBB_EMC_USERNAME`/`COBB_EMC_PASSWORD`) into an ephemeral path at container start — never committed.
- **Acceptance:** no plaintext creds in any tracked file.

### 5.6 utility-config split-key + persistent data_dir
- **Files:** `config/utility/utility-config.yaml` *(now host-only, per 5.0)*
- **Change:** convert power block `bitwarden_key` → split `bitwarden_username_key: COBB_EMC_USERNAME` / `bitwarden_password_key: COBB_EMC_PASSWORD` (gas precedent); `data_dir: /data/electric-usage`.

### 5.7 Persistent volume
- **Files:** `docker-compose.yml:536-539`
- **Change:** ensure the downloader output dir sits under `utility_ingest_data:/data` (so CSVs survive `--force-recreate`).
- **Acceptance:** `docker compose config` shows the path mounted.

### 5.8 Cron that actually runs the downloader (OPERATOR install)
- **Files:** `deploy/cron/unraid-ingest.cron` (add the "if/when wired" entry `:39-41`)
- **Change:** run `electric-usage-downloader` before `--power-summary`. **Host cron install under `/boot/config` is operator (root) — repo template installs nothing.**

### 5.9 Verify
- `pytest` green; manual run populates `power_readings`; `utility-pipeline.py --monthly-comparison` includes power; MoM uses existing `alert_thresholds.power_mom_pct: 20`.

**Phase 5 DoD:** leak scrubbed + force-pushed (operator) · probe passed (operator) · parser + tests green · sidecar rebuilt (both ingest services) · cron installed (operator) · power_readings populating.

---

## Implementation Sequence

1. **P1** (CS-1 PR-A) — now, no deploy.
2. **P2** (CS-2) — parallel; app-recreate deploy.
3. **P3** (CS-3) — code ready; gated on OA-29 parity + obvm cron-off; core-api recreate.
4. **P4** (CS-1 PR-B) — after P1; code merges; **deploy held** (stateful window, bundle OA-10).
5. **P5** (CS-4) — leak scrub (5.0) → your probe (5.1) → build (5.2–5.7) → sidecar rebuild + cron.

## Operator Handoffs (not code)

| Ref | Action |
|---|---|
| P4 deploy | postgres/redis/cloudflared recreate via config-diff gate; bundle OA-10 `shm_size` |
| P3 gate | Confirm OA-29 parity; disable obvm's `0 5` email cron; then decommission the VM |
| P5.0 | Force-push after history scrub; reset homeserver + VM clones |
| P5.1 | Confirm 2FA off; run the SmartHub probe |
| P5.8 | Install the downloader host cron under `/boot/config` + `update_cron` |

## Definition of Done (whole plan)

- Every phase: LAB_NOTEBOOK entry before first commit · branch → PR · 4 required CI checks green · coverage gates held (raise, never lower).
- New CI compose-config gate (P4.4) green.
- Docs reconciled (OPEN_ITEMS, OPERATOR_ACTIONS, CLAUDE.md, LAB_NOTEBOOK) as each item lands.
