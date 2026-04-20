# IMPLEMENT_PHASE-P21 — Financial Advisor Newsletter Assessment (#66)

**Phase:** P21  
**Wave:** 4 (Arc 3 Batch Source Pipelines)  
**PR scope:** New Python script + config file + cron entry  
**GitHub issue:** #66  
**Generated:** 2026-04-19 (Gate 1 — phase-planner)  
**Prior phases required:** None (Wave 4 is independent of A–D after P02/P03 landed)

---

## Scope Diff vs. PHASED_PLAN.md Card

The P21 card in PHASED_PLAN.md is a 4-bullet sketch. Gate 1 investigation reveals the following clarifications and one scope adjustment:

| Card item | Status |
|-----------|--------|
| "Newsletter ingestion hook (email with known advisor senders triggers pipeline)" | **NEEDS GROUNDING** — email-pipeline.py classifies newsletters into the `Newsletters & Marketing` category but does NOT currently fetch full body text or fire a downstream hook. P21 must read full email bodies via the Graph/Gmail API, not just subject+preview. |
| "Advisor-voice extraction (quoted vs. opinion vs. market data)" | **IN-SCOPE** — T0 section parsing + T2 Claude CLI synthesis for full analysis. |
| "'What changed vs. prior newsletter' diff capture" | **IN-SCOPE** — SQLite stores prior run; diff is computed in Python (T0), surfaced in synthesis prompt. |
| "Action items: specific recommendations with deadlines" | **IN-SCOPE** — structured extraction in synthesis prompt; output capture tagged `observation` / `brain_view: personal`. |
| "Last 5 newsletters processed; operator validates quality" | **ACCEPTANCE CRITERION** — preserved. |

**Scope addition (grounded in existing code):**
- Email body fetching via the Hotmail Graph API already exists in `email-pipeline.py`'s `HotmailBackend`. P21 will reuse that class rather than duplicate the MSAL token flow.
- The `lib/capture_api.py` shared helper is the correct POST path (same pattern as `financial-pipeline.py`).
- All advisor sender rules live in config (`config/financial/newsletter-advisors.yaml` — new file, P21 creates it). This keeps the advisor list out of code and editable without a deploy.

**No scope divergence that requires operator pause.** Proceeding.

---

## Architecture & Cost-Tier Mapping

```
Cron trigger (daily, open-brain-vm)
  │
  ├── T0: Python reads advisor sender list from config YAML
  ├── T0: Graph API / Gmail API → fetch full email body for each matched sender
  ├── T0: Section parser (regex) → extracts market commentary, recommendations, deadlines
  ├── T0: Diff against prior newsletter stored in SQLite (hash + text)
  ├── T2: claude --print → structured synthesis prompt → action summary
  └── POST to /api/v1/captures via lib/capture_api.py
```

**Why T2 and not T3:** Newsletters arrive asynchronously, operator is never actively waiting, synthesis is not real-time. This is precisely the batch/async T2 use case. One `claude --print` call per advisor per new newsletter — not per-email.

**Aggregation rule satisfied:** collect (all newsletters from one advisor since last run) → extract (T0 section parse + diff) → one synthesis call → one capture.

---

## Work Items

### WI-1: Config file — `config/financial/newsletter-advisors.yaml`

**File:** `config/financial/newsletter-advisors.yaml` (new)

Define the advisor sender list and extraction hints. Schema:

```yaml
# Financial advisor newsletter pipeline config — P21
# Each entry: sender domain or exact address -> advisor name + extraction hints
advisors:
  - name: "Example Advisor"
    sender_match: "newsletter@example-advisory.com"   # exact address
    match_type: exact                                  # exact | domain
    brain_view: personal
    capture_type: observation
    action_item_keywords:                             # T0 extraction hints
      - "recommend"
      - "action"
      - "consider"
      - "target"
    section_headers:                                  # T0 section split markers
      - "Market Commentary"
      - "Portfolio Recommendations"
      - "Key Takeaways"

# Pipeline behavior
pipeline:
  dedupe_window_days: 7           # skip newsletter if same sender seen < 7 days ago
  max_body_chars: 20000           # truncate before T2 prompt
  synthesis_timeout_sec: 180
  capture_api:
    caller_header: "newsletter-pipeline"
```

**Acceptance:** YAML loads without error; at least one real advisor entry present (operator fills in during rollout).

---

### WI-2: SQLite tracking DB init — `~/.newsletter-pipeline/pipeline.db`

