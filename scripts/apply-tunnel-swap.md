# Tunnel Swap Runbook — brain.troy-davis.com → web-next

**Purpose:** Step-by-step operator runbook for cutting production traffic over from the
old Vite/React `/web` container to the new Next.js 16 `/web-next` container, and for
decommissioning `/web` after the 2-week parallel validation window.

**Trigger condition:** All Phase 7 acceptance criteria met. Both URLs have been live
in parallel for ≥ 2 weeks with no regressions.

---

## Pre-Swap Checklist

Complete every item before touching `tunnel.yaml`. Do not skip operational items —
they are the evidence that web-next is safe to promote.

### 1. Visual parity — screenshot both URLs at all routes

For each route below, open both `brain.troy-davis.com/<route>` and
`brain-next.troy-davis.com/<route>` side-by-side. Confirm equivalent content and
no broken layouts.

| Route | brain.troy-davis.com (old) | brain-next.troy-davis.com (new) |
|-------|---------------------------|----------------------------------|
| `/dashboard` | [ ] screenshotted | [ ] screenshotted |
| `/briefs` | [ ] screenshotted | [ ] screenshotted |
| `/briefs/<id>` | [ ] screenshotted | [ ] screenshotted |
| `/entities` | [ ] screenshotted | [ ] screenshotted |
| `/entities/<id>` | [ ] screenshotted | [ ] screenshotted |
| `/board` | [ ] screenshotted | [ ] screenshotted |
| `/search?q=test` | [ ] screenshotted | [ ] screenshotted |
| `/timeline` | [ ] screenshotted | [ ] screenshotted |
| `/settings` | [ ] screenshotted | [ ] screenshotted |
| `/onboarding` | [ ] screenshotted | [ ] screenshotted |
| `/financial` | [ ] screenshotted | [ ] screenshotted |
| `/investments` | [ ] screenshotted | [ ] screenshotted |
| `/intelligence` | [ ] screenshotted | [ ] screenshotted |
| `/email` | [ ] screenshotted | [ ] screenshotted |
| `/voice` | [ ] screenshotted | [ ] screenshotted |
| `/voice-upload` | [ ] screenshotted | [ ] screenshotted |
| `/wiki` | [ ] screenshotted | [ ] screenshotted |
| `/ingest` | [ ] screenshotted | [ ] screenshotted |
| `/system` | [ ] screenshotted | [ ] screenshotted |
| `/slack-cleanup` | [ ] screenshotted | [ ] screenshotted |
| `/help` | [ ] screenshotted | [ ] screenshotted |

### 2. API connectivity checks (on brain-next.troy-davis.com)

Run each curl from the homeserver or bond machine:

```bash
# Health endpoint
curl -s https://brain-next.troy-davis.com/api/v1/health | jq .status
# Expected: "healthy" or "degraded" (not "unhealthy" or curl error)

# Captures list (proxy round-trip to core-api)
curl -s "https://brain-next.troy-davis.com/api/v1/captures?limit=1" | jq .total
# Expected: integer ≥ 0

# Hybrid search
curl -s "https://brain-next.troy-davis.com/api/v1/search?q=test&limit=3" | jq '.results | length'
# Expected: 0–3

# SSE stream (5-second sample — Ctrl-C after first event or timeout)
curl -N -H "Accept: text/event-stream" \
  "https://brain-next.troy-davis.com/api/v1/sse" 2>&1 | head -5
# Expected: event: connected or heartbeat lines (not connection refused)
```

### 3. Feature smoke tests (manual, on brain-next.troy-davis.com)

- [ ] TTS: open a brief, click Listen — audio plays in floating player
- [ ] SSE events: capture a thought via Slack, watch dashboard update in real-time
- [ ] Voice upload: upload a .m4a file via `/voice-upload`, confirm pipeline processes it
- [ ] Search synthesis: search "What have I captured about X?" — synthesis card appears
- [ ] Settings toggle: flip an ingest filter, reload page, confirm it persisted
- [ ] Danger zone: open System → Admin Reset, verify two-step flow appears (do NOT confirm)

---

## Swap Steps

### Step 1 — Update tunnel.yaml (primary ingress)

Edit `config/cloudflare/tunnel.yaml` on the homeserver (or commit + pull):

```yaml
# BEFORE:
- hostname: brain.troy-davis.com
  service: http://web:80

# AFTER:
- hostname: brain.troy-davis.com
  service: http://web-next:3001
```

Keep the `brain-next.troy-davis.com` rule intact as the rollback URL:

```yaml
- hostname: brain-next.troy-davis.com
  service: http://web-next:3001
```

The file at `/mnt/user/appdata/open-brain/config/cloudflare/tunnel.yaml` is what
cloudflared reads at runtime. Either edit it in place or pull the updated git version:

