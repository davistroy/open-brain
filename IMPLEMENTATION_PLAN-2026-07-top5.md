# Implementation Plan — 2026-07 Top-5 Backlog

**Created:** 2026-07-18 · **Source:** `/ultra-plan` of the 6 open GitHub issues (top 5 by priority).
**Decisions applied (this plan):** D150 (#312 → rename app), D151 (#286 scrub → full history rewrite), D152 (newsletter → drop), D153 (#301 → migrate now via alias mount).
**Repo is PUBLIC** — no secrets / financial account IDs / payee-account names in any tracked file, commit, or PR. This plan doc describes the leak-scrub *process* only; the ID values live solely in a local gitignored replace-expressions file + Bitwarden.

## Pre-plan gates (Phase 0 constraints — every item complies)

- branch → PR, never direct to `main`; LAB_NOTEBOOK entry before the first commit of any code change.
- Homeserver deploy = surgical `pull` + `up -d --force-recreate --no-deps <svc>`; **never `--remove-orphans`, never `compose down`, postgres+redis are raw binds**; config-diff gate.
- Secrets in Bitwarden only (`bws`); 3-step lockstep; `bws` is NOT on the Unraid host (OA-33).
- Coverage gates: workers 78/81, core-api 80/80 — raise, never lower. Workers `lint` typechecks test files too.
- Observability is an EXTERNAL compose project (ADR-0004): Prometheus rules are in-repo (`config/prometheus/alerts/`), Alertmanager routing/receivers are NOT.
- Operator-gated steps → dated `OPERATOR_ACTIONS.md` OA-* entries.

## Execution sequence

CS-1 (trivial, restores alert trust) → CS-2 (stop the live leak) → CS-3 (power go-live, needs CS-2) → CS-4 (obvm retire, needs CS-2 done for utility-setup doc) → CS-5 (low-urgency migration). CS-1 and CS-5 are independent and may run anytime.

---

## CS-1 — #312 Pushover branding (D150: Option A)

**Status: code already shipped (PR #313). Only operator + optional cosmetic remain.**

### WI-1.1 (operator) — OA-25: rename the Pushover app
- Rename the "Voice Capture" app → "Open Brain" in the pushover.net console (Troy's account). Token unchanged → fixes BOTH the in-app title banner AND the external Alertmanager paging path with zero code/env/observability edits.
- **Acceptance:** the next infra Pushover (any `container-health`/`pipeline-health`/backup alert) shows banner "Open Brain", not "Voice Capture".
- **Rollback:** rename back (reversible).

### WI-1.2 (code, OPTIONAL, low value) — strip redundant title literals
- Remove now-redundant hardcoded `'Open Brain:'` prefixes from ~8 skill titles (`pipeline-health.ts:550,585`, `container-health.ts:309`, `secret-rotation.ts:332,431`, `stale-captures.ts:236`, `capture-dedup-sweep.ts:309`, `cost-analysis.ts:324`, `capture-reminder.ts:102`). `withIdentity()` is idempotent, so these are harmless today — cleanup only.
- **Acceptance:** `pushover.test.ts` green; a spot-check title still renders `Open Brain: …` exactly once.
- **Verify:** `pnpm --filter @open-brain/workers test`
- **Rollback:** revert PR.

---

## CS-2 — #286 utility-config leak scrub (D151: full)

**Live leak:** `config/utility/utility-config.yaml` is git-tracked and carries real account IDs at HEAD (lines 18, 37); its `.example` falsely claims it's gitignored. IDs also persist in history (`19ddf7f` onward) + former `utility-pipeline.py` defaults (removed at HEAD by #349).

### WI-2.1 (code PR) — untrack + gitignore + fix false comment
- `git rm --cached config/utility/utility-config.yaml`.
- Add `config/utility/utility-config.yaml` to `.gitignore` (mirror the `payee-rules.yaml` precedent at `.gitignore:110`).
- Correct `config/utility/utility-config.example.yaml` — its "Real file … is gitignored" line becomes TRUE once WI-2.1 lands; keep/clarify it. Confirm the `.example` carries only placeholders (`<from bitwarden>`), which it does.
- **Acceptance:** `git ls-files config/utility/utility-config.yaml` → empty; `git check-ignore config/utility/utility-config.yaml` → matches; `.example` has no real values.
- **Rollback:** revert PR (host file untouched — it's host-only, not in this VM checkout).

### WI-2.2 (operator, BEFORE the homeserver pulls WI-2.1) — protect the host-only config
- On the homeserver, back up `/mnt/user/appdata/open-brain/config/utility/utility-config.yaml` (host-only real config) **before** the deploy pulls WI-2.1 — a pull that drops the path from the tree will delete it; restore afterward. (Post-#299 it's also in `backup.sh`, a second safety net.)
- **Acceptance:** after deploy, the host file still present with real values; `utility-ingest` still reads it (gas run still parses).

### WI-2.3 (operator, root, DESTRUCTIVE) — history rewrite + force-push
- Local mirror clone; `git filter-repo --path config/utility/utility-config.yaml --invert-paths` (purge the file from ALL history) **and** `--replace-text <local-gitignored-expressions-file>` mapping each historical account-ID string → `<REDACTED>` (the expressions file is created locally from the known IDs, never committed).
- Force-push `main` (and any other refs). **Reset every clone** (homeserver `/mnt/user/appdata/open-brain`, obvm if still alive) — `git clean -x` would delete the now-ignored host config, so back up first (WI-2.2) and restore after.
- **Acceptance:** `git log --all --full-history -- config/utility/utility-config.yaml` → empty; a masked `git log -S<id> --all` → empty; all clones re-based to the rewritten history with host-only config intact.
- **Rollback:** none for a completed force-push — this is one-way; the pre-rewrite refs are preserved in a tagged backup bundle (`git bundle create pre-scrub.bundle --all`) before force-push.
- **Note:** the IDs were already public on GitHub; force-push removes them from current state + fresh clones but cannot purge forks/caches. Accepted per D151.

---

## CS-3 — #286 power feature go-live (OA-31)

**Code is complete + deployed today** (py3.14 sidecar: `power_csv_parse.py`, `cmd_power_summary`, `power_readings` table, tests, EUD binary). Sequenced AFTER CS-2 so `power.*` edits land only in the host-only config.

### WI-3.1 (code PR, 1 line) — fix stale docstring
- `scripts/utility-pipeline.py:15` — drop "(stub)" from the `--power-summary` help line (it's implemented at `:670`).
- **Verify:** `python3 -m pytest docker/ingest-sidecar/tests/test_power_csv_parse.py`

### WI-3.2 (operator) — OA-31 go-live
- Probe: confirm SmartHub 2FA OFF, run pinned `electric-usage-downloader` v2.4.1 against `cobbemc.smarthub.coop` → interval CSVs (fall back to Green Button CSV export if it only writes InfluxDB).
- Host `utility-config.yaml`: set `power.data_dir: /data/electric-usage`, `power.timezone`, `power.bitwarden_username_key/password_key`; ensure BWS `COBB_EMC_USERNAME`/`COBB_EMC_PASSWORD` exist; template `electric-usage-downloader-config.yaml` creds + `account`/`service_location` at run time (never commit).
- Install host cron that runs the downloader before `--power-summary` (`/boot/config/plugins/dynamix/custom.cron` + `update_cron`).
- **Acceptance:** `docker exec open-brain-utility-ingest ...` shows `power_readings` populated; `--monthly-comparison` includes power; run reports `status: ok`.
- **Rollback:** none needed (additive; inert until the cron runs).

---

## CS-4 — #290/#284/newsletter → obvm retirement (D152: drop newsletter)

### WI-4.1 (operator, FIRST — avoids 429s) — decommission obvm
- Snapshot obvm (KVM) for rollback. Disable its `0 5` email + `0 8` newsletter crons; confirm no further POSTs. Decommission the VM.
- **Acceptance:** obvm crontab empty / VM off; no `internal:email-pipeline`/`internal:newsletter-pipeline` traffic in core-api logs.

### WI-4.2 (code PR) — drop the newsletter feature + email-pipeline remnants
- Remove `internal:newsletter-pipeline` from `BYPASS_CALLERS` (`packages/core-api/src/middleware/rate-limit.ts:56-57`); rebuild the stale `dist` (`packages/core-api/dist/index.js:58-59`).
- Delete `scripts/newsletter-pipeline.py`, `scripts/tests/test_newsletter_pipeline.py`, `config/financial/newsletter-advisors.yaml`.
- Delete the obvm-only Python email pipeline (`scripts/email-pipeline.py` + obvm-only siblings `email-archive-by-year.py`, `email-cleanup*.py`) — dead once obvm is gone.
- **Acceptance:** `grep -r newsletter-pipeline packages/ scripts/` → empty; core-api + workers build + `lint` green; `scheduler-slots.test` unchanged; BYPASS_CALLERS count drops by 1.
- **Verify:** `pnpm --filter @open-brain/core-api lint && pnpm --filter @open-brain/core-api test`
- **Rollback:** revert PR (feature was already dropped operationally with obvm).

### WI-4.3 (code PR, docs) — cleanup + close
- Update `CLAUDE.md:53` (remove the newsletter-pipeline caveat + bypass roster) and `:177` (obvm path ref); `docs/utility-setup.md:3,14-15,99` (stale obvm host doc); close OA-12/24/29; mark #290/#284 resolved in `OPEN_ITEMS.md`.
- Close #290 (VM retired) and #284 (dropped) — **note in the #284 closure that the issue title misdiagnosed the root cause** (it was `move_email` discarding the new id → dead-id GET, not `cleanup_spam()`).
- **Rollback:** revert PR.

---

## CS-5 — #301 speaches migration (D153: now, via alias mount)

Single consumer: `voice-capture/transcription.ts`. speaches is OpenAI-compatible (same `/v1/audio/transcriptions`, port 8000, `/health`). Keep the service **named `faster-whisper`** to avoid churning the `container-health` probe + test.

### WI-5.0 (pre-work, resolve unknowns — GATES 5.1) — ✅ RESOLVED 2026-07-18 (docs research, Entry 246)
- Pull the current speaches settings schema → confirm the exact env var names (WHISPER__* replacements: model / inference device / compute type).
- Confirm the `verbose_json` response shape returns `language`, `duration`, and `segments[]{start,end,text}` (else `transcription.ts:54-66` degrades silently). Verify against a live speaches response (throwaway container).
- **Acceptance:** documented env var names + confirmed response shape.

**Findings (authoritative — speaches.ai docs + DeepWiki):**
- **Env var renames:** `WHISPER__DEVICE` → **`WHISPER__INFERENCE_DEVICE`** (default `auto`); `WHISPER__COMPUTE_TYPE` **unchanged** (keep `int8`). **`WHISPER__MODEL` is GONE** — speaches has NO "default model" env var; it loads models lazily *per request* (resolved through `model_aliases.json`) and pre-warms via **`PRELOAD_MODELS`** (a JSON array of HF ids). Server bind: `UVICORN_HOST` (`0.0.0.0`) / `UVICORN_PORT` (`8000`).
- **Model TTL:** STT models **unload after 300 s idle** by default → on this low-traffic CPU path the first post-idle request cold-loads large-v3 (seconds). Pin resident if the 2-min transcription timeout is at risk (env var name for TTL not yet confirmed; `PRELOAD_MODELS` only warms at *startup*, not after an unload).
- **`model_aliases.json` path is FIXED at `/home/ubuntu/speaches/model_aliases.json`** (no env override) — the mount target must be exactly this. Loaded once at startup; restart to change. Docs use `whisper-1` as the example alias → our `model=whisper-1` POST resolves once the file maps it.
- **Image `ghcr.io/speaches-ai/speaches:latest-cpu`** — multi-arch (amd64/arm64), listens on **8000**, ~1.2 GB. HF cache: **`/home/ubuntu/.cache/huggingface/hub`** (named volume `hf-hub-cache`); container runs **non-root as `ubuntu`** (→ U3).
- **verbose_json shape:** speaches is OpenAI-compatible + faster-whisper-based → returns `text` + `language` + `duration` + `segments[]{id,start,end,text,…}`. `transcription.ts:61-66` already defaults every field except `text` (language→`en`, duration→`0`, segments→`[]`), so a shape mismatch **degrades (empty segments), never crashes**. **Residual:** the live throwaway-container check is DEFERRED to WI-5.2 deploy (drive a real transcription) rather than blocking 5.1 — justified by the graceful defaults + low urgency. Spin a `latest-cpu` container first if a pre-merge live check is wanted.

### WI-5.1 (code PR) — swap image + alias mount + port fix  *(env vars/paths now pinned by WI-5.0)*
- `docker-compose.yml` faster-whisper block: image → `ghcr.io/speaches-ai/speaches:latest-cpu`. Env: `WHISPER__DEVICE`→`WHISPER__INFERENCE_DEVICE: cpu`; keep `WHISPER__COMPUTE_TYPE: int8`; **remove `WHISPER__MODEL`**; add `PRELOAD_MODELS: '["Systran/faster-whisper-large-v3"]'`. Point the model cache volume at **`/home/ubuntu/.cache/huggingface/hub`** (a NEW named volume — old `whisper_model_cache` at `/root/.cache/...` won't be reused → ~3 GB re-download on first boot). Consider pinning the model-TTL to keep large-v3 resident (confirm the exact TTL env var at build time).
- Mount `config/whisper/model_aliases.json` (new) to the FIXED path **`/home/ubuntu/speaches/model_aliases.json:ro`**, contents `{"whisper-1": "Systran/faster-whisper-large-v3"}` → **`transcription.ts` unchanged** (avoids app-code churn).
- Fix `transcription.ts:5` default port `10300` → `8000` (latent bug; only worked via compose `WHISPER_URL`).
- Keep service name `faster-whisper` → `container-health.ts:64` + test unchanged.
- **Acceptance:** container healthy; a real audio POST to `/v1/audio/transcriptions` with `model=whisper-1` returns `verbose_json` with text+segments; `transcription.test.ts` green.
- **Verify:** `pnpm --filter @open-brain/voice-capture test`; drive a live transcription end-to-end post-deploy.

### WI-5.2 (operator) — deploy
- `pull` + `up -d --force-recreate --no-deps faster-whisper` (then `voice-capture` if env changed). ~3 GB model re-download on first boot (cache path moved → old volume not reused). Verify a real iOS-Shortcut voice capture transcribes.
- **Rollback:** revert WI-5.1 → `fedirz/faster-whisper-server:0.5.0-cpu` (old cache volume still present); recreate.

---

## Risk & rollback summary

| CS | Top risk | Mitigation / rollback |
|---|---|---|
| CS-1 | Option A rebrands voice-memo confirmations too | Intended; reversible via `PUSHOVER_TITLE_PREFIX=''` or app rename-back |
| CS-2 | force-push breaks clones / deletes host config | `git bundle` backup before force-push; back up + restore host config; reset clones deliberately |
| CS-3 | downloader writes InfluxDB not CSV | Green Button CSV export fallback (same parser) |
| CS-4 | VM decommission is one-way; dropping a used feature | KVM snapshot; repo evidence shows newsletter config is placeholder-only |
| CS-5 | response-shape / env-var mismatch silently degrades | WI-5.0 gate resolves both before writing compose; revert to 0.5.0 image |

## Unknowns register

| # | Unknown | Severity | Affects | Resolution |
|---|---|---|---|---|
| U1 | speaches exact env var names | Med | CS-5 | ✅ RESOLVED (WI-5.0): `WHISPER__INFERENCE_DEVICE`, `WHISPER__COMPUTE_TYPE` (kept), drop `WHISPER__MODEL`, add `PRELOAD_MODELS`; aliases at fixed `/home/ubuntu/speaches/model_aliases.json` |
| U2 | speaches `verbose_json` field shape | Med | CS-5 | ~RESOLVED (WI-5.0): OpenAI-compatible → `text`/`language`/`duration`/`segments[]`; `transcription.ts` defaults all but `text` (degrades, no crash). Live check deferred to WI-5.2 deploy |
| U3 | speaches non-root volume UID perms on Unraid | Low | CS-5 | Container runs non-root as `ubuntu`; new `hf-hub-cache` vol at `/home/ubuntu/.cache/huggingface/hub` — verify on deploy; chown if needed |

## Scope boundaries

**In scope:** the 5 change sets above. **Explicitly NOT in scope:**
- #196 (mobile app) — deferred, separate effort.
- **Out-of-scope finding (file a separate issue):** the in-stack TS Hotmail `detectCorrections` (`hotmail-client.ts:453-495`) appears logically inert — it lists messages *within* `folderId` then flags `parentFolderId !== folderId` (≈always false), so in-stack Hotmail correction detection may never fire. Distinct from #284; not touched here.
- The observability-project Alertmanager receiver (Option B for #312) — not this repo; not pursued per D150 (Option A).
