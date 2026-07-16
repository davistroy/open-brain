# Implementation Plan — 2026-07 backlog (14 issues + actual-ingest spec)

**Generated:** 2026-07-15
**Based on:** ultra-plan Phase 0–4 (LAB_NOTEBOOK Entry 208) · `docs/superpowers/specs/2026-07-15-actual-daily-job-design.md` · GitHub issues #71 #196 #281 #282 #284 #285 #286 #290 #292 #294 #295 #298 #299 #300
**Sibling plan (coordinate, do not duplicate):** `~/dev/personal/homeserver/IMPLEMENTATION_PLAN_UPGRADES.md` — its **CS-4 owns open-brain PR #297**
**Total phases:** 10
**Status:** IN PROGRESS — **Phase 1 COMPLETE**, Phase 2 partial (see below). CI green (22 pass). All shipped work is repo-only; **nothing deployed**.
**Branch:** `feat/actual-daily-job` / PR #296

> **DATA RULE.** The repo is **PUBLIC**. No balances, amounts, merchant/payee names, account names, the Actual sync ID, server host/URL, or credentials in this document. Financial specifics live only in the gitignored `docs/ACTUAL_BUDGET_DEVELOPER_GUIDE.md` + Bitwarden.

> **This plan does NOT replace `IMPLEMENTATION_PLAN.md`** (v5 arch-review remediation, completed 2026-07-13). That plan is referenced by README/CHANGELOG/OPEN_ITEMS and is left untouched.

---

## Executive summary

Fourteen issues, one approved spec. Investigation found that **three issues' filed root causes were wrong**, one cited **evidence that did not exist**, and one issue **should not be implemented at all**.

The unifying defect across the pipeline issues: **the failure and its invisibility shipped in the same commit.** Every broken path returns early without touching `_JSON_ERRORS` (utility) or without a non-zero exit (email), so total failure is indistinguishable from an idle run. **Phase 1 fixes that first** — it is cheap, CI-verifiable, gated on nothing, and would have surfaced every one of these bugs three months ago.