```bash
cd /mnt/user/appdata/open-brain
git pull origin main
```

### Step 2 — Restart cloudflared

```bash
docker compose restart cloudflared
```

Wait 10–15 seconds for the tunnel to re-establish.

### Step 3 — Verify primary URL serves web-next

```bash
# Should return the Next.js HTML (look for __NEXT_DATA__ in the body)
curl -s https://brain.troy-davis.com/dashboard | grep -c '__NEXT_DATA__'
# Expected: 1

# Health check via primary URL
curl -s https://brain.troy-davis.com/api/v1/health | jq .status
# Expected: "healthy" or "degraded"
```

Open `https://brain.troy-davis.com` in a browser. Confirm it shows the Cloudscape UI
(not the old Vite/React interface).

### Step 4 — Verify rollback URL still works

```bash
curl -s https://brain-next.troy-davis.com/dashboard | grep -c '__NEXT_DATA__'
# Expected: 1 (still works — same backend, same container)
```

Both URLs now point to `web-next:3001`. This is intentional for the 2-week rollback
window.

---

## Rollback Procedure

If the primary URL shows errors or regressions after the swap:

### Step 1 — Revert tunnel.yaml

```bash
# Option A: git revert (if swap was committed)
cd /mnt/user/appdata/open-brain
git revert HEAD --no-edit
git pull  # if reverted remotely

# Option B: in-place edit
# Change: service: http://web-next:3001 → service: http://web:80
# for the brain.troy-davis.com rule only
nano config/cloudflare/tunnel.yaml
```

### Step 2 — Restart cloudflared

```bash
docker compose restart cloudflared
```

### Step 3 — Verify rollback succeeded

```bash
# Should NOT contain __NEXT_DATA__ (it's the old Vite/React app)
curl -s https://brain.troy-davis.com/dashboard | grep -c '__NEXT_DATA__'
# Expected: 0

# Old app health
curl -s https://brain.troy-davis.com/api/v1/captures?limit=1 | jq .total
# Expected: integer ≥ 0
```

### Post-rollback: diagnose before re-attempting swap

Check web-next container logs for the error that triggered rollback:

```bash
docker logs open-brain-web-next --since 30m 2>&1 | tail -100
# Or via Grafana Loki: {container_name="open-brain-web-next"}
```

---

## /web Decommission Sequence

Execute after the 2-week parallel validation window (≥ 2026-05-06) with zero
regressions on the primary URL.

### Step 1 — Remove `web` service from docker-compose.yml

In `docker-compose.yml`, delete the entire `web:` service block (lines from
`web:` through the end of its configuration). Keep `web-next:` unchanged.

Do NOT delete `packages/web/` from the source tree — git history preserves it
and it may be referenced in documentation.

### Step 2 — Add DECOMMISSIONED header to web Dockerfile

Edit `packages/web/Dockerfile` to add a comment block at the top:

```dockerfile
# DECOMMISSIONED — replaced by packages/web-next (Cloudscape M3, 2026-05-xx)
# Source tree preserved for git history. Do not build or deploy this image.
# See scripts/apply-tunnel-swap.md for decommission log.
```

### Step 3 — Remove brain-next.troy-davis.com tunnel rule

In `config/cloudflare/tunnel.yaml`, remove the `brain-next` ingress block entirely.
Pull or push to homeserver, then restart cloudflared:

```bash
docker compose restart cloudflared
```

Delete the Cloudflare DNS CNAME for `brain-next.troy-davis.com` via the Cloudflare
dashboard (DNS → Records → find brain-next CNAME → Delete).

### Step 4 — Update CLAUDE.md references

Search for references to the old `/web` container and `brain-next.troy-davis.com`
in `CLAUDE.md` and update them:

- `packages/web/Dockerfile` → mark as decommissioned reference
- Any mention of `web:80` in Docker/infra section → update to `web-next:3001`
- Primary URL remains `brain.troy-davis.com` — no change needed there

### Step 5 — Stop and remove old web image

```bash
# Homeserver
docker stop open-brain-web 2>/dev/null || true
docker rm open-brain-web 2>/dev/null || true
docker rmi ghcr.io/davistroy/open-brain/web:latest 2>/dev/null || true
```

### Step 6 — Log completion in LAB_NOTEBOOK.md

Add an entry recording: date of decommission, parallel validation duration, any
issues encountered, final state of both URLs.

---

## Decommission Log

| Date | Action | Operator | Notes |
|------|--------|----------|-------|
| (fill in) | Parallel URL `brain-next` went live | | |
| (fill in) | Primary URL swapped to web-next | | |
| (fill in) | `/web` service removed from compose | | |
| (fill in) | `brain-next` DNS CNAME deleted | | |
