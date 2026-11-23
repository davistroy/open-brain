# ADR-0005: Alerts Carry State — Fire on Change, Digest the Rest, Escalate What Stays Open

**Status:** Proposed
**Date:** 2026-11-22
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` remediation of arch-review v7 — findings SA7-05, PLT-027, PE-013, SE7-11, SA7-10, PLT-020 (change set Phase 2)

---

## Context

Every alert in Open Brain is a Pushover message sent by application code in the `workers` container. Each skill calls `PushoverService` directly on every run. No component records whether a condition was already reported, how severe it is, or whether anyone acknowledged it.

Between 2026-09-07 and 2026-11-22 this produced the following, all verified on the live host:

- The backup dead-man's switch detected a stale backup correctly and sent a priority-1 "Backup Stale" message every 6 hours for 76 days — about 300 messages. No action followed.
- `pipeline-health` compares a lifetime count of failed BullMQ jobs with a threshold of 5, across a hand-kept list of 8 of the 19 queues. Once 5 jobs had ever failed, the alert was true on every run and could not return to green.
- Informational reports (drift, wiki lint, email summary, operator-action reminder) each sent their own message. In one 12-hour window `workers` sent 5 messages, of which 1 needed action.
- The monthly operator-action reminder listed finished rows as overdue, because its parser matches only a literal `DONE` prefix, and its body exceeded Pushover's 1,024-character limit.

The mechanism that detects a fault worked. The mechanism that turns a detected fault into action did not: a message that repeats unchanged for weeks carries no information, and the owner stopped reading the channel.

## Decision

Alert state lives in the application, in Postgres, and every alert goes through one helper.

1. **State.** `app_settings` key `alert_state:<key>` holds `{status, since, last_notified_at, level, receipt, acked_at}`. `app_settings` is not pruned by the retention job and survives a restart and a Redis loss.
2. **One entry point.** `BaseSkill.raiseAlert({key, severity, bad, title, message})`. Skills stop calling `PushoverService` for operational alerts. Product messages (briefs, capture confirmations) are unchanged.
3. **Three classes.**
   - *Critical* — data at risk or the core function down: backup stale, embeddings stalled, `workers` heartbeat lost, Postgres/Redis/core-api down, budget hard limit.
   - *Warning* — degraded: failed jobs in the last 24 hours at or above the threshold, a non-core container unhealthy, deploy drift, a check that could not run.
   - *Info* — reports: drift, wiki lint, email summary, operator actions, storage, dedup, consolidation.
4. **Fire on change.** Critical and warning alerts send once on ok→bad and send a low-priority "resolved" on bad→ok. They do not repeat while the condition holds.
5. **One daily digest.** One message per day lists open alerts with their ages first, then one line per info source. Nothing is sent when there is nothing to report.
6. **Escalation for what stays open.** An unresolved critical alert escalates to Pushover priority 2 (repeats until acknowledged) plus a Slack direct message at 24 hours, and to email plus a daily priority-2 message at 7 days. Acknowledging the Pushover receipt snoozes escalation for 7 days; the digest keeps listing the alert.
7. **Counting that can clear.** Queue failures are counted over a rolling 24 hours, across a queue-name registry shared by `workers` and `core-api` and checked by a test against every `new Worker(...)`.
8. **A watchdog outside `workers`.** The Cloudflare synthetic monitor reads a core-api heartbeat endpoint and alerts when the `workers` heartbeat is older than 45 minutes.

A feature flag (`ALERT_STATE_ENABLED`) restores the previous direct-push behavior. For the first week after deploy both paths run, so a defect in the new path cannot silence a real alert.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **Route everything through Prometheus Alertmanager** (it already has grouping, inhibition, and repeat intervals) | Alertmanager lives in a separate compose project on the same host, so it shares the host's failure. Most conditions here are application facts (a capture has no embedding, a source's last success is old) that would need a metric and a rule each. Alertmanager has no acknowledgement that snoozes escalation, and no daily digest. It stays as the in-host watchdog for "`workers` stopped pushing metrics". |
| **An external dead-man service for every check** | Good for "the job did not run"; it cannot express "the job ran and the result is bad". Adds a paid third party and one check per job. Kept as an option for the off-host watchdog only. |
| **Keep direct pushes; tune thresholds and priorities** | This is what the system did for a year. It fixes individual alerts and leaves the cause: no memory of what was already said. The next alert added repeats the failure. |
| **Alert state in Redis** | Redis is the store most likely to be lost or flushed during the faults the alerts report (queue trouble, a recreate). A restart would re-send every open alert. |

## Consequences

**Positive**
- An alert in the channel means something changed. A message that would have repeated 300 times is sent once, then escalates, then appears in a digest with its age.
- `pipeline-health` returns to green when the condition clears.
- Adding a check no longer adds a permanent message.

**Negative**
- A defect in the state logic can suppress a real alert. Mitigated by the feature flag, the one-week parallel run, a pure `nextAction()` function with table-driven tests, and the off-host watchdog.
- Alert history is no longer visible as a stream of messages; the digest and `app_settings` are the record.
- One more scheduled job (`ops-digest`) must fit the scheduler slot registry.

**Neutral**
- Shell scripts that alert from cron (`backup.sh`, `offsite-backup.sh`, the parity check) keep the pure-curl notifier and keep their own small state file beside their log, because they must work when the containers are down.
