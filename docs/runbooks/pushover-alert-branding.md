# Runbook: Pushover alert branding (`From Voice Capture`)

**Issue:** #312
**Symptom:** every infrastructure Pushover alert arrives titled **"From Voice Capture"** — the Pushover *application* the API token is registered under. During the 2026-07-14→16 scheduler outage, ~40 **critical** sirens fired over ~40 hours and read as voice-memo noise, so the outage went unactioned until manually investigated (LAB_NOTEBOOK Entries 211/213/214).

**Root fact:** the app-name banner is set in the **Pushover console** (pushover.net), tied to the API token. It **cannot** be set per message. Only the notification *title* is settable per message.

---

## The two sender paths (both must be considered)

| # | Path | Where it lives | What it sends |
|---|------|----------------|---------------|
| 1 | In-app `PushoverService` | `packages/shared/src/services/pushover.ts` (this repo), single `PUSHOVER_APP_TOKEN` | backup dead-man's switch, pipeline-health, cost/drift/container alerts, financial/utility notifications, voice-memo confirmations |
| 2 | **Alertmanager** | the external **`observability`** compose project (post-ADR-0004) — **NOT this repo** | Prometheus-rule alerts routed to the `pushover-critical` / `pushover-warning` receivers. **This is the path that sent the 40 outage sirens.** |

Both currently use the same Pushover application ("Voice Capture"), so both carry the same banner.

---

## What the code side already does (#312, shipped)

`PushoverService.send()` now prepends a stable **identity prefix** to every title, idempotently:

- Default prefix: **`Open Brain`** (so "Daily Sweep" → "Open Brain: Daily Sweep").
- Already-branded titles are left unchanged (case-insensitive): "Open Brain: Pipeline Health Alert" and the bare "Open Brain" are untouched.
- Override with the **`PUSHOVER_TITLE_PREFIX`** env var; set it to an empty string to disable.

This hardens **path 1** so an in-app alert's *title line* identifies Open Brain even under the "Voice Capture" banner. It also re-brands voice-memo confirmations to "Open Brain: Voice memo captured" — an intended, reversible side effect (pass `titlePrefix: ''` to `NotificationService`/`PushoverService` if voice memos should stay unprefixed).

**It does not change the banner, and it does not touch path 2** (Alertmanager sets its own titles from Prometheus labels in the observability project). The banner fix is operator work below.

---

## Operator decision: rename vs. split

### Option A — rename the Pushover application (simplest; fixes both paths' banner at once)

1. Sign in to <https://pushover.net> (Troy's account).
2. **Your Applications** → open the app currently named **"Voice Capture"**.
3. Rename it to **"Open Brain"** (and optionally update the icon).
4. Save. The **token is unchanged**, so no code, env, or Alertmanager change is required — every existing notification (both paths) immediately shows "From Open Brain".

**Trade-off:** voice-memo confirmations also re-brand to "From Open Brain" (arguably an improvement; consistent product identity). Nothing else changes.

### Option B — split infra alerts into their own application (distinct identity for criticals)

Use this if you want paging criticals to be visually separate from routine notifications.

1. On pushover.net, **Create a New Application/API Token** named **"Open Brain Infra"**. Note its token.
2. **Path 2 (the outage-class alerts):** in the **`observability`** project's Alertmanager config, point the `pushover-critical` (and optionally `pushover-warning`) receiver's `token` at the new app token. Reload Alertmanager. *This is the highest-value single change — it is the path that pages.*
3. **Path 1 (optional):** to also route in-app criticals to the new app, provision the new token as a second env (e.g. `PUSHOVER_INFRA_APP_TOKEN`) and construct a dedicated `PushoverService` for the critical call sites. This is a larger code change; defer unless the split must cover path 1 too.

**Trade-off:** two tokens to manage; but criticals get an unmissable, dedicated identity.

**Recommendation:** **A** unless a dedicated critical identity is specifically wanted. A is one console step and fixes the banner everywhere; the shipped title prefix is the belt to A's suspenders.

---

## Verify

- **Path 1 title prefix (already live after the workers/voice-capture/core-api deploy that ships this):**
  ```bash
  # in a running container that sends Pushover (e.g. workers), the delivered title is prefixed:
  # look for "Open Brain: <title>" in the pushover 'notification sent' log line
  docker logs open-brain-workers 2>&1 | grep -i "notification sent" | tail
  ```
- **Banner (after Option A/B):** trigger any alert (e.g. `pipeline-health` manually) and confirm the Pushover banner reads "Open Brain" / "Open Brain Infra" instead of "Voice Capture".

---

## Why this matters

An alert that cannot be told apart from noise is functionally an alert that does not exist. This is the one change that would have made the 40-hour scheduler outage visible in minutes. See LAB_NOTEBOOK Entry 214 ("Alert branding — the real human-factors bug").