**File:** `scripts/newsletter-pipeline.py` — `init_db()` function

Tables needed:
```sql
CREATE TABLE IF NOT EXISTS processed_newsletters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    advisor_name TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,          -- 'hotmail' | 'gmail'
    subject TEXT,
    received_at TEXT,
    body_hash TEXT,                  -- SHA-256 of full body text
    body_preview TEXT,               -- first 500 chars, for diff display
    synthesis_posted INTEGER DEFAULT 0,
    capture_id TEXT,                 -- UUID from core-api response if available
    processed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pn_advisor ON processed_newsletters(advisor_name, received_at);
CREATE INDEX IF NOT EXISTS idx_pn_msg ON processed_newsletters(message_id);
```

**Acceptance:** `init_db()` is idempotent (safe to re-run).

---

### WI-3: Email fetch — full body retrieval from Hotmail/Gmail

**File:** `scripts/newsletter-pipeline.py` — `fetch_newsletters()` function

**Implementation notes:**
- Reuse `HotmailBackend` from `email-pipeline.py` by importing it (both scripts in `scripts/`). Do NOT duplicate MSAL auth logic.
  - Import pattern: `from email_pipeline import HotmailBackend`  (Python converts hyphen in filename; use `importlib` if needed — see note below)
  - **Filename import note:** `email-pipeline.py` has a hyphen; Python cannot import it with a plain `import` statement. Use `importlib.util.spec_from_file_location("email_pipeline", Path(__file__).parent / "email-pipeline.py")` — same pattern as any hyphenated script in the project.
- Graph API body endpoint: `GET /me/messages/{id}?$select=body,subject,from,receivedDateTime` — `body.content` field contains HTML. Strip tags with `re.sub(r'<[^>]+>', ' ', html)` to get plain text (T0, no external lib needed since newsletters are simple HTML).
- Gmail equivalent: use existing gmail auth token cache from email-pipeline if present; fall back to `--setup` flow.
- Fetch window: last N days where N = `pipeline.dedupe_window_days` from config (default 7), OR since last processed message for that advisor (whichever is shorter).
- Filter: sender matches any `sender_match` in the advisors list.
- Body size cap: truncate to `max_body_chars` before storing or passing to T2.

**Acceptance:** `--fetch-only` dry-run mode prints matched messages and body char counts without posting.

---

### WI-4: T0 Section parsing and diff computation

**File:** `scripts/newsletter-pipeline.py` — `parse_newsletter()` and `compute_diff()` functions

`parse_newsletter(body_text, advisor_config) -> dict`:
- Split on `section_headers` patterns (case-insensitive regex).
- Extract action item sentences: lines containing `action_item_keywords` (word-boundary match).
- Return: `{ sections: {header: text}, action_items: [str], word_count: int }`.

`compute_diff(current_body_hash, current_preview, conn, advisor_name) -> str`:
- Query `processed_newsletters` for most recent prior row matching `advisor_name`.
- If no prior: return `"First newsletter from this advisor."`.
- If body hash matches prior: return `"Duplicate — body unchanged."` → skip synthesis, skip posting.
- Otherwise: compare `body_preview` strings and return a one-paragraph diff note (length delta, new sections detected by regex).

**Acceptance:** Unit-testable pure functions; `compute_diff` returns dedup sentinel on matching hash.

---

### WI-5: T2 synthesis via `claude --print`

**File:** `scripts/newsletter-pipeline.py` — `synthesize_newsletter()` function

```python
def synthesize_newsletter(advisor_name, subject, body_text, parsed, diff_note, cfg) -> str | None:
    prompt = build_synthesis_prompt(advisor_name, subject, body_text, parsed, diff_note)
    try:
        result = subprocess.run(
            ["claude", "--print", "-p", prompt],
            capture_output=True, text=True,
            timeout=cfg["pipeline"]["synthesis_timeout_sec"],
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        log.warning(f"Claude CLI returned {result.returncode}: {result.stderr[:200]}")
    except subprocess.TimeoutExpired:
        log.warning("Claude CLI timed out — posting raw extraction without synthesis")
    except FileNotFoundError:
        log.warning("Claude CLI not found — posting raw extraction without synthesis")
    return None
```

