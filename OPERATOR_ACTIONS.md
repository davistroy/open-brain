# Operator Actions — Dated Register

> **This is the forcing-function register for post-merge operator actions** (RC-19, arch-review v5).
> It is the authoritative list for *operator/ops* actions that code alone cannot complete — live-host
> deploys, repo-settings changes, secret provisioning, external-account verifications, owner decisions.
> **GitHub issues remain authoritative for feature work**; this file tracks the manual steps that keep
> lapsing because nothing reminds anyone about them.
>
> **How it stays alive:** the monthly `secret-rotation` skill parses this file and Pushover-alerts on
> overdue/approaching items; the `monthly-audit` GitHub workflow renders it into its run summary + Slack
> post. Both fire on the 1st of each month. Keep the table format stable (the skill parses the rows).
>
> **Row format:** `| ID | Action | Due | Owner | Source | Status |`
> **Status values:** `OPEN` · `IN PROGRESS` · `DONE YYYY-MM-DD` · `BLOCKED (reason)`
> **Last reconciled:** 2026-07-12

## Open Actions

| ID | Action | Due | Owner | Source | Status |
|----|--------|-----|-------|--------|--------|
| OA-1 | Deploy migration 0036 to the homeserver (throwaway pgvector container, per deploy.md §4), recreate `workers` (`--no-deps`), then verify prod `retention_audit` for the 2026-07-05 & 2026-07-12 skills_log gaps and clear the ~2 stuck `data-retention-prune` BullMQ failed jobs | 2026-07-19 | Troy | Plan 1.3 / DA-1 / A135 | OPEN |
| OA-2 | Flip repository visibility to **private** (`gh repo edit davistroy/open-brain --visibility private`); confirm GHCR images + CI still resolve afterward | 2026-07-19 | Troy | RC-10 (arch-review v5) | OPEN |
| OA-3 | Close GitHub issue #226 using the prepared evidence in `docs/pending-issue-closures.md` (`gh issue close 226 --comment ...`) — fixed by PR #230 / 1710c54 (attribution nuance: issue said core-api, fix in workers daily-connections) | 2026-07-19 | Troy | Plan 2.4 / #226 | OPEN |
| OA-4 | Provision `BWS_ACCESS_TOKEN` (Bitwarden machine-account access token) by hand into the homeserver `.env.secrets` and recreate `workers`, enabling the monthly secret-rotation staleness check | 2026-07-26 | Troy | Plan 3.1 / RC-13 | OPEN |
| OA-5 | Verify the first *scheduled* offsite-backup (Fri 03:45) and restore-rehearsal (Sun 05:30) runs in homeserver logs / Pushover history; record the result in LAB_NOTEBOOK. Open since 2026-06-11 (~1 month unverified) | 2026-07-19 | Troy | A131 / PLT-H4 / RC-12 | OPEN |
| OA-6 | Voice Bearer phase-2 rollout: create BWS secret `dev/open-brain/voice-capture-secret` (`openssl rand -hex 32`), add the `Authorization: Bearer` header to the iOS Shortcut AND `EXPO_PUBLIC_VOICE_SECRET` to the mobile build **first**, then set `VOICE_CAPTURE_SECRET` in `.env.secrets` and restart voice-capture + core-api. **Clients before server** or all direct captures 401 (runbook: voice-capture-auth.md) | 2026-08-02 | Troy | D132 / SEC-A3 / IA-M2 | OPEN |
| OA-7 | **U3 blocker for Plan 8.2** — verify whether the native mobile app currently passes CF Access on brain.troy-davis.com WITHOUT a CF Access service token. If it works without one → mobile has no auth control today → choose SEC-A2 Option 1 (dedicated api hostname). If CF Access is enforced → Option 2 (delete dead mobile-auth path) is acceptable. Record the finding | 2026-08-09 | Troy | SEC-A2 / U3 (Plan 8.2) | OPEN |
| OA-8 | Promote `Validate init-schema.sql` + `Python lint & typecheck` to required branch-protection checks (`gh api repos/davistroy/open-brain/branches/main/protection`), keeping `enforce_admins=false`/`strict=false`. Confirm 2 consecutive green runs of each first | 2026-08-02 | Troy | Plan 6.6 / QA-4 | OPEN |
| OA-9 | Run the single live-host verification session: (a) confirm A131 backup/rehearsal runs, (b) test `WorkersMetricsAbsent` alert delivery by briefly stopping workers (PLT-H2), (c) deploy the batched compose window (workers backup-mount + BWS token) through the two-gate config-diff procedure | 2026-08-09 | Troy | Plan 7.5 / PLT-H2 / A131 | OPEN |
| OA-10 | Add `shm_size: "512mb"` to the postgres compose service during the next daemon-restart window (needs a postgres recreate — batch it; prevents the `/dev/shm` 64 MB wall on future parallel-index migrations) | next restart window | Troy | DA-11 / CLAUDE.md deferral | OPEN |
| OA-11 | Quarterly vendor-terms verification: confirm OpenAI "no training on API data" and Deepgram "0-day retention" under the CURRENT plan/terms (see docs/PROVIDER_SETTINGS.md placeholders) | 2026-09-30 | Troy | RI-3 / RC | OPEN |
| OA-12 | Gmail OAuth re-consent (token refresh window) for the email-classify pipeline | 2026-07-26 | Troy | operational-followups / RC-13 | OPEN |
| OA-13 | Merge Dependabot PRs #235/#237/#238 (cloudflare/email-worker: postal-mime, @cloudflare/workers-types 4→5) now that `email-worker-test` CI job (npm ci + tsc --noEmit + vitest, verified green locally 16/16) gates the package. Confirm the new job is green on each PR before merging | 2026-07-19 | Troy | Plan 6.5 / QA-7 / SW5-L13 | OPEN |
| OA-14 | Merge the 5 GitHub-Actions major Dependabot PRs (#242 docker/build-push-action 6→7, #241 actions/cache 5→6, #240 setup-python 5→6, #239 pnpm/action-setup 4→6, #236 setup-node 5→6) **one at a time**, watching one post-merge `build-images.yml` run after each. The new `notify-failure` job (Plan 7.1) now Slack-alerts a broken build so a bad major merge can't silently stale `:latest`. #242 touches all 8 build steps — merge it last/most carefully | 2026-07-26 | Troy | Plan 7.1 / PE-M9 | OPEN |

## Completed Actions

| ID | Action | Completed | Source |
|----|--------|-----------|--------|
| — | (none yet — items move here with `DONE YYYY-MM-DD` when finished) | — | — |
