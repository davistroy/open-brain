# Implementation Plan — Waves 2026-04-17

**Source:** `/ultra-plan` session 2026-04-17 (LAB_NOTEBOOK Entries 069 + 070, verified Phase 4 summary approved).
**Branches off:** `main` at `16f1dbc` (post G-C.1 deploy + dashboard task list documented).
**Scope:** Five change sets (CS1–CS5) spanning Python pipeline completion, utility sidecar deployment, upload backend, two-wave dashboard upgrade, and safe decommissioning. Wave 3 dashboard items are **out of scope**, tracked in Entry 070 for later.

---

## Phase tracker

| CS | Name | Branch | Status | PR |
|---|---|---|---|---|
| CS1 | Financial pipeline completion (#87 refactor + Schwab Balances/Positions parsers) | `feature/g-c-1-finish` | COMPLETE 2026-04-17 | — |
| CS2 | Utility sidecar deploy (Gas South + Cobb EMC + host cron) | `feature/g-c-2-utilities` | Pending | — |
| CS3 | Upload backend + sidecar HTTP trigger | `feature/ingest-upload-backend` | Pending | — |
| CS4a | Dashboard Wave 1 (upload UI + Financial page + pulse card) | `feature/dashboard-wave-1` | Pending | — |
| CS4b | Dashboard Wave 2 (email compose + autonomy + investments + settings rework) | `feature/dashboard-wave-2` | Pending | — |
| CS5 | Safe decommission (branches + seed script + old DB row + LITELLM config cruft) | `chore/decommission-safe-subset` | Pending | — |

**Sequencing (enforced below per phase, Day 1 = merge-day-of-first-deploy):**

```
Day 1 parallel:  CS1  ──┐
                 CS5  ──┤      (each <2 hrs, each own PR)
                 CS2  ──┘
Day 2:           CS3                   (gates on CS2 Dockerfile)
Day 3-4:         CS4a                  (gates on CS3 endpoints)
Day 4-5+:        CS4b                  (W2.3 Investments data-gated on CS1 snapshots)
```

**Hard gates:** each phase's PR must be CI-green and squash-merged to `main` before the next phase's branch is cut. **Process rule from LAB_NOTEBOOK Entry 067:** no direct-to-main pushes — every code change goes via feature branch + PR + CI + review.

---

## CS1 — Financial pipeline completion

**Branch:** `feature/g-c-1-finish`
**PR title:** `G-C.1 finish: refactor 4 direct-POST sites + Schwab Balances/Positions parsers`
**Est wall-clock:** 90 min
**Est diff:** +250 / −90 LOC in `scripts/financial-pipeline.py`

### Intent
Close out the post-deploy tech-debt from G-C.1 (#87) by moving the 4 remaining direct-POST sites onto the fixed `_post_capture` helper, and ship the 2 Schwab snapshot parsers that make item D (Balances + Positions) ingestable. Both land in one script, one atomic PR.

### Work items

- [x] **CS1.1** Refactor `cmd_sync` (L521 area) to `_post_capture(cfg, summary_text, meta, capture_type='observation', brain_view='personal')`. Keep the per-call meta shape (`type='financial_daily'`, `date`, `transaction_count`, `grand_total`, `accounts`).
- [x] **CS1.2** Refactor `cmd_balances` (L710) similarly (`type='balance_snapshot'`).
- [x] **CS1.3** Refactor `cmd_investments` (L954) similarly (`type='investment_weekly'`).
- [x] **CS1.4** Refactor `cmd_monthly_report` (L1352) similarly (`type='financial_monthly'`).
- [x] **CS1.5** `_parse_schwab_balance_csv(filepath)` — preamble regex `"Balances for account  XXXX-(\d+) as of (MM/DD/YYYY HH:MM (AM|PM) ET)"`, section loop, returns `{account_mask, as_of, account_value, cash, market_value, non_margin, margin, sections: {...}}`. Tolerant of missing sections.
- [x] **CS1.6** `_parse_schwab_position_csv(filepath)` — preamble regex `"Positions for account <account_type> ...(\d+) as of HH:MM (AM|PM) ET, YYYY/MM/DD"`, header line, per-holding rows, final `"Positions Total"` row captured as `totals`. Returns `{account_mask, account_type, as_of, positions:[...], totals:{...}}`.
- [x] **CS1.7** `_format_schwab_balance_capture(result)` and `_format_schwab_position_capture(result)` helpers returning `(content, source_metadata)`. Content stays short + skimmable; metadata carries the full structured record.
- [x] **CS1.8** Router additions in `_route_bank_csv`:
  - `re.search(r'_balances_[\d-]+\.csv$', lower)` → `_parse_schwab_balance_csv`
  - `re.search(r'-positions-[\d-]+\.csv$', lower)` (space-tolerant via `lower.replace(' ', '-')` OR regex `[ -]?`) → `_parse_schwab_position_csv`
- [x] **CS1.9** Wire into `cmd_process_inbox` dispatch (dispatches on `_source` to the matching `_format_schwab_balance_capture` / `_format_schwab_position_capture`; `_format_bank_capture` remains the default for Amex/Chase/Truist/Schwab-transactions/HSA/PayPal).
- [x] **CS1.10** Laptop smoke test against all 6 CSVs in `data/` (3 Balances + 3 Positions). Verify expected totals: Contributory 252 = $880,554.63; Designated Bene 6448 = $66,876.62; Simple IRA 7324 = $140,612.99. Contributory Positions GLDM = 1,833 @ $94.84 = $173,841.72.

### Acceptance criteria

- 4 refactored call sites send the nested `metadata.source_metadata` envelope + `capture_type='observation'` + `brain_view='personal'`.
- 2 new parsers + 2 format helpers + 2 router entries.
- 6 captures land in DB when CSVs are dropped + `--process-inbox` run: `schwab_balance_snapshot` × 3, `schwab_position_snapshot` × 3.
- Existing 6 parsers still parse correctly (no regression).
- LAB_NOTEBOOK Entry 071 covers Hypothesis + Rollback + post-deploy validation.

### File changes

- **Modified:** `scripts/financial-pipeline.py`

### Test plan

- [ ] Laptop: replay all 9 prior-deploy CSVs + 6 new Schwab Balances/Positions. All 15 should dispatch and parse.
- [ ] Homeserver: rebuild financial-ingest image, drop the 6 new CSVs, `--process-inbox`, verify 6 new captures in `captures` table with `source_metadata.type IN ('schwab_balance_snapshot', 'schwab_position_snapshot')`.
- [ ] VM (Bond): no touching — `--sync` and `--monthly-report` get their fixes landed but VM cron isn't re-triggered from this PR.

### Rollback

`git revert <sha>` — no new tables, no config, no migrations. If captures have landed, they stay in the DB with source_metadata intact; only code path removed.

---

## CS2 — Utility sidecar deployment

**Branch:** `feature/g-c-2-utilities`
**PR title:** `G-C.2: utility sidecar + Gas South + Cobb EMC + shared ingest-sidecar image + host cron`
**Est wall-clock:** 2.5 hours
**Est diff:** +350 / −180 LOC

### Intent
Extend the G-C.1 pattern to utilities. Same Python sidecar shape (long-lived container, host cron triggers) runs `utility-pipeline.py` for Gas South (active) and Cobb EMC (needs electric-usage-downloader Go binary). Refactor the Dockerfile into a shared `docker/ingest-sidecar/` layer so financial + utility are two CMDs on the same image. Closes GitHub issue **#65**.

### Work items

- [x] **CS2.1** Create `scripts/lib/capture_api.py` with `get_capture_api_config(cfg) -> (url, caller)` and `post_capture(cfg, content, metadata, capture_type='observation', brain_view='personal') -> bool`. Implements env-var override precedence + nested metadata envelope + `allow_redirects=False` + 3xx logging. Net −duplication across both pipelines.
- [x] **CS2.2** `scripts/financial-pipeline.py` — replace its in-file `_get_capture_api` and `_post_capture` with imports from `scripts.lib.capture_api`. Confirm by running the parser smoke test again.
- [x] **CS2.3** `scripts/utility-pipeline.py` — three-fix pattern:
  - Env-var overrides: `UTILITY_PIPE_DIR` (default `~/.utility-pipeline`), `UTILITY_CONFIG_DIR` (default repo `config/utility/`).
  - Replace in-file `post_capture` with import from `scripts.lib.capture_api`.
  - Update `cmd_monthly_comparison` + any other POST sites to pass `capture_type='observation'`, `brain_view='personal'`.
- [x] **CS2.4** Rename `docker/financial-ingest/` → `docker/ingest-sidecar/`. Update compose build context accordingly.
- [x] **CS2.5** Dockerfile additions:
  - Install `electric-usage-downloader` Go binary from pinned GitHub release (verify sha256).
  - `COPY scripts/lib /app/lib` (new shared module).
  - Keep existing Python + bws + requests/PyYAML layer.
  - Keep `CMD ["sleep", "infinity"]` for now (CS3 replaces it with `trigger_server.py`).
- [x] **CS2.6** `.dockerignore` — add negation for `!scripts/lib/` alongside the two pipeline scripts.
- [x] **CS2.7** `docker-compose.yml`:
  - `financial-ingest` service: update build context to `docker/ingest-sidecar/`, image name `open-brain-ingest-sidecar:latest`.
  - New `utility-ingest` service cloned from financial-ingest with container name `open-brain-utility-ingest`, UTILITY_* env vars, bind-mount `/mnt/user/appdata/open-brain/utility-inbox:/inbox`, separate named volume `utility_ingest_data`.
  - Both services reference the same image.
- [x] **CS2.8** `config/utility/utility-config.yaml` — confirm `capture_api` block exists or add if missing (homeserver has it; local may not). Make the `caller_header` default `utility-pipeline`.
- [x] **CS2.9** `config/ingest-routes.yaml` (new) — shared filename→source-type table (used in CS3 by both TS router and Python dispatcher). Preliminary shape:
  ```yaml
  routes:
    financial:
      - pattern: "activity.csv"
        parser: amex
      - pattern: "Chase*Activity*.CSV"
        parser: chase
      - pattern: "acct_*.csv"
        parser: truist
      - pattern: "*_Transactions_*.csv"
        parser: schwab_transactions
      - pattern: "*_Balances_*.CSV"
        parser: schwab_balance
      - pattern: "*-Positions-*.csv"
        parser: schwab_position
      - pattern: "HSA*.csv"
        parser: hsa
      - pattern: "Download*.csv"
        parser: paypal
        header_sniff: '"Balance Impact"'
    utility:
      - pattern: "*.pdf"
        parser: gas_bill
      - pattern: "*power*.csv"
        parser: power
  ```
  For CS2 this is a config file; actual consumption ships in CS3.
- [ ] **CS2.10** Homeserver deploy (DEPLOY, not just merge):
  - `git pull` → `docker compose build financial-ingest utility-ingest` (builds shared image once).
  - `mkdir -p /mnt/user/appdata/open-brain/utility-inbox`.
  - `docker compose up -d financial-ingest utility-ingest`.
  - Smoke test: `docker exec open-brain-utility-ingest python /app/utility-pipeline.py --status`.
  - Gas South live test: `docker exec open-brain-utility-ingest python /app/utility-pipeline.py --gas`. Expect billing history fetched; if API changed, file separate bug.
  - Cobb EMC live test: `docker exec open-brain-utility-ingest electric-usage-downloader --config /root/.electric-usage/config.yaml`. Config.yaml needs SmartHub creds from Bitwarden — **one-time manual step during deploy**.
- [ ] **CS2.11** Host cron (Unraid) — edit `/boot/config/plugins/dynamix/cron.json` or wherever Troy's current cron lives. Add 3 lines (financial daily, utility daily gas+power, utility monthly comparison). Persist via `/boot/config/go` per Unraid convention (same pattern as sudoers per memory).
- [ ] **CS2.12** Close GitHub issue **#65** with a status comment + link to the LAB_NOTEBOOK entry.

### Acceptance criteria

- Single shared image `open-brain-ingest-sidecar` powers both containers.
- `utility-pipeline.py --status` clean.
- `--gas` returns non-error against live Gas South API.
- `--power-summary` reports "no CSV files" cleanly if electric-usage-downloader hasn't produced output yet; `--gas` writes at least one Gas South row to SQLite.
- Host cron shows three lines; verify via `crontab -l` on Unraid after deploy.
- Financial-ingest still works — regression check via an inbox reprocess.
- Issue #65 closed.
- LAB_NOTEBOOK Entry 072 covers deploy + validation.

### File changes

- **New:** `scripts/lib/capture_api.py`, `scripts/lib/__init__.py`, `config/ingest-routes.yaml`, `docker/ingest-sidecar/Dockerfile` (renamed from financial-ingest)
- **Modified:** `scripts/financial-pipeline.py` (extract helpers), `scripts/utility-pipeline.py` (three fixes), `docker-compose.yml` (2 services on shared image), `.dockerignore` (add lib/ negation)
- **Deleted:** `docker/financial-ingest/Dockerfile` (moved to ingest-sidecar)

### Test plan

- [ ] Laptop: `python scripts/financial-pipeline.py --process-inbox` against a test CSV — confirm helper extraction didn't break anything. `python scripts/utility-pipeline.py --status` passes.
- [ ] CI: `pnpm -r lint` unaffected (Python changes); Python pipelines have no unit tests currently (known gap).
- [ ] Homeserver post-deploy: both sidecars healthy; one manual `--gas` run succeeds; one manual `--process-inbox` on financial side succeeds (regression check).
- [ ] 24 hrs post-deploy: host cron log shows at least one scheduled run per pipeline.

### Rollback

Revert PR. `docker compose down open-brain-utility-ingest`. Remove 3 host cron lines. Financial sidecar continues on the shared image (no behavior change). Database: no schema changes to undo. utility_ingest_data named volume can be removed at leisure (empty after rollback).

---

## CS3 — Upload backend + sidecar HTTP trigger

**Branch:** `feature/ingest-upload-backend`
**PR title:** `Ingest upload backend: streaming uploads, file_uploads table, sidecar HTTP trigger`
**Est wall-clock:** 4 hours
**Est diff:** +650 / −0 LOC

### Intent
Backend plumbing for Wave 1 of the dashboard. Users drop files in the browser → core-api streams them to the inbox bind-mount → BullMQ job → HTTP POST to sidecar `/process` endpoint → captures land → SSE updates the UI. Replaces the `scp` + `docker exec` manual workflow.

### Work items

- [ ] **CS3.1** Migration `packages/shared/drizzle/0021_file_uploads.sql`:
  ```sql
  CREATE TYPE file_upload_status AS ENUM ('pending', 'processing', 'parsed', 'failed');
  CREATE TABLE file_uploads (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    filename text NOT NULL,
    size_bytes bigint NOT NULL,
    mime_type text,
    source_type text NOT NULL,              -- 'financial' | 'utility'
    parser_hint text,                        -- e.g. 'amex' when auto-detected; null if unknown
    destination_path text NOT NULL,          -- path inside container volume
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    status file_upload_status NOT NULL DEFAULT 'pending',
    capture_ids uuid[] DEFAULT '{}',
    error_message text,
    processed_at timestamptz,
    duration_ms integer
  );
  CREATE INDEX idx_file_uploads_uploaded_at ON file_uploads (uploaded_at DESC);
  CREATE INDEX idx_file_uploads_status ON file_uploads (status) WHERE status IN ('pending', 'processing');
  ```
- [ ] **CS3.2** Drizzle schema in `packages/shared/src/schema/supporting.ts` — add `file_uploads` table + enum + types.
- [ ] **CS3.3** `packages/core-api/src/schemas/ingest.ts` (new) — Zod schemas for upload metadata (filename, size, source_type) and list query.
- [ ] **CS3.4** `packages/core-api/src/routes/ingest.ts` (new):
  - `POST /api/v1/ingest/upload` — multipart/form-data. Max 100MB. Streams to `/app/inbox-volumes/<source>/<uuid>-<safe-filename>`. Uses Hono's `c.req.raw.body` → `pipeline(readable, createWriteStream)` (Node streams, no full-buffer). Inserts `file_uploads` row; enqueues `ingest-process` job. Returns `{upload_id, status: 'pending'}`.
  - `GET /api/v1/ingest/uploads?limit=20&offset=0&status=?` — paginated list with capture_ids joined to capture title snippets.
  - `POST /api/v1/ingest/process-now?source=<financial|utility>` — manual re-trigger without a new upload. Useful for "process inbox now" UX button.
- [ ] **CS3.5** `packages/workers/src/jobs/ingest-process.ts` (new) — BullMQ job:
  - Reads `file_uploads.id` from job data → loads row → marks `processing`.
  - HTTP POST to `http://open-brain-<source>-ingest:8080/process` with 5-min timeout.
  - On 200: parse response JSON for `capture_ids` + `duration_ms` + `errors`. Update row to `parsed`/`failed` accordingly.
  - On timeout/network error: retry 2x with 30s backoff, then `failed`.
  - Emits SSE `upload:status` events at every transition.
- [ ] **CS3.6** `packages/core-api/src/services/sse.ts` — extend the hub with `upload:status` channel.
- [ ] **CS3.7** `docker/ingest-sidecar/trigger_server.py` (new) — Python `http.server` + threading. Single endpoint `POST /process`:
  - Reads body JSON for optional source hint (or defaults to the pipeline bound to this container).
  - Acquires a `/tmp/process.lock` file lock (prevents concurrent runs).
  - `subprocess.run(['python', '/app/<source>-pipeline.py', '--process-inbox', '--json-output'], timeout=300)`.
  - Parses JSON output for capture IDs.
  - Returns `{status: 'ok'|'error', captures_posted: [...], errors: [...], duration_ms: N}`.
  - Health endpoint: `GET /health` returns 200 if lock is free OR 409 if process in flight.
- [ ] **CS3.8** Dockerfile `CMD` change: replace `sleep infinity` with `python /app/trigger_server.py`.
- [ ] **CS3.9** `scripts/financial-pipeline.py` + `utility-pipeline.py` — add `--json-output` arg. When set, the final line of stdout is a JSON summary: `{captures_posted: ['<uuid>', ...], errors: [...], duration_ms: N}`. Required for CS3.7's parsing.
- [ ] **CS3.10** API client `packages/web/src/lib/api.ts` — new `ingestApi` section (Wave 1 W1.3 spec).
- [ ] **CS3.11** Consume `config/ingest-routes.yaml` in TS — create `packages/core-api/src/services/ingest-router.ts` that reads the YAML, exposes `routeFile(filename, headerBytes?) -> {source_type, parser_hint}`. Used by CS3.4 upload endpoint to populate `file_uploads.source_type` + `file_uploads.parser_hint` + choose bind-mount subfolder.
- [ ] **CS3.12** Consume same YAML in Python — `scripts/lib/ingest_router.py` mirrors the logic; `_route_bank_csv` and utility routing refactor to read from the YAML. Prevents TS/Python drift.
- [ ] **CS3.13** Deploy: rebuild both sidecars (trigger_server.py + scripts/lib), rebuild core-api + workers. Apply migration 0021. Manually verify upload via curl against `/api/v1/ingest/upload`. Verify capture lands and file_uploads row transitions pending → processing → parsed.

### Acceptance criteria

- curl-based upload works end-to-end: CSV → inbox → capture → file_uploads row `status=parsed` with populated `capture_ids`.
- SSE stream emits at least one `upload:status` event per upload.
- Sidecar health endpoint responds on `/health`.
- YAML-based routing produces identical results to the prior hard-coded router for all 15 existing CSVs.
- 100MB upload succeeds without >1GB memory spike in core-api (verified via `docker stats`).
- Migration applied cleanly; `file_uploads` table present.
- LAB_NOTEBOOK Entry 073 covers Hypothesis + Rollback + deploy validation.

### File changes

- **New:** `packages/shared/drizzle/0021_file_uploads.sql`, `packages/core-api/src/routes/ingest.ts`, `packages/core-api/src/schemas/ingest.ts`, `packages/core-api/src/services/ingest-router.ts`, `packages/workers/src/jobs/ingest-process.ts`, `docker/ingest-sidecar/trigger_server.py`, `scripts/lib/ingest_router.py`
- **Modified:** `packages/shared/src/schema/supporting.ts`, `packages/core-api/src/services/sse.ts`, `packages/core-api/src/index.ts` (route registration), `packages/web/src/lib/api.ts`, `docker/ingest-sidecar/Dockerfile` (CMD change + copy trigger_server.py), `scripts/financial-pipeline.py` + `scripts/utility-pipeline.py` (--json-output flag + router import)

### Test plan

- [ ] Unit tests for `ingest-router.ts` (+ Python equivalent via smoke test on all 15 existing filenames).
- [ ] Integration test: upload fixture CSV → verify job runs → verify capture + file_uploads state.
- [ ] Upload a 100MB file, monitor memory — core-api RSS should not exceed ~200MB during the upload.
- [ ] Concurrent upload test: 3 uploads of the same file in quick succession — sidecar should serialize via lock; all 3 uploads either parse or one parses + two show `captures_posted=[]` (dedup) without errors.

### Rollback

- Revert PR — trigger_server.py removed, CMD returns to `sleep infinity`, routes removed from core-api.
- Migration rollback: Drizzle down-migration drops `file_uploads` table + enum.
- In-flight uploads: safe — orphan rows in file_uploads are harmless; any in-progress file on disk can be manually moved to inbox for next scheduled cron.

---

## CS4a — Dashboard Wave 1

**Branch:** `feature/dashboard-wave-1`
**PR title:** `Dashboard Wave 1: Ingest page + Financial page + FinancialPulseCard`
**Est wall-clock:** 5 hours
**Est diff:** +1250 / −30 LOC

### Intent
Ship the first user-visible benefit of the upload backend: a drag-drop Ingest page, a per-source Financial page browsing the 9+ (soon 15+) financial captures, and a top-of-dashboard "Financial pulse" card that reflects 2,745+ transactions of ingested history. No Wave 2 items in this phase.

### Work items

- [ ] **CS4a.1** Run `npx shadcn@latest add dialog tabs progress` in `packages/web/` — adds the new primitives to `components/ui/`. One commit at the top of the branch.
- [ ] **CS4a.2** Add `react-dropzone` (if not already in lockfile) — `pnpm --filter @open-brain/web add react-dropzone`.
- [ ] **CS4a.3** `packages/web/src/components/FileDropZone.tsx` — shared drop-zone with onFiles callback + accept-type list + max-size guard + keyboard accessibility. ~180 LOC.
- [ ] **CS4a.4** `packages/web/src/lib/types.ts` — discriminated union for financial `source_metadata` keyed on `source_provider`. ~40 LOC.
- [ ] **CS4a.5** `packages/web/src/lib/api.ts` — add `ingestApi` section (W1.3 spec): `upload(file, sourceType?)`, `listRecent(limit)`, `getStatus(uploadId)`, `processNow(source?)`. ~60 LOC.
- [ ] **CS4a.6** `packages/web/src/pages/Ingest.tsx` (new) + route in `App.tsx`:
  - Hero drop zone (reuses FileDropZone). On drop: call `ingestApi.upload()`, show progress bar (Progress primitive), wait for SSE `upload:status` events, render result pill.
  - Manual source-type override dropdown (shadcn Select).
  - Recent uploads table (below drop zone) — pulls `ingestApi.listRecent(20)`, shows filename / size / source / status / capture-id chips (link to `/timeline?capture=<id>` OR `/financial?capture=<id>`).
  - "Process inbox now" button (W2.5) — calls `ingestApi.processNow()` for manual re-trigger; moved into Wave 1 since it's a 30-LOC addition.
  - ~380 LOC total.
- [ ] **CS4a.7** `packages/core-api/src/schemas/capture.ts` — add `source_provider` to `listCapturesSchema`. ~2 LOC. Plus matching SQL WHERE in `routes/captures.ts` listCaptures handler. ~5 LOC.
- [ ] **CS4a.8** `packages/web/src/pages/Financial.tsx` (new) + route + `components/FinancialSummaryCard.tsx`:
  - Tabs per provider (Amex / Chase / Truist / Schwab / HSA / PayPal). Tab count + $ badge from prefetched counts.
  - Each tab: reverse-chron list of captures filtered via `capturesApi.list({ source_provider: 'amex', ... })`. Each capture rendered as an expandable `FinancialSummaryCard` showing category breakdown (horizontal bars, plain CSS — no chart library needed for Wave 1) + top 10 transactions table.
  - Empty state when a provider has no captures: "Upload an [X] CSV in Ingest to see data here."
  - ~450 LOC total.
- [ ] **CS4a.9** `packages/web/src/components/FinancialPulseCard.tsx`:
  - Client-side aggregates the last-30-day financial captures (pulls via `capturesApi.list({ brain_view: 'personal', capture_type: 'observation', ... })` filtered by `source_metadata.type LIKE '%_activity'`).
  - Renders total spend, MoM delta arrow + %, top 3 merchants (from per-capture top_transactions arrays unioned), inline sparkline (plain SVG, 30 daily aggregates).
  - Clickable → routes to `/financial`.
  - ~150 LOC.
- [ ] **CS4a.10** `packages/web/src/pages/Dashboard.tsx` — slot `FinancialPulseCard` into the existing grid, above or alongside StatsCards. Minor touch.
- [ ] **CS4a.11** `packages/web/src/components/Layout.tsx` — add 2 sidebar nav items: "Ingest" (Upload icon) + "Financial" ($ icon).

### Acceptance criteria

- Drag-drop upload works in browser; result pill shows within ~30s for a typical CSV.
- Ingest page's recent uploads table populates from the API.
- Financial page renders all 6 provider tabs, each with expandable capture cards.
- FinancialPulseCard appears on Dashboard, click routes to Financial.
- No JavaScript errors in browser console on any new page.
- Dark mode preserved (shadcn primitives inherit).
- `pnpm --filter @open-brain/web lint` + `pnpm --filter @open-brain/web test` green.
- LAB_NOTEBOOK Entry 074 covers UX verification + screenshots.

### File changes

- **New:** 3 shadcn primitives (auto via CLI), FileDropZone.tsx, Ingest.tsx, Financial.tsx, FinancialPulseCard.tsx, FinancialSummaryCard.tsx
- **Modified:** `App.tsx`, `Layout.tsx`, `Dashboard.tsx`, `lib/api.ts`, `lib/types.ts`, `packages/core-api/src/schemas/capture.ts`, `routes/captures.ts`, `package.json`/`pnpm-lock.yaml`

### Test plan

- [ ] Component tests for FileDropZone (onFiles called, size guard, type guard).
- [ ] Integration test for Ingest page: mocked upload API, verify progress + result flow.
- [ ] Manual verification: drop each of the 9 existing CSVs, verify correct routing + capture creation.
- [ ] Manual verification: Dashboard pulse card shows current spend aggregate matching a query against the DB.

### Rollback

Revert PR — routes removed, dashboard card unmounts. Ingest + Financial pages disappear from nav. Backend endpoints remain; uploads via curl still work.

---

## CS4b — Dashboard Wave 2

**Branch:** `feature/dashboard-wave-2` (may split into multiple PRs at author discretion)
**PR title(s):** `Dashboard Wave 2: email compose + autonomy + settings rework`, `Dashboard Wave 2 cont'd: Investments page` (separate PR since data-gated)
**Est wall-clock:** 6 hours (Investments page adds ~2 more)
**Est diff:** +1350 / −400 LOC

### Intent
Surface the three remaining new capabilities: outbound email (Himalaya), autonomy control (proactive-features gate), and Schwab allocation/net-worth. Plus restructure the flat Settings page into a sectioned accordion.

### Work items — Group 1 (can ship without waiting for snapshots)

- [ ] **CS4b.1** Run `npx shadcn@latest add accordion dropdown-menu sheet` — more primitives for Settings accordion + Compose drawer.
- [ ] **CS4b.2** `packages/web/src/pages/Email.tsx` extension + `components/EmailComposeDrawer.tsx` + `components/EmailDraftsList.tsx`:
  - Current Email.tsx shows classified inbox; add a "Compose" button (opens Sheet) + a "Drafts" tab.
  - Compose Sheet: To/Cc/Subject/Body textarea. "LLM-assist" button calls existing `email-compose` skill to fill body based on a short prompt. "Save as draft" → POST `/api/v1/email/drafts`. "Send" → POST `/drafts/:id/send`.
  - Drafts tab: list from `/drafts?status=<x>`, click to reopen in Sheet.
  - ~500 LOC.
- [ ] **CS4b.3** `components/settings/AutonomyCard.tsx`:
  - Segmented control (shadcn or custom with Button variants): observe / assist / advise / partner.
  - Description string per level + warning banner ("moving to `advise` lets Open Brain act on Slack threads without asking") when moving up.
  - Reads/writes existing `/api/v1/settings/autonomy_level`.
  - ~140 LOC.
- [ ] **CS4b.4** `packages/web/src/pages/Settings.tsx` rework (W2.4):
  - Collapse flat list into accordion sections: General / AI Routing / Voice / Email / Integrations / Autonomy.
  - Each section is a shadcn AccordionItem; existing settings move into appropriate ones. No behavior change, pure reorganization.
  - ~300 LOC (most is moving existing JSX into new scaffolding).

### Work items — Group 2 (data-gated, ship after ≥1 week of snapshots)

- [ ] **CS4b.5** `packages/web/src/pages/Investments.tsx` + route + `components/AllocationDonut.tsx` + `components/NetWorthChart.tsx`:
  - Add a minimal charting dep (`recharts` or similar — pick one, pin version). Alternatively: hand-rolled SVG for both if we want to keep deps minimal.
  - Account picker at top (segmented: Contributory / Simple IRA / Designated Bene Joint).
  - Allocation donut: reads latest `schwab_position_snapshot` captures, groups holdings by `asset_type`, renders donut sectors.
  - Net worth line chart: reads `schwab_balance_snapshot` captures over time, plots `account_value` per account.
  - Holdings table: per-holding symbol / qty / mkt_val / cost_basis / gain_dollar / gain_pct / asset_type.
  - Empty-state UX: "Drop a Schwab Balances or Positions CSV in Ingest to populate this page."
  - ~400 LOC.
- [ ] **CS4b.6** `packages/web/src/lib/api.ts` — extend `capturesApi` or add `investmentsApi` for convenience queries (latest snapshot per account).

### Acceptance criteria

- Compose drawer sends a test email via Himalaya → verifies in Gmail received.
- Approve+Send flow respects existing EmailDraftService logic.
- Autonomy segmented control round-trips through `/api/v1/settings/autonomy_level`.
- Settings accordion renders all prior sections; no regression in save/load.
- Investments page renders with ≥2 snapshots; empty-state when none.
- `pnpm --filter @open-brain/web lint` + `test` green.
- LAB_NOTEBOOK Entry 075 (Group 1) + Entry 076 (Group 2) cover verification.

### File changes

- **New:** 3 shadcn primitives, EmailComposeDrawer, EmailDraftsList, AutonomyCard, AllocationDonut, NetWorthChart, Investments.tsx + route, settings/ sub-components
- **Modified:** Email.tsx, Settings.tsx (full rework), App.tsx, Layout.tsx

### Test plan

- [ ] Unit tests for AutonomyCard state transitions.
- [ ] Integration test: create draft → approve → send → verify EmailDraftService.send called.
- [ ] Manual: flip autonomy through all 4 levels + back to observe. Verify app_settings row updates.
- [ ] Manual: Investments page with ≥2 snapshots shows allocation donut + net worth line.

### Rollback

Revert PR — UI removed; Email routes + Settings endpoints unchanged (backend stable). Data-gated Investments page can ship as its own PR later if Group 1 ships first.

---

## CS5 — Safe decommission

**Branch:** `chore/decommission-safe-subset`
**PR title:** `chore: decommission safe subset — stale branches, seed script, old DB row, LITELLM_* config cruft`
**Est wall-clock:** 60 min (incl. backup + verification)
**Est diff:** +10 / −45 LOC in code + 1 DB row DELETE + 3 git branch deletes

### Intent
Five independent small acts that reduce clutter without touching hot paths. Each is independently reversible within the 90-day GitHub ref retention + JSON-backup window for the DB row.

### Work items

- [ ] **CS5.1** Backup the DB row before delete:
  ```bash
  ssh homeserver 'sudo docker exec open-brain-postgres psql -U openbrain -d openbrain -tAc "SELECT value FROM app_settings WHERE key='\''ms_token_cache'\'';"' \
    > /tmp/ms_token_cache_backup_20260417.json
  ```
  Copy to a durable location (homeserver `/mnt/user/backup/openbrain/adhoc/`).
- [ ] **CS5.2** Delete the row:
  ```sql
  DELETE FROM app_settings WHERE key = 'ms_token_cache';
  ```
  Single row. `ms_token_cache_node` (the live one) untouched.
- [ ] **CS5.3** Delete `scripts/seed_email_auth.py` — confirmed untracked locally. Remove from laptop. No git change needed (not tracked).
- [ ] **CS5.4** `.env.example` — remove `LITELLM_URL=https://llm.k4jda.net` and `LITELLM_API_KEY=get-from-bitwarden`; replace with `OPENAI_API_KEY=get-from-bitwarden` + `OPENAI_BASE_URL=https://api.openai.com/v1`.
- [ ] **CS5.5** `deploy/.env.secrets.template` — remove stale `LITELLM_API_KEY=` line (verify via grep first). Keep SMTP_* lines (nodemailer fallback is intentional, per Entry 066).
- [ ] **CS5.6** `scripts/monthly-maintenance.sh:161` — `.services.litellm.status` → `.services.llm.status` (D22 rename, already in effect in code).
- [ ] **CS5.7** `CLAUDE.md:193` — "passed via `LITELLM_API_KEY` env var" → "passed via `OPENAI_API_KEY` env var" (A63 reality).
- [ ] **CS5.8** Git branch deletes (requires Troy confirmation before push):
  ```bash
  git push origin --delete feature/phases-0b-1a-0d phase-3/ops-observability-wiki claude/review-second-brain-starter-CvHPf
  ```
  Pre-check: `gh pr list --state all --search 'head:<branch>'` for each — if any have open/merged PRs, reference them in the comment and defer the delete. As of 2026-04-17: all 3 are stale with no associated open PRs.
- [ ] **CS5.9** Memory housekeeping — `memory/MEMORY.md` grep for `ms_token_cache` (without `_node`); if stale references exist, update.

### Acceptance criteria

- Backup file `ms_token_cache_backup_20260417.json` exists in `/mnt/user/backup/openbrain/adhoc/`.
- `ms_token_cache` row absent from `app_settings`; `ms_token_cache_node` present.
- `scripts/seed_email_auth.py` absent from laptop.
- `.env.example`, `deploy/.env.secrets.template`, `scripts/monthly-maintenance.sh`, `CLAUDE.md` all have no `LITELLM_URL` or `LITELLM_API_KEY` references in active roles (historical text in CHANGELOG may remain).
- 3 stale branches absent from `git ls-remote --heads origin`.
- `pnpm -r lint` unaffected (no TS changes).
- LAB_NOTEBOOK Entry 077 covers each act + its rollback path.

### File changes

- **Modified:** `.env.example`, `deploy/.env.secrets.template`, `scripts/monthly-maintenance.sh`, `CLAUDE.md`, possibly `memory/MEMORY.md`
- **Deleted (not git-tracked):** `scripts/seed_email_auth.py` (laptop + VM if present)
- **Deleted (git refs):** 3 remote branches
- **Deleted (DB):** 1 row in `app_settings`

### Test plan

- [ ] After row delete: run email-classify manually on homeserver → confirms silent auth still works (uses `ms_token_cache_node`).
- [ ] After config edits: `diff .env.example` shows only intended changes.
- [ ] After branch deletes: `git fetch --prune && git branch -r` shows only `origin/main`.

### Rollback

- Row: re-insert via `psql -c "INSERT INTO app_settings (key, value, updated_at) VALUES ('ms_token_cache', '$(cat backup.json)', now());"`.
- Branches: `gh api repos/davistroy/open-brain/git/refs --method POST -f ref=refs/heads/<name> -f sha=<sha-from-reflog>` (GitHub keeps refs for 90 days).
- Config files: `git revert`.
- `seed_email_auth.py`: restore from git reflog on laptop if ever tracked (confirmed not tracked; restore from local shell history if needed).

---

## Risk register (consolidated)

| Risk | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Shared sidecar image install of `electric-usage-downloader` Go binary fails for aarch64 (if homeserver moves to arm later) | CS2 | Low | Medium | Explicit `ARG ARCH` + conditional release URL per arch; today it's x86_64-only |
| Multipart streaming hits 1.5GB RSS on a large upload | CS3 | Low | High | Use Hono's streaming body + Node `pipeline()` — tested with a 100MB file before merging |
| Migration 0021 collides with an unapplied earlier migration | CS3 | Low | High | Check `pnpm --filter @open-brain/shared drizzle-kit status` on homeserver before running — should be clean since 0020 applied 2026-04-16 |
| Sidecar trigger_server.py concurrency bug (two jobs run in parallel) | CS3 | Medium | Medium | Flock on `/tmp/process.lock` — second request gets 409 until first completes |
| YAML route table drift between TS and Python | CS3 | Low | Medium | CI test loads both implementations against a fixture of filenames, asserts same resolution |
| Branch deletion removes in-progress work | CS5 | Low | Medium | Pre-check via `gh pr list --search head:<branch>`; 90-day GitHub ref retention |
| DB DELETE of `ms_token_cache` breaks a forgotten code path | CS5 | Very low | Medium | Deployed bundles have grep-count 0 for the old key; backup row first |
| Wave 2 Investments page ships empty state for a week | CS4b | Certain | Low | Design empty state as first-class UX with a CTA to upload a CSV |
| Host cron on Unraid doesn't persist across reboots | CS2 | Low | High | Persist via `/boot/config/go` (same pattern as sudoers) |
| 4-site refactor breaks VM cron silently | CS1 | Low | Medium | VM cron runs once a day; if it fails after CS1 deploy, log surfaces on next morning. Worst case: roll back. |

---

## Dependencies + parallelization matrix

| Can run in parallel | Why |
|---|---|
| CS1 + CS5 | Different files; both small; no shared state |
| CS1 + CS2 | CS2 imports from `scripts/lib/capture_api.py` which CS2 CREATES, and CS1 retains its in-file copy; no conflict if CS2 lands first. Alternatively CS1 → CS2 sequentially and CS2.2 wires the extraction |
| CS5 + CS2 | Independent |

| Must be sequential | Why |
|---|---|
| CS3 after CS2 | CS3.7 modifies `docker/ingest-sidecar/Dockerfile` which CS2 renamed; rebase conflict if reversed |
| CS4a after CS3 | Hard dep: Upload endpoints + API client + SSE channel |
| CS4b after CS4a | Soft dep: shadcn primitives added in CS4a; Investments page builds on CS4a's Financial page patterns |
| CS4b-Group2 after ≥2 Schwab snapshots in DB | Data gate: charts need real data to look right |

---

## Verification checkpoints (stop + test gates)

After each phase's deploy:

1. **CS1 (laptop + homeserver):** Drop `Contributory-Positions-*.csv` + `XXXX1252_Balances_*.CSV` into inbox, run `--process-inbox`, verify 2 new captures with `source_metadata.type` in the new set.
2. **CS2 (homeserver):** `docker exec utility-ingest --status` clean; `--gas` returns live billing; host cron has 3 new lines; financial-ingest still healthy.
3. **CS3 (homeserver):** `curl -F file=@activity.csv -F source_type=financial https://brain.troy-davis.com/api/v1/ingest/upload` (through Cloudflare Access with a service token OR internal URL) → returns 201 with upload_id → poll `/api/v1/ingest/uploads?limit=1` until status=parsed → verify capture_ids populated.
4. **CS4a (browser):** Navigate to `/ingest`, drop a CSV, watch progress, verify result pill. Navigate to `/financial`, verify 6 tabs populate. Dashboard shows the pulse card.
5. **CS4b Group 1 (browser):** Compose + send test email → arrives at troy.e.davis@gmail.com. Flip autonomy observe → assist → observe; verify DB row updates.
6. **CS4b Group 2 (browser, after data accumulates):** Investments page renders allocation + net worth chart.
7. **CS5 (psql + shell):** `app_settings` has only `ms_token_cache_node`; `origin` has only `main`; grep for stale LITELLM_URL returns empty.

---

## Scope boundaries

### IN scope (this plan)

- All items in CS1–CS5 above
- GitHub closures: #65 (G-C.2), #70 (dashboard polish → delivered via Wave 1+2), #87 (direct-POST tech debt)
- LAB_NOTEBOOK entries per phase (Rule 11 precondition)
- Host cron setup on Unraid for both sidecars (CS2.11)
- Shared `scripts/lib/capture_api.py` helper to prevent future drift
- Shared `config/ingest-routes.yaml` to prevent TS/Python router drift

### OUT of scope (flagged for follow-up issues)

- Wave 3 dashboard items (association graph / ingest timeline / utility dashboard / search spreading chips / capture file preview / autonomy dry-run preview) — LAB_NOTEBOOK Entry 070 captures these; convert to issues when ready to tackle
- `client: 'litellm'` type-union rename to `openai_compat` — ~30-file refactor
- VM decommission (G-B.5) — still parity-gated on tomorrow's 5 AM cron
- Bond OpenClaw morning-brief disable (G-B.3) — gated on ≥2 OB briefs
- VM Python email cron disable (G-B.2) — gated on G-B.1 7-day parity
- Cobb Water B2C OIDC — separate 40+ hr backlog
- Mobile-responsive dashboard polish
- Plaid live-sync + threshold alerting (remains on #62)
- Wiki page improvements
- pytest formalization for Python scripts (smoke tests cover it for now)

### Known technical debt accepted (not fixed in this plan)

- `client: 'litellm'` persists as logical identifier in `ai-routing.yaml` + `config.ts`
- `cmd_sync` / `cmd_balances` / `cmd_investments` / `cmd_monthly_report` keep their inline content-building (CS1 fixes the envelope only; the long inline request-building blocks stay)
- Sidecar `claude --print` fallthrough is best-effort — captures without T2 synthesis still land, and OB's own weekly-brief skill picks them up

---

## Follow-up work (post-this-plan)

After this plan ships:
- Convert Wave 3 task-list items into individual GitHub issues for kanban tracking
- Parity-gated decommissions (G-B.2/3/5) can proceed once their validation windows complete — each is its own small PR
- If the sidecar trigger_server.py proves heavy, migrate to Redis pub/sub (deferred until it shows stress)
- If upload traffic grows, evaluate `config/ingest-routes.yaml` → code-gen for the TS router (compile-time safety over runtime YAML parse)

---

## File inventory (by change set)

Line counts are estimates; actual may vary ±20%.

| Path | CS | Action | Est LOC |
|---|---|---|---|
| `scripts/financial-pipeline.py` | CS1 + CS2 | Modified (refactor + Schwab parsers + helper extraction) | ~+250 / −120 |
| `scripts/utility-pipeline.py` | CS2 | Modified (three fixes + helper import) | ~+80 / −40 |
| `scripts/lib/capture_api.py` | CS2 | New | ~50 |
| `scripts/lib/__init__.py` | CS2 | New | 1 |
| `scripts/lib/ingest_router.py` | CS3 | New | ~70 |
| `config/ingest-routes.yaml` | CS2 (stub) + CS3 (consumed) | New | ~40 |
| `docker/ingest-sidecar/Dockerfile` | CS2 + CS3 | Renamed + electric-usage-downloader + trigger_server CMD | ~+30 / −10 |
| `docker/ingest-sidecar/trigger_server.py` | CS3 | New | ~120 |
| `docker-compose.yml` | CS2 | Added utility-ingest service | ~+35 |
| `.dockerignore` | CS2 | Added lib/ negation | ~+2 |
| `packages/shared/drizzle/0021_file_uploads.sql` | CS3 | New migration | ~30 |
| `packages/shared/src/schema/supporting.ts` | CS3 | Added file_uploads table | ~+40 |
| `packages/core-api/src/routes/ingest.ts` | CS3 | New | ~200 |
| `packages/core-api/src/schemas/ingest.ts` | CS3 | New | ~40 |
| `packages/core-api/src/services/ingest-router.ts` | CS3 | New | ~80 |
| `packages/core-api/src/services/sse.ts` | CS3 | Extended | ~+20 |
| `packages/core-api/src/index.ts` | CS3 | Route registration | ~+5 |
| `packages/core-api/src/schemas/capture.ts` | CS4a | Added source_provider filter | ~+2 |
| `packages/core-api/src/routes/captures.ts` | CS4a | SQL WHERE extension | ~+5 |
| `packages/workers/src/jobs/ingest-process.ts` | CS3 | New | ~120 |
| `packages/web/src/pages/Ingest.tsx` | CS4a | New | ~380 |
| `packages/web/src/pages/Financial.tsx` | CS4a | New | ~350 |
| `packages/web/src/pages/Investments.tsx` | CS4b | New | ~400 |
| `packages/web/src/pages/Email.tsx` | CS4b | Extended | ~+250 / −50 |
| `packages/web/src/pages/Settings.tsx` | CS4b | Reworked into accordion | ~+200 / −250 |
| `packages/web/src/components/FileDropZone.tsx` | CS4a | New | ~180 |
| `packages/web/src/components/FinancialPulseCard.tsx` | CS4a | New | ~150 |
| `packages/web/src/components/FinancialSummaryCard.tsx` | CS4a | New | ~100 |
| `packages/web/src/components/EmailComposeDrawer.tsx` | CS4b | New | ~250 |
| `packages/web/src/components/EmailDraftsList.tsx` | CS4b | New | ~180 |
| `packages/web/src/components/AutonomyCard.tsx` | CS4b | New | ~140 |
| `packages/web/src/components/AllocationDonut.tsx` | CS4b | New | ~140 |
| `packages/web/src/components/NetWorthChart.tsx` | CS4b | New | ~120 |
| `packages/web/src/components/ui/*` | CS4a + CS4b | shadcn CLI additions | ~800 (auto-generated) |
| `packages/web/src/lib/api.ts` | CS3 + CS4a + CS4b | Extended with ingestApi + filters | ~+120 |
| `packages/web/src/lib/types.ts` | CS4a | source_provider discriminated union | ~+40 |
| `packages/web/src/App.tsx` | CS4a + CS4b | New routes | ~+8 |
| `packages/web/src/components/Layout.tsx` | CS4a | Nav items | ~+10 |
| `packages/web/src/pages/Dashboard.tsx` | CS4a | Slot pulse card | ~+10 |
| `.env.example` | CS5 | LITELLM → OPENAI | ~+3 / −3 |
| `deploy/.env.secrets.template` | CS5 | Remove stale LITELLM_API_KEY | ~−1 |
| `scripts/monthly-maintenance.sh` | CS5 | jq path rename | ~1 |
| `CLAUDE.md` | CS5 | Env var comment correction | ~1 |
| **TOTAL** | — | — | **~+4,500 / −475** |

---

## Next step

Run `/implement-plan --input IMPLEMENT_WAVES_2026-04-17.md` to begin execution, OR cut CS1 branch manually and work through the phases independently. Each phase's work items are checklist-ready. LAB_NOTEBOOK entries 071–077 should be created as each phase begins (Rule 1 precondition).