The unifying defect across the infra issues: **a config that is COPIED rather than DEPLOYED will drift, and nothing compares the two copies.** Sixth instance this week (#278, #290, #292, #294, Entry 201, #299).

### Decisions taken (Troy, 2026-07-15) — do not re-litigate

| # | Decision | Consequence |
|---|---|---|
| **D144** | **Decommission obvm** — finish G-B.2/G-B.5, open since 2026-04-17 | #290 → decommission; **#284 dropped**; #282 shrinks to an OAuth publish |
| **D145** | **Eliminate secret interpolation** — `.env` holds no secrets and becomes optional | #281's durable fix; makes CLAUDE.md's rule true rather than amending it |
| **D146** | **`faster-whisper → speaches` filed but OUT of scope** — it is a migration, not a fix | New issue; own brainstorm |
| **D147** | **PR #297 lands first; its postgres recreate goes ALONE** | Phase 7 rebases onto it |

---

## Phase 0 — Constraints (gate every work item)

| Category | Non-negotiable |
|---|---|
| **Deploy** | Surgical `pull` + `up -d --force-recreate --no-deps <svc>`. **Never `--remove-orphans`**, **never bare `up -d`**, **never `compose down`** (new — see Phase 7). Config-diff gate before/after. **Any recreate MUST pass `-f docker-compose.override.yml`** or postgres comes up EMPTY. |
| **Shared images** | `ingest-sidecar:latest` is shared by `financial-ingest` + `utility-ingest` (D140/Entry 201) — recreate **both** or record why not. |
| **Done** | Branch → PR, never direct-to-main. Required checks: *Integration tests (core-api + real DB)* + *build-and-test*. **LAB_NOTEBOOK entry BEFORE the first commit of a sequence**; update Decision Log + Action Items. |
| **Tests** | Coverage gates live (workers 78/81 + four 100% file locks; core-api 80/80). **Raise, never lower.** Workers `lint` typechecks tests. |
| **Secrets** | BWS is source of truth. 3-step lockstep — **but see D145: the lockstep has no `.env` step, which is the hole.** Utility/financial secrets resolve at **runtime** via `bws secret list`, NOT the lockstep — do not cargo-cult. |
| **Cost tiering** | T0 → T1 → T2 (free) → T3 last. Aggregate before any LLM. |
| **Host** | Unraid has **no python3** — use bash/jq/sed. `claude` cannot `docker compose` there → `sudo -n docker compose`. `/boot/config` is root-only. |

---

## Interaction map

```
Phase 1 (honest failure) ──► everything (it is how you SEE the rest work)
Phase 2 (free wins)      ──► independent, ship immediately
Phase 3 (obvm proof)     ──► GATES #290/#282  [D144]
Phase 4 (backup)         ──► independent
Phase 5 (DR secrets)     ──► #300 (2 lines) ∥ #281 (design, D145)
Phase 6 (parity gate)    ──► #292 ──► #294b   (gate is the mechanism 294b needs)
Phase 7 (compose)        ──► BLOCKED ON PR #297 (homeserver CS-4)
                             #297 ──► #298 ──► actual-ingest   (all edit docker-compose.yml)
Phase 8 (#295 tz)        ──► collides BullMQ cluster onto host-cron cluster — see WI-8.2
Phase 9 (product)        ──► independent, lowest value
Phase 10 (operator)      ──► end, except blockers already surfaced
```

**Atomic sets (must ship together):**
- **WI-5.2**: `cloudflared env_file` **and** removing `GITEA_TOKEN` interpolation — both are "the value can't arrive"; splitting leaves a half-fixed DR story.
- **WI-7.2**: `br0` external **and** the actual-ingest service — the service cannot start without the network.
- **#297** (theirs): `shm_size` **and** `max_parallel_maintenance_workers` — see homeserver CS-4.

**Four workstreams edit `docker-compose.yml`** — #297, #298, actual-ingest, and (already present) #294's mount. **Serialize. Do not parallelize.**

---

## Phase 1 — Honest failure reporting ✅ **COMPLETE 2026-07-15**

*Gated on nothing. Fully CI-verifiable. Would have surfaced #284/#285/#286 three months ago.*

### WI-1.1 — utility-pipeline: failures must set `status: error` ✅ **DONE** (`0b01c39`)
> **8 tests written FIRST and watched fail RED against the old code** — the bug proven, not asserted: a water 401 really did report `status: ok`. Now green. 32 passed; ruff + pyright clean. Covers network failure, 401, non-200, unparseable JSON, unrecognised structure, and **received-rows-but-parsed-zero** (the one that would survive an auth fix and turn a loud 401 into a silent zero). Also corrected the stale "auth may NOW be required" comment — the API was never anonymous.
- **Change:** `scripts/utility-pipeline.py` — append to `_JSON_ERRORS` on the water path (`cmd_water`, ~`:229`) and the power path (`cmd_power_summary`, ~`:656-671`). `cmd_gas:630` is the working template.
- **Why:** `:1025` — `"status": "ok" if exit_code == 0 and not _JSON_ERRORS else "error"`. Water and power `return` without touching it, so **total failure reports success**.
- **Acceptance:** a water 401 and an absent power binary each produce `status: "error"`.
- **Verify:** `pnpm exec pytest docker/ingest-sidecar/tests/ -v` (new tests; the dir currently has **zero** water/power coverage)
- **CI-verifiable.** No operator gate.

### WI-1.2 — email-pipeline: stop swallowing the exception; exit non-zero
- **Change:** `scripts/email-pipeline.py:417-418` — log the real refresh exception (`invalid_grant` never reached the log for 3 months). `main()` (`:882-923`) — set a non-zero exit when a provider fails to authenticate.
- **Why:** the operator saw only a generic `:421` line; cron always saw exit 0.
- ⚠️ **Sequencing:** if D144 retires obvm, this file dies with it. **Do WI-1.2 only if Phase 3 shows obvm survives**, OR port the lesson to the TS path instead. **Re-evaluate after Phase 3.**
- **Verify:** ruff + pyright (no pytest exists for this file).

### WI-1.3 — Dockerfile build smoke test ✅ **DONE** (`594a5e6`)
> All three errors verified **live** before rewriting (org 404 · v2.4.1 not 0.5.0 · raw binaries not a tarball). Proven both directions by actually building: **OLD form + 404 → build exit 0 with NO BINARY**; **NEW form → exit 0, binary present (9,967,947 bytes), `--help` prints real usage**; **NEW form + bad version → exit 1, refuses to ship.**
- **Change:** `docker/ingest-sidecar/Dockerfile` — fix the org (`typ0` 404s → `tedpearson`, 51★), the version (`0.5.0` → **v2.4.1**), the asset format (**raw binaries, not `.tar.gz`** — so `tar -xzf` must go), drop `|| true`, add `-f` to `curl`, and add `RUN electric-usage-downloader --help`.
- **Why:** the Dockerfile self-documented `# TODO: unverified` and `# If the build fails here…` while `|| true` **structurally guaranteed it never would**. The smoke test is the Dockerfile equivalent of Entry 200's *"never ship a parser that hasn't run against a real artifact."*
- 🚨 **Converts a silent no-op into a hard release gate** — a bad URL now fails `build-images.yml:114-124`, blocking **both** sidecars. Land deliberately.
- 🚨 **Entry 201 trap:** this rebuilds the image `financial-ingest` also runs → **recreate both sidecars.**
- **Acceptance:** image build fails if the binary is absent. **This does not make power work** (see Phase 9 / #286).

---

## Phase 2 — Free wins 🟢

### WI-2.1 — ~~Recreate workers → revive the backup dead-man's switch (#294a)~~ 🔴 **WRONG — CORRECTED 2026-07-15 (Entry 211)**

> **This work item was based on my own "committed ≠ deployed" error.** I wrote *"the mount is already in `docker-compose.yml:195,202`; the fix is a recreate, not code"* — but I grepped the file **in my checkout**, not **on the host**. Verified live:
>
> ```
> /backup-latest landed in MAIN:    2026-07-13 (PR #244, cd287d8)
> workers container created:        2026-07-15T18:46:28Z  <-- it WAS recreated (14:46 ET)
> grep -c backup-latest <deployed>: 0                     <-- and STILL has no mount
> deployed compose HEAD:            a1629e4 (2026-06-16)  <-- ~1 month stale
> ```
>
> **A recreate is a NO-OP.** The container was recreated *after* the mount landed in main and still lacks it, because **the deployed compose file was never updated**. Root cause → **#302: compose changes have no deploy path** (`pull` ships images; the compose file only moves when a human runs `git checkout origin/main -- docker-compose.yml`).
>
> **WI-2.1 is therefore BLOCKED ON #302** and moves into the Phase 7 reconciliation window. It is not a free win.
>
> **Checking `docker-compose.yml` in your checkout tells you nothing about production.** Grep the host.

### WI-2.1a — File the systemic root cause (done)
- **#302** — compose changes have no deploy path. **Hard prerequisite for WI-7.1 (#298) and WI-7.2 (actual-ingest)**: both are compose changes and would **silently never deploy**, exactly like #294's mount.
- **#303** — `WorkersMetricsAbsent` can never fire: `absent()` on a **Pushgateway** metric, which retains the last value indefinitely, so a dead workers leaves it non-absent forever. Only `PushgatewayStale` (`push_time_seconds` age) can work. **OA-9b would have revealed this — it is still open, never run.**

### WI-2.1b — Compose parity gate ✅ **DONE** (`d80f6ca`) — `scripts/check-deploy-parity.sh`
> **Run against prod it reports DRIFT (exit 1)** and names what is missing: `shm_size` (#297), `BACKUP_LATEST_PATH` + the `/backup-latest` mount (#244 — **#294's root cause**), `OPERATOR_ACTIONS_PATH` + mount, the web-next healthcheck; plus a host-only `NEXT_PUBLIC_API_URL`. The D131 allowlist filters correctly. **Exits 2 — never 0 — when it cannot run** (unreachable host / bad ref / empty file), verified.
- **Change:** compare the **rendered** repo compose against the **rendered deployed** compose (`docker compose config`, not raw text), allowlisting the two documented deviations: the **D131 core-api `3002:3000`** sed and the **raw-bind override** for postgres/redis.
- **Why now, before any deploy:** Entry 207's own logic — *"Everything that drifted this week drifted because nothing compared the two copies. Comparison is the fix."* It would report *"deployed compose is 4 commits behind"* today, turning an invisible fact into a loud one. **It is a prerequisite for actual-ingest ever existing in prod**, not gold-plating.
- **Read-only** — the deployed file is readable as `claude`. Zero deploy risk.

### WI-2.2 — Stop clobbering `GITEA_TOKEN` ✅ **DONE** (`d506fd2`)
> Proven empirically under `env -i`: **with** the interpolation line → `GITEA_TOKEN=""`; **without** it → the env_file value survives. Deleting the lines IS the fix. Both blank-string warnings gone.
> ⚠️ **Also a compose change ⇒ it lands in the repo now but takes effect only at the Phase 7 reconciliation (#302).** Safe and correct to merge today; just don't record it as "fixed in prod" until the deployed compose moves. Same trap as WI-2.1 — *every* compose edit inherits it.
- **Change:** delete `GITEA_TOKEN: ${GITEA_TOKEN}` at `docker-compose.yml:114` and `:169`.
- **Why:** `env_file: .env.secrets` **already supplies it correctly**, then `environment:` overrides it with `""`. Proven empirically. Deleting the lines *is* the fix.
- **Verify:** `docker compose config 2>&1 | grep "Defaulting to a blank string"` → no `GITEA_TOKEN`.
- **CI-verifiable.**

---

## Phase 3 — obvm: prove, then retire (D144) 🔴 GATES #290/#282

### WI-3.1 — Settle double-classification from the DB (no host access)
- **Do:** query `email_classifications` grouped by hour/source. Both `email-classify` (TS, BullMQ, `0 5`) and obvm's Python cron (`0 5`) run at the same hour.
- **Hypothesis:** Python wins the race; the TS skill has been **shadowed since Phase 7**. Entry 205 saw `email-classify` classify **0 emails ("nothing new")** — consistent.
- **This decides the next three work items.** Do it first.

### WI-3.2 — Parity assessment: `email-classify` vs `email-pipeline.py`
- **Compare:** fetch (Gmail + Hotmail) · classify · move/label · dedupe · summarize · correction detection.
- **Why:** the refactor *intended* `EmailClassifySkill` to replace `email-pipeline.py` (`IMPLEMENT_LLM_GATEWAY_REFACTOR.md:576`). **Nobody verified it achieved parity.**
- **Carry the #284 lesson across:** does the TS path do Graph moves and persist **pre-move ids**? Graph `/move` destroys the original and mints a new id. If TS repeats the bug, fix it *there*. **This check is worth more than fixing the Python.**

### WI-3.3 — Retire obvm (#290)
- **Do:** disable obvm's cron (**G-B.2**), remove `email-pipeline` from `BYPASS_CALLERS` (`rate-limit.ts`), close **G-B.5**, mark A33 resolved (its rule accumulation never happened *because* correction detection never worked).
- **Operator-gated:** obvm ssh + crontab.
- **Then:** close #290, **close #284 as moot**, re-scope #282 → WI-3.4.
- **Move G-B.2/G-B.5 out of `docs/archived/`** — live unexecuted decisions must not live where nobody looks.

### WI-3.4 — #282 reduced to one thing: publish the OAuth app
- **Why this survives D144:** the TS `gmail-client` was seeded from the **same OAuth client**, so it dies on the **same 7-day Testing-mode clock**. Publishing is **not obvm-specific** — it follows you to TypeScript.
- **Operator-gated (hard):** Google Cloud Console, Troy's account. → **Phase 10 / OA**.

---

## Phase 4 — Backup integrity (#299)

### WI-4.1 — Recurse the config glob
- **Change:** `scripts/backup.sh:90-91` — `cp -a "${APP_DIR}/config/"*.yaml … 2>/dev/null || true` is **non-recursive with errors swallowed**. Every `config/` subdirectory (`prometheus/`, `grafana/`, `financial/`, `utility/`, `cloudflare/`) is in **no backup**, local or offsite, while the log says *"Backing up config files"*.
- **Do:** recurse (`find … -exec cp -a --parents` or `rsync -a --include='*/' --include='*.y*ml'`), drop the blanket `2>/dev/null || true`, and consider non-YAML (Grafana dashboard JSON is still missed even after recursing).
- **Acceptance:** a known subdirectory file appears in the backup tree; a copy failure is **visible**.
- **Guard:** `scripts/test-backup-secrets-redaction.sh` must stay green — recursing must not sweep in secrets.

### WI-4.2 — `.env` is in the backup, mislabeled
- **Finding:** `backup.sh:96` — `cp "${APP_DIR}/.env" "$CONFIG_DIR/dot-env"` under the comment **"Environment files — non-sensitive only."** It holds live credentials → violates CLAUDE.md:179 as literally written.
- **Note:** this **softens #281** — the raw material for `.env` recovery *is* in every backup. But **no runbook restores it**, so it's recoverable by improvisation, not by the documented path.
- **After D145 lands, `.env` holds no secrets and the comment becomes true.** Sequence WI-4.2 *after* Phase 5.
- **Mitigation today:** the offsite leg is an rclone **crypt** remote (encrypted at rest); the local tree is plaintext.

### WI-4.3 — Fix the redaction guard's self-defeating fixture
- **Finding:** `test-backup-secrets-redaction.sh:58-61` builds its fixture `.env` as `NODE_ENV`/`LOG_LEVEL` only — **its fixture encodes the assumption under dispute**, so it passes vacuously. Its pattern (`:120`) also **omits `REDIS_PASSWORD`**.
- **This is #278's blind spot, second occurrence** ("a fully green suite asserted nothing about the thing that is broken").
- **Do:** realistic fixture + add the missing vars. Also `:101` uses a hardcoded `sed -n '89,101p'` line range — brittle, already re-based once.

---

## Phase 5 — DR: secrets (#300, #281 / D145)

### WI-5.1 — #300: two lines
- **Change:** add `INGEST_TRIGGER_SECRET` to `deploy/.env.secrets.template` + `scripts/lib/secrets-map.sh`. Verify the **real** BWS name first (#278 found 11 of 14 mapped names were invented).
- **Why:** it's in 14 files, 0 in both. DR starts both sidecars unauthenticated → **401s every HTTP trigger while host cron keeps working and looks healthy.**
- **Also:** correct the "HMAC" comments (`docker-compose.yml:491,531`, `Dockerfile:7-8`) — `trigger_server.py:212-233` is a **plain constant-time bearer compare**; nothing is signed.
- **#300 ≠ #281** — a *process violation* (2-line fix) vs a *hole in the rule*. Do not merge them.

### WI-5.2 — #281 / D145: eliminate secret interpolation ⚛️ ATOMIC
- **Change:** every secret arrives via `env_file: .env.secrets`; **nothing secret is interpolated**.
  - `cloudflared` (`:459-479`) has **no `env_file:`** — its `:468` comment "set in .env.secrets" is **false**; add it.
  - `POSTGRES_PASSWORD` / `REDIS_PASSWORD`: deliver via `env_file`; where a **command** needs one (redis `--requirepass`), wrap in `sh -c` so it reads from the environment.
  - `GITEA_TOKEN`: already done in WI-2.2.
- **Result:** the 3 remaining interpolated vars (`LOKI_URL`, `TAILSCALE_IP`, `STAGING_DIR`) **all already have `:-` defaults** ⇒ **`.env` becomes optional.**
- **Why this over "automate `.env` too":** that entrenches secrets in a second file, needs a second audit path, and keeps the backup exposure. D145 makes the invariant **true** instead of amending it. `verify-secrets.sh`'s `0 drift` finally means *"a rebuilt host boots."*
- **Keep:** the `:?` fail-closed guards — they are the only reason this is loud. **Keep:** `BWS_ACCESS_TOKEN` out of `secrets-map.sh` (bootstrap exception, OA-4b).
- **Correction to the issue:** `POSTGRES_PASSWORD` (`:53`) trips first, **not** `REDIS_PASSWORD`. And `REDIS_PASSWORD` **is** mapped (`secrets-map.sh:49`) — it's a **file-target mismatch**, not a missing mapping.

### WI-5.3 — CI job: prove DR without a BWS token
- **Change:** new CI job — in a clean checkout: `docker compose -f docker-compose.yml config -q` **passes**, and `docker compose config 2>&1 | grep "Defaulting to a blank string"` returns **nothing**.
- **Why:** #281 reproduces **today** in CI, no host, no token. Its DoD proposes a manual rehearsal; **CI can do it.** No CI job validates the production compose today (only `docker-compose.test.yml`).
- **Also:** static assert that every var interpolated in compose exists in `.env.example`.

### WI-5.4 — `MORNING_BRIEF_SLACK_CHANNEL` is dead config, live today
- **Finding (new, no issue):** it's in `.env` — but **`.env` is only an interpolation source and never reaches a container**. `grep MORNING_BRIEF docker-compose.yml` → **no match**. So `workers` sees `undefined`, `morning-brief.ts:414` resolves `''`, Slack is silently skipped. `skill-execution.ts:260-262` documents the contract exactly.
- **You set it in a file that cannot deliver it.**
- **Do:** deliver it via `env_file`/`environment:`. **Verify:** `docker exec open-brain-workers printenv MORNING_BRIEF_SLACK_CHANNEL`; `slackSent: true` in logs.

### WI-5.5 — `GRAFANA_ADMIN_PASSWORD` is vestigial
- **Finding:** no grafana service in `docker-compose.yml` post-ADR-0004, yet `secrets-map.sh:81` still writes it where nothing reads it. #281's DoD item is **moot for this repo**.
- **Do:** remove it, or document it as the observability project's.

---

## Phase 6 — Config parity gate (#292) → #294b

### WI-6.1 — Parity gate (Entry 207's recommendation: gate FIRST, migrate later)
- **Change:** compare `config/prometheus/alerts/` against the deployed `/mnt/user/appdata/observability/config/prometheus/alerts`.
- **Refinement to Entry 207:** the deployed dir is **`root:root` 755** ⇒ a **read-only parity check CAN run as `claude`**. Entry 207 said "deploy-time only" — that's true for *writing*, not *reading*.
- **Real drift today:** repo-only = `backup.yml`, `slo.yml`, **`workers-staleness.yml`** (Entry 207 said two — it's **three**). Deployed-only = `cron-jobs.yml`, `host-resources.yml`, `probes.yml`.
- **Why gate before migrating:** moving rules while drift is undetectable is how you lose one silently. Comparison is the fix; relocation is cosmetics.

### WI-6.2 — #294b: rename + deploy `BackupStale`
- **Change:** rename to avoid the **name collision** with Unraid's appdata-plugin `BackupStale` (`host-resources.yml`, querying `appdata_backup_last_run_timestamp_seconds`). `/api/v1/rules` listing "BackupStale" is **a different alert** — that collision nearly produced a false "yes, deployed."
- **Depends on:** WI-6.1's mechanism + WI-2.1 (the gauge must exist first).
- **Lesson to encode:** *"the alert is loaded" ≠ "the alert works."* Check the query, the metric, and the input.

---

## Phase 7 — Compose window 🚨 BLOCKED ON PR #297

> **D147.** #297 (homeserver CS-4) lands first; this phase rebases onto it. **Its postgres recreate goes ALONE** — per D134, isolated waves, independently bisectable. Do not batch it with app changes.

### WI-7.1 — Remove voice-pipecat (#298 / D143)
- **Change:** delete the service, `packages/voice-pipecat/`, `config/voice.yaml` Deepgram STT/TTS, the `VoiceSection.tsx:164-165` health readout, the `container-health` probe entry, and the CI job.
- 🚨 **Grep `depends_on:` for the service name** — Phase 8b's exact bug: a stale `cloudflared.depends_on.web` survived a deletion and **blocked all deploys** (`d479c04`, Entry 143).
- **Fix the inverted comment** at `:340`: faster-whisper/voice-capture are labelled *"Legacy voice services (kept for fallback until voice-pipecat is validated)"* — **exactly backwards.**
- **Mark D135 MOOT** in ADR-0002's port table + SECURITY.md §4 — don't delete the rows; a reviewer should see it was **decided**, not dropped.
- **Do NOT revoke `DEEPGRAM_API_KEY`** — `deepgram-sdk` also appears under `/scripts` (#250/#255).

### WI-7.2 — actual-ingest sidecar ⚛️ ATOMIC (the spec)
- **Spec:** `docs/superpowers/specs/2026-07-15-actual-daily-job-design.md`. Own `node:22-slim` image — **not** a third consumer of the shared `ingest-sidecar` tag.
- 🚨 **`br0` MUST be `external: true`.** The homeserver plan's correction #15 warns that a compose which *owns* br0 would let `compose down` **delete it out from under five unowned containers — AdGuard (LAN DNS) and swag (all TLS)**. External networks are never created or removed by compose — that is the whole protection. **Never declare br0 with ipam/gateway/mac_address.** Add a prominent comment.
- **New standing rule:** **never `compose down`** — alongside "never bare `up -d`" / "never `--remove-orphans`".
- **Static IP is a compose literal (D142)**, with a comment mirroring `ai-routing.yaml:93`.
- **`actual-pipeline` → `BYPASS_CALLERS`** or the capture POST silently 429s.
- **Rules file:** `config/payee-rules.yaml`, gitignored, **host-only**, at `config/` **top level** so it rides WI-4.1's glob. Tracked `config/payee-rules.example.yaml` (synthetic payees) = schema + fixture.
- **Deploy note:** the deployed compose is a **stale clone with `MM` local mods** (HEAD `a1629e4`, ~1 month) — land upstream **then** pull; a hand-edit gets clobbered.

---

## Phase 8 — #295: scheduled jobs run UTC

### WI-8.1 — Pass `tz` at registration
- **Change:** `scheduler.ts:201` — `repeat: { pattern, tz: 'America/New_York' }`.
- 🚨 **Re-keys every job** (BullMQ encodes tz in the repeat key) → a one-time 4–5h shift. Land deliberately. #217's reconciliation will clean the orphans.

### WI-8.2 — Flagged consequence nobody has noted
- Fixing tz moves the BullMQ morning cluster from **02:00–03:15 ET onto 06:00–07:15 ET** — **directly onto the host-cron ingest cluster** (`0 6` financial, `30 6` utility) **and the new actual-ingest job**.
- Two **LLM-heavy** jobs (wiki-synthesis `0 6`, morning-brief `30 6`) would land on the same wall-clock as the ingest jobs they were previously four hours from.
- **Mitigating fact:** `financial-ingest` is **idle** (Plaid dropped, D138).
- **Decide slots deliberately.** The BullMQ slot registry (`scheduler-slots.test.ts`) does **not** see host cron — they are different schedulers and share no slots.

---

## Phase 9 — Product & remaining pipeline 🟡 lowest value

### WI-9.1 — #71: fix the real bug first
- **`temporal_weight` has two defaults.** `routes/search.ts:17` → `0.0` (GET); `schemas/search.ts:24` → `0.1` (POST); slack-bot passes `0.1`. **Same endpoint, different answer by verb.** Test-locked at `search-routes.test.ts:499`, so it's deliberate — but undocumented and surprising. **Pick one.**
- **Related-captures backend is fully built and unused:** `searchWithRelated()` + `spreading_activation()` ship today; only the CaptureDetail UI is missing. Consumers exist (search page, MCP).
- **Hebbian boost is hardcoded** at `search.ts:328-330` (`0.1`, max 10%) — not configurable. Tuning needs a code change; the issue assumes it's tunable.

### WI-9.2 — #285 Cobb Water: honest status now, B2C later
- **Phase 1 already fixed the silent-success half.** The rest is **operator-gated** and larger than the issue thinks:
  - The `"confirmed via HAR analysis"` citation is **fabricated** — the comment predates the doc by **8 hours**, and the doc concluded the **opposite** (JWT via Azure B2C OIDC + MFA). **The API was never anonymous.**
  - `getMeterReadings` is **unattested** — never observed in the HAR; the 401 masks a probable 404. Real endpoint: `GetBilledUsageGraphData`.
  - The parser **has never run against a real artifact** — its guessed fields match **nothing**; even perfect auth stores **zero rows**.
  - Units are **inverted** — the API returns per-period consumption; the code subtracts as if cumulative.
  - **`--water` was never scheduled.**
- 🚨 **A bogus-credential probe risks account LOCKOUT** — Entry 198's Gas South trick **does not port safely to B2C**.
- **Recommend:** do not attempt B2C without a decision. → Phase 10.

### WI-9.3 — #286 Cobb EMC: it's an unbuilt feature, not a bug
- **Phase 1 fixed the Dockerfile.** But **nothing invokes the binary** — `cmd_power_summary:670-671` logs *"Power CSV parsing will be implemented when the Go tool is running."* The CSV parser is unwritten; `data_dir` (`~/.electric-usage` → `/root/.electric-usage`) **is not a volume**, so any CSVs are lost on recreate.
- **Fixing the URL alone changes nothing.** → Troy's scoping call. Phase 10.

### WI-9.4 — #196 mobile
- None of the five deferred items exist (no `eas.json`, no `expo-notifications`, no voice ingress, no streaming). Mobile deliberately keeps **local type mirrors** with a drift-guard test rather than depending on `@open-brain/shared`. **EAS Build gates push notifications.** OA-7 says ingress is blocked on U3.

---

## Risk assessment

| Change set | Risk | Rollback |
|---|---|---|
| **WI-1.3** smoke test | Bad URL now **fails the build**, blocking both sidecars | Revert the Dockerfile line |
| **WI-2.1** workers recreate | Low — unique image, mount already in compose | Recreate from prior image |
| **WI-5.2** de-interpolation | **Moderate** — touches every service's env wiring on a running system | Revert compose; `.env` still present during transition |
| **WI-7.1** pipecat removal | Stale `depends_on` blocks **all** deploys (Entry 143) | `git revert`; image still in GHCR |
| **WI-7.2** br0 external | **A non-external br0 declaration could destroy LAN DNS + TLS** | Never declare non-external; config-diff gate |
| **#297** (theirs) | **Highest in the system** — postgres recreate; without `-f override` the **DB comes up EMPTY** | Their WI-4.2; verify `captures` = 11,301 |
| **WI-8.1** tz | Re-keys every repeatable job | Revert; #217 reconciliation cleans orphans |

## Unknowns register

| Unknown | Severity | Affects | Resolution |
|---|---|---|---|
| Is email double-classified? | **High** | Phase 3 | **WI-3.1** — DB query, no host access |
| Does `email-classify` reach parity? | **High** | D144 | **WI-3.2** |
| Does the TS path repeat the Graph move-id bug? | Medium | WI-3.2 | Read the TS move path |
| Does Cobb B2C prompt MFA? | High | WI-9.2 | Live attempt — **lockout risk** |
| Is `getMeterReadings` real? | Medium | WI-9.2 | 401 masks a probable 404 |
| Does `shm_size` alone suffice? | Low | #297 | ~509 MB DSM < 1 GB — probably; the pin is future-proofing |

## Definition of Done (runnable)

```bash
pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts
pnpm --filter @open-brain/workers  exec tsc --noEmit          # tests are typechecked too
pnpm --filter @open-brain/workers  test -- --coverage         # gate: lines 78 / funcs 81
pnpm --filter @open-brain/core-api test -- --coverage         # gate: 80 / 80
pytest docker/ingest-sidecar/tests/ -v                        # WI-1.1
bash scripts/validate-init-schema.sh                          # if any migration
docker compose -f docker-compose.yml config -q                # WI-5.3 (clean checkout)
docker compose config 2>&1 | grep "Defaulting to a blank string"   # expect NOTHING
```

## Scope boundaries

**In:** the 14 issues + the actual-ingest spec, per the decisions above.

**Explicitly OUT:**
- **`faster-whisper → speaches` (D146)** — a migration, not a fix; own brainstorm. Urgency is **lower than "21-month attack surface"** implies: it is bound **loopback-only** (`127.0.0.1:10300`), not internet-facing.
- **Linking Actual transfer pairs** — mis-linking is harder to undo than a category.
- **T1/Spark payee classification (D141)** — job stays pure T0.
- **PR #297 itself** — homeserver CS-4 owns it.
- **Migrating alert rules to the observability project** — gate first (Entry 207); relocation later.
- **`br0` IPAM root cause** — fixing its missing `ip-range` means recreating an Unraid-managed network shared by nine containers across other projects.

---

## Phase 10 — Operator actions (Troy) — END, per instruction

*Blockers were surfaced inline above (Phase 3 gates #290/#282; Phase 7 blocks on #297).*

| # | Action | Why only Troy | Blocks |
|---|---|---|---|
| **OA-a** | **Publish the Gmail OAuth app out of Testing mode** | Google Cloud Console, Troy's account. **Required either way** — the TS client shares the OAuth client and the same 7-day clock | #282 |
| **OA-b** | Disable obvm's cron (**G-B.2**); close **G-B.5** | obvm ssh + crontab | #290 |
| **OA-c** | Install the actual-ingest host cron (root; `/boot/config/plugins/dynamix/custom.cron` + `update_cron`) | root-only. **Editing `deploy/cron/unraid-ingest.cron` schedules NOTHING** — proven: `0 7 --balances` and `5 7 --account-monitoring` are in the repo but **not installed** | spec |
| **OA-d** | Create `config/payee-rules.yaml` on the homeserver | gitignored, host-only by design | spec |
| **OA-e** | Add BWS secrets: Actual password / sync ID / server URL | BWS mutation | spec |
| **OA-f** | **Confirm the router's DHCP pool floor** sits above the sidecar's static IP | router admin. *"Unclaimed today" ≠ "reserved"* | spec |
| **OA-g** | Decide: **is power ingestion still wanted?** | It is an unbuilt feature, not a bug | #286 |
| **OA-h** | Decide: **pursue Cobb Water B2C OIDC?** Approach A (headless browser) vs B | MFA may hard-gate it; **probe risks lockout** | #285 |
| **OA-i** | Tell the homeserver workstream: **PR #297 ships half its atomic pair** (no `max_parallel_maintenance_workers`) | cross-plan | #297 |
