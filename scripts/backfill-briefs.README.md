# backfill-briefs — One-Time Migration Script

Reads all historical `skills_log` rows for the four brief-producing skills
(`weekly-brief`, `daily-sweep-skill`, `morning-brief`, `monthly-reflection`)
and inserts corresponding rows into the `briefs` table.

**Prerequisite:** migration 0030 must be applied before running this script.
The `briefs` table and its unique partial index on `source_skill_log_id` must exist.

---

## Running on the homeserver

SSH into the homeserver and change to the deploy directory:

```sh
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain
```

### 1. Dry-run first (default — no writes)

```sh
NODE_OPTIONS="--max-old-space-size=4096" pnpm tsx scripts/backfill-briefs.ts --dry-run
```

This prints a per-skill count table showing how many rows would be inserted.
No data is written. Review the output before proceeding.

### 2. Apply (writes to briefs table)

```sh
NODE_OPTIONS="--max-old-space-size=4096" pnpm tsx scripts/backfill-briefs.ts --apply
```

The `DATABASE_URL` env var is read from the `.env` / `.env.secrets` files
already sourced by the shell when you `cd` into the deploy directory.
If not set, the script falls back to `PGURL`, then to the default local URL
`postgres://openbrain:openbrain@localhost:5432/openbrain`.

To override explicitly:

```sh
DATABASE_URL=postgres://openbrain:<password>@localhost:5432/openbrain \
  NODE_OPTIONS="--max-old-space-size=4096" \
  pnpm tsx scripts/backfill-briefs.ts --apply
```

---

## Idempotency

The script is safe to re-run. It checks which `skills_log` IDs already have
a `briefs` row (via `source_skill_log_id`) and skips them. Any subsequent run
after a partial apply will only insert the remaining rows.

The DB-level guard is the unique partial index on `briefs.source_skill_log_id`
(migration 0030) — duplicate inserts are silently ignored via
`ON CONFLICT DO NOTHING`.

---

## Content degradation order

For each `skills_log` row the script attempts to build `body_html` in this order:

1. **Structured result JSONB** — parses the skill's output object and renders
   Markdown via the unified `renderBriefHtml()` pipeline (same renderer used
   by the live skill).
2. **`output_summary` text** — if result JSONB is missing or unstructured,
   wraps the plain-text summary in `<p>` tags.
3. **Placeholder** — if both are empty, inserts a minimal
   `<p><em>No content available…</em></p>` placeholder.

Rows that produce errors (e.g., corrupted JSONB) are logged and skipped;
the script never aborts early.

---

## Output example

```
=== Backfill Summary (DRY-RUN) ===
Skill                   Total   Skip(exist)  ToInsert  Errors
-----------------------------------------------------------------
weekly-brief            12      0            12        0
daily-sweep-skill       30      0            30        0
morning-brief           0       0            0         0
monthly-reflection      2       0            2         0

DRY-RUN complete. 44 row(s) would be inserted.
Re-run with --apply to write to the database.
```
