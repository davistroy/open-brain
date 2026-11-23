# Alert escalation and acknowledgement

Governing decision: `docs/adr/ADR-0005-alert-state-model.md`. Code: `packages/workers/src/lib/alert-state.ts` (`nextAction`, `raiseAlert`).

## The three alert classes

| Class | Examples | Behaviour |
|---|---|---|
| `critical` | backup stale, budget hard limit | Pushover priority 1 on the first message, then escalates while the condition stays open. |
| `warning` | failed or backlogged queues, no captures in 6 h, budget soft limit | Pushover priority 0 once. Never escalates, however long it stays open. |
| info | drift, wiki lint, email summary | Not an alert. Goes in the daily digest (items 2.4 and 2.5). |

Every alert sends once when the condition turns bad, and sends a priority -1 "Resolved: ..." when it clears. It sends nothing while the condition holds, except for the escalation below.

## Escalation timeline (critical only)

Escalation runs when the owning skill next calls `raiseAlert` (`pipeline-health` every 6 h, `budget-check` daily). No separate job exists, so the real timing is the owner's cadence: a step fires on the first run after its threshold.

| Time open | Action | What is sent |
|---|---|---|
| 0 | `notify` | Pushover priority 1. |
| 24 h | `escalate_24h` | Pushover priority 2 (`retry=600`, `expire=10800`: repeats every 10 minutes for 3 hours or until acknowledged) and a Slack message to `MORNING_BRIEF_SLACK_CHANNEL`. |
| 7 d | `escalate_7d` | An email to `WEEKLY_BRIEF_EMAIL` through Himalaya, and a priority-2 Pushover. |
| after 7 d | `repeat_p2` | One priority-2 Pushover per 24 h while the alert is open and unacknowledged. |

The stored `level` (0, 1, 2) records the highest step sent, so each step fires once. If the Pushover send of a step fails, the level does not advance and the next run retries the whole step. Slack and email run only after a successful Pushover send, and their failures are logged at warn and never block it.

## Acknowledging

Tap Acknowledge on the priority-2 Pushover notification. On its next run the owning skill polls the stored receipt, writes `acked_at`, and escalation is silent for 7 days from the acknowledgement. The daily digest keeps listing the alert while it is open. After the 7 days the escalation resumes: `escalate_7d` if level 2 was not yet reached, otherwise `repeat_p2` once the last send is a day old. A new priority-2 message carries a new receipt and clears `acked_at`.

Acknowledging does not close the alert. Only the condition clearing does (the "Resolved" message).

## The two switches

Both are literal values in the `workers` `environment:` block of `docker-compose.yml` (`ALERT_STATE_ENABLED: "true"`, `ALERT_LEGACY_PUSH: "true"`); the code also treats an unset switch as on. Do not set them in `.env`: `.env` only feeds compose interpolation and is never injected into the container (A145), so a value there does nothing.

- `ALERT_STATE_ENABLED=false`: `raiseAlert` does nothing (no read, no write, no send) and the legacy direct pushes run as before. This is the rollback.
- `ALERT_LEGACY_PUSH=false`: the legacy direct pushes stop and only `raiseAlert` sends. Set it one week after the first deploy (item 5.5). Ignored while `ALERT_STATE_ENABLED=false`.

## Inspecting and rolling back

- Read a state: `SELECT value FROM app_settings WHERE key = 'alert_state:backup-stale';`
- Force a re-notify: delete the row. The next run treats the alert as new and sends once.
- Force an early or repeated escalation test: set `value` `since` to a time more than 24 h ago and `level` to 0.
- Missing Slack message: check `SLACK_BOT_TOKEN` and `MORNING_BRIEF_SLACK_CHANNEL` in the `workers` container. Missing email: check `HIMALAYA_CONFIG` and `WEEKLY_BRIEF_EMAIL`. Each logs `escalation skipped` at warn.
- Roll back: on the host, edit `/mnt/user/appdata/open-brain/docker-compose.yml` and change the workers line to `ALERT_STATE_ENABLED: "false"`, then recreate only `workers`: `sudo -n docker compose up -d --force-recreate --no-deps workers`. Verify with `docker exec open-brain-workers printenv ALERT_STATE_ENABLED` (expect `false`). A later `git checkout origin/main -- docker-compose.yml` restores `"true"`, so re-apply the edit after any compose sync. State rows stay in `app_settings`, unused; the daily digest and the morning-brief footer stop listing them while the switch is off.
- Stop the legacy pushes (item 5.5): the same edit with `ALERT_LEGACY_PUSH: "false"` and the same recreate.