`build_synthesis_prompt()` includes:
- Advisor name, newsletter subject, date
- Section extracts (capped at `max_body_chars`)
- T0-extracted action items
- Diff note vs. prior newsletter
- Instructions: "Extract 3–7 specific actionable recommendations with any stated deadlines. Note what changed since the prior newsletter. Flag any market views that differ from prior positions. Output structured markdown: ## What's New, ## Action Items, ## Market Views, ## Changed Positions."

Fallback (Claude CLI absent): post raw T0 extraction only.

**Acceptance:** Synthesis prompt is under 6,000 chars after truncation; fallback path posts raw extraction without crashing.

---

### WI-6: POST capture to core-api

**File:** `scripts/newsletter-pipeline.py` — `post_newsletter_capture()` function

Reuse `lib/capture_api.py`'s `post_capture()` exactly as `financial-pipeline.py` does it.

Capture content format:
```
[Newsletter] {advisor_name} — {subject} ({date})

{synthesis or raw_extraction}

---
Source: {provider} | {word_count} words | Changes: {diff_summary}
Action items extracted: {len(action_items)}
```

`source_metadata` envelope:
```json
{
  "type": "newsletter_assessment",
  "advisor_name": "...",
  "subject": "...",
  "received_at": "...",
  "provider": "hotmail|gmail",
  "word_count": 1234,
  "action_item_count": 5,
  "has_synthesis": true,
  "diff_from_prior": "summary string"
}
```

`brain_view`: from advisor config (default `personal`).  
`capture_type`: `observation`.  
`X-Open-Brain-Caller`: `newsletter-pipeline` (must be added to `BYPASS_CALLERS` in `rate-limit.ts`).

**Acceptance:** Successful POST returns `True`; SQLite row updated with `synthesis_posted=1`.

---

### WI-7: Rate-limit bypass registration

**File:** `packages/core-api/src/middleware/rate-limit.ts`

Add `'newsletter-pipeline'` to `BYPASS_CALLERS` Set. This follows the lockstep rule from CLAUDE.md: every internal caller sets the header AND gets a bypass entry. Even though this is a batch script (not a worker), it runs on open-brain-vm and POSTs via the internal capture API path.

**Acceptance:** `BYPASS_CALLERS` contains `'newsletter-pipeline'`; existing tests still pass.

---

### WI-8: CLI entrypoint and cron wiring

**File:** `scripts/newsletter-pipeline.py` — `main()` via `argparse`

```
python newsletter-pipeline.py --run              # fetch + parse + synthesize + post (normal cron run)
python newsletter-pipeline.py --setup            # interactive auth (first-time Graph/Gmail)
python newsletter-pipeline.py --fetch-only       # dry-run: print matched newsletters, no post
python newsletter-pipeline.py --status           # show DB stats: advisors, last run, post count
python newsletter-pipeline.py --reprocess N      # reprocess last N newsletters (re-synthesize, re-post)
```

Cron entry (open-brain-vm, `~/.crontab` or `/etc/cron.d/`):
```
0 8 * * * cd ~/open-brain && venv/bin/python scripts/newsletter-pipeline.py --run >> ~/logs/newsletter-pipeline.log 2>&1
```

Slot: `0 8 * * *` (08:00 daily). Verify no collision with existing cron slots. Current weekday morning cluster runs 06:00–07:15 per CLAUDE.md. 08:00 is after the cluster; safe. Not in the scheduler.ts BullMQ cron registry (this is a VM-side cron, not a workers cron).

**Acceptance:** `--status` exits 0; `--run` with no matching newsletters exits 0 without error.

---

### WI-9: Tests

**File:** `docker/ingest-sidecar/tests/test_newsletter_pipeline.py` OR `scripts/tests/test_newsletter_pipeline.py`

Pattern: follow `docker/ingest-sidecar/tests/` convention (pytest, fixtures, no live API calls).

Test cases:
1. `test_init_db_idempotent`: call `init_db()` twice, assert no exception and table exists.
2. `test_parse_newsletter_extracts_action_items`: fixture body with known keywords, assert action items list non-empty.
3. `test_compute_diff_dedup_on_matching_hash`: insert prior row with same hash, assert dedup sentinel returned.
4. `test_compute_diff_first_newsletter`: empty DB, assert "First newsletter" string returned.
5. `test_post_capture_called_on_new_newsletter`: mock `post_capture` + `subprocess.run`, assert both called on new newsletter.
6. `test_post_capture_skipped_on_dedup`: matching hash in DB, assert `post_capture` NOT called.
7. `test_synthesis_fallback_on_cli_not_found`: `subprocess.run` raises `FileNotFoundError`, assert raw extraction is posted instead.

