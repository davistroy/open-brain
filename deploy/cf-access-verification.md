# Cloudflare Access — Verification Record (SEC-01)

**Last verified:** 2026-06-11 (LAB_NOTEBOOK Entry 164, arch-review v3 SEC-01)
**Verified from:** external network path (ubuntu-vm → public internet → Cloudflare edge)

## What was verified

Unauthenticated probes against `brain.troy-davis.com` (the Cloudflare Tunnel
ingress / sole production UI + API hostname):

| Path | Result |
|------|--------|
| `GET /` | `302` → `https://troydavis.cloudflareaccess.com/cdn-cgi/access/login/brain.troy-davis.com` |
| `GET /api/v1/captures?limit=1` | `302` → same Access login (`auth_status: NONE`) |
| `GET /mcp` | `302` → same Access login |

All three carried `www-authenticate: Cloudflare-Access` and set a
`CF_AppSession` cookie — the **entire hostname is behind a Cloudflare Access
policy** (team domain `troydavis.cloudflareaccess.com`); no unauthenticated
content or API response is served. `service_token_status: false` in the probe
JWTs confirms no service-token bypass was matched for plain GETs.

## Re-verify (any box outside the LAN)

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://brain.troy-davis.com/
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://brain.troy-davis.com/api/v1/captures?limit=1"
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://brain.troy-davis.com/mcp
```

Expected: every line starts `302 https://troydavis.cloudflareaccess.com/...`.
Anything returning `200` without authentication is a policy regression — treat
as a security incident (the dashboard intentionally has no app-level auth;
CF Access is the only gate on the tunnel path).

## Known scoped exceptions (review when policies change)

- A CF Access **bypass app** was added 2026-05-09 for dashboard CORS
  (issue #198 closeout). The probes above confirm it does not expose `/`,
  `/api/v1/*`, or `/mcp` to anonymous GETs; if its scope is ever widened,
  re-run the probes.
- Programmatic ingress (iOS Shortcut voice uploads, email worker) uses
  separate paths/credentials — changes there must not loosen the
  brain.troy-davis.com policy.