Minimum: 7 tests. All mocked at API boundary (no live Graph API, no live core-api, no live Claude CLI).

**Acceptance:** `pytest scripts/tests/test_newsletter_pipeline.py` passes; 7+ tests green.

---

## File Manifest

| Action | Path |
|--------|------|
| CREATE | `scripts/newsletter-pipeline.py` |
| CREATE | `config/financial/newsletter-advisors.yaml` |
| CREATE | `scripts/tests/test_newsletter_pipeline.py` (or `docker/ingest-sidecar/tests/`) |
| EDIT | `packages/core-api/src/middleware/rate-limit.ts` — add `newsletter-pipeline` to BYPASS_CALLERS |

**No database migration.** The pipeline uses its own SQLite (`~/.newsletter-pipeline/pipeline.db`), not the Postgres schema. No new BullMQ workers, no `packages/workers` changes, no `scheduler.ts` changes (VM-side cron, not workers cron).

---

## Acceptance Criteria

- [ ] `newsletter-pipeline.py --fetch-only` prints matched messages for at least one configured advisor (requires operator to populate `newsletter-advisors.yaml` with a real sender)
- [ ] `newsletter-pipeline.py --run` posts a capture for each new newsletter; `--status` shows `synthesis_posted=1`
- [ ] SQLite deduplication: running `--run` twice on same day does NOT post duplicate captures
- [ ] Fallback: when `claude` CLI is absent or times out, raw extraction is posted without crashing
- [ ] `newsletter-pipeline` is in `BYPASS_CALLERS` in `rate-limit.ts`; existing rate-limit tests still pass
- [ ] 7+ pytest cases green
- [ ] `--status` exits 0 on fresh install (empty DB)
- [ ] Last 5 newsletters processed from real advisor emails; operator validates extraction quality (manual AC — post-deploy)

---

## Dependencies

- **Runtime (VM):** `requests`, `msal`, `pyyaml` — all already installed in open-brain-vm venv (used by `email-pipeline.py` and `financial-pipeline.py`).
- **No new pip dependencies.** `PyMuPDF` is NOT required — newsletters arrive as email body HTML, not PDFs. If a PDF-attachment variant is needed later, that is a follow-up (not P21 scope).
- **`email-pipeline.py` `HotmailBackend`:** imported via `importlib.util` due to hyphenated filename. Test must mock the import surface cleanly.
- **Core-api rate-limit:** one-line BYPASS_CALLERS addition. No PR gate escalation (not a homeserver migration; no schema change).

---

## Rollback Plan

- Script is additive (`scripts/` only). To disable: comment out or remove the cron entry on open-brain-vm.
- The one TypeScript change (rate-limit.ts BYPASS_CALLERS) is additive and trivially reverted. It does not affect any existing bypass entry.
- SQLite lives in `~/.newsletter-pipeline/` on open-brain-vm. Delete that directory to wipe pipeline state. No Postgres impact.
- git revert the PR; remove cron entry on open-brain-vm.

---

## Effort Estimate

**~1.5–2 days.** Original card said ~2 days; this is consistent given:
- WI-1–2 (config + DB init): ~1 hour
- WI-3 (full body fetch via importlib HotmailBackend reuse): ~2 hours
- WI-4 (T0 parsing + diff): ~2 hours
- WI-5 (T2 synthesis + prompt building): ~2 hours
- WI-6–7 (capture POST + rate-limit): ~1 hour
- WI-8 (CLI + cron): ~1 hour
- WI-9 (tests): ~2 hours

**Key complexity:** the `importlib` import pattern for `email-pipeline.py` is the main gotcha. If it proves brittle during Gate 3, the fallback is to extract `HotmailBackend` into `scripts/lib/hotmail_backend.py` — that's a 30-minute refactor and acceptable in-flight scope expansion (still one PR).

---

## Gate 1 Findings — No Operator Pause Required

- No scope divergence that invalidates card deliverables.
- P21 has no dependencies on P19/P20a/P20b (those are doctor labs; financial newsletter is independent).
- No homeserver migration → Gate 5 auto-merge eligible per ORCHESTRATOR.md matrix.
- No CLAUDE.md / PRD / TDD edits → auto-merge eligible.
- Budget: zero LLM API cost. One `claude --print` call per new newsletter per advisor (T2 CLI, subscription-covered, not API). OpenAI embeddings fire as normal downstream (pipeline picks up the capture).
