# Runbook: Mobile Client Bearer-Token Onboarding

**Applies to:** Post-Phase-6 deployments of the Open Brain mobile app (Expo / iOS)  
**Auth mechanism:** `Authorization: Bearer <token>` — introduced in Phase 6 (R8)  
**Relevant action item:** A119 (create `dev/open-brain/mobile-api-key` in Bitwarden)

---

## Purpose

This runbook covers the one-time operator workflow for issuing a Bearer token to the iPhone/Watch mobile client and the procedures for token rotation, deployment sequencing, and failure diagnosis. Phase 6 replaces the prior caller-header trust (`X-Open-Brain-Caller: mobile-app` in `BYPASS_CALLERS`) with a cryptographic Bearer token enforced by the `mobile-auth` middleware in `packages/core-api/src/middleware/mobile-auth.ts`.

---

## Prerequisites

1. **A119 — BWS secret must exist.** Create the secret before attempting onboarding:

   ```bash
   # On dev machine with BWS_ACCESS_TOKEN set
   bws secret create \
     --key "dev/open-brain/mobile-api-key" \
     --value "$(openssl rand -hex 32)" \
     --project-id "<your-bws-project-id>"
   ```

   > A119 is deferred until mobile testing begins. For a single-user system, provisioning on demand is acceptable — do not create the secret as a speculative step. Reference A119 by name when scheduling the task.

2. **Mobile app version with Bearer-aware API client sideloaded to device.** The client introduced in Phase 6.4 reads the token from `expo-secure-store` and sends `Authorization: Bearer <token>` on every request. Older builds send the caller header only and will produce 401 once Phase 6.5 (BYPASS removal) is deployed.

3. **`MOBILE_API_KEY` propagated to the homeserver `.env.secrets`.** After A119 is complete, run on the homeserver:

   ```bash
   ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
   export BWS_ACCESS_TOKEN="<your-bws-access-token>"
   bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain
   bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain
   ```

   `verify-secrets.sh` exits 0 only when all mapped BWS items resolve and match the on-disk `.env.secrets` SHA256. If it exits non-zero, do not proceed.

---

## Initial Onboarding

### 1. Retrieve the token from Bitwarden

```bash
# On dev machine
export BWS_ACCESS_TOKEN="<your-bws-access-token>"
bws secret get dev/open-brain/mobile-api-key --output value
```

Copy the printed hex string. Do not log it or paste it into any notes — treat it as a password.

### 2. Sideload the mobile app to the device

The Open Brain mobile app (`packages/mobile/`, bundle ID `com.openbrain.mobile`) is distributed via Expo's local build workflow — no App Store listing. Build and install via USB or local Wi-Fi:

```bash
# From packages/mobile/ on dev machine
npx expo run:ios --device
```

If using a pre-built `.ipa`, install via Xcode Devices window or `ios-deploy`.

### 3. Paste the token into the app

On first launch after Phase 6.4 is installed, the app detects that `ob_api_token` is absent from Keychain and surfaces a "not yet onboarded" state. Navigate to **Settings** → **API Token** (or the onboarding prompt displayed on first open). Paste the hex token into the input field and confirm.

The token is written via `storage.setApiToken(token)` → `SecureStore.setItemAsync('ob_api_token', token)`. The app immediately retries the deferred API call; a successful 200 response confirms the token is accepted.

> The Settings screen lives at `packages/mobile/app/settings.tsx`. The secure-store wrapper is `packages/mobile/src/lib/storage.ts`.

---

## Token Storage on Device

The token is stored in iOS Keychain via `expo-secure-store` under key `ob_api_token`. It is:

- **Never logged** — the API client (`packages/mobile/src/lib/api-client.ts`) reads the token at call time and places it in the `Authorization` header; it is not stored in React state or transmitted over non-TLS connections.
- **Persistent** — survives app restarts, OS updates, and device reboots. Cleared only by app uninstall or an explicit "log out" action that calls `SecureStore.deleteItemAsync('ob_api_token')`.
- **Scoped to the app** — iOS Keychain access group is per-bundle-ID (`com.openbrain.mobile`). No other app can read it.

On the server side, the `mobile-auth` middleware performs a timing-safe compare against the `MOBILE_API_KEY` env var and logs only the SHA-256 prefix hash of the presented token — never the plaintext.

---

## Token Rotation

Rotate when: device is lost or stolen, token is suspected to be exposed, or on a scheduled cycle.

### Steps

1. **Generate new token in Bitwarden** (overwrites the existing secret):

   ```bash
   bws secret update \
     dev/open-brain/mobile-api-key \
     "$(openssl rand -hex 32)"
   ```

2. **Reload secrets on homeserver and restart core-api**:

   ```bash
   ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
   export BWS_ACCESS_TOKEN="<token>"
   bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain
   bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain
   cd /mnt/user/appdata/open-brain
   docker compose up -d --no-deps core-api
   ```

3. **Re-onboard the device** with the new token (repeat the Initial Onboarding steps above — paste new token via Settings).

4. **Audit logs for 401 spikes during cutover.** From the moment core-api restarts with the new key to the moment the device stores the new token, every mobile request will 401. Verify the spike is short-lived:

   ```bash
   # On homeserver — tail core-api logs for 401s
   docker logs -f open-brain-core-api 2>&1 | grep '"status":401'
   ```

   Expect the spike to resolve within seconds of completing step 3. Sustained 401s after re-onboarding indicate a mismatch — confirm the correct token was pasted.

---

## Sequencing Rule: Deploying Phase 6.4 and 6.5 Together

Phase 6.4 updates the mobile API client to send Bearer tokens. Phase 6.5 removes `mobile-app` from `BYPASS_CALLERS` and applies the mobile-tier rate limit. The two must be deployed in order to avoid a lockout window where the production server rejects all mobile requests.

**Recommended sequence:**

1. Sideload the Phase 6.4 mobile app build to the device.
2. Confirm the Bearer flow works against the homeserver **before** deploying Phase 6.5. Smoke test:
   ```bash
   export TOKEN=$(bws secret get dev/open-brain/mobile-api-key --output value)
   curl -sf -H "Authorization: Bearer $TOKEN" \
     https://brain.troy-davis.com/api/v1/captures?limit=1
   # Expected: 200 with JSON payload
   ```
3. Deploy Phase 6.5 (BYPASS removal) to the homeserver only after step 2 passes.

For this single-user system, a brief lockout window between steps 2 and 3 is acceptable — the operator controls both the device and the server. The sequence above minimizes that window to near zero. This sequencing note is recorded here so future-you doesn't skip step 2 and lock yourself out of the API.

---

## Failure Modes

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| App shows "not yet onboarded" after token was pasted | Token write failed (SecureStore error, possibly entitlement misconfiguration on sideload) | Check Xcode console for SecureStore errors; rebuild with correct entitlements |
| All mobile API calls return `503` with code `AUTH_NOT_CONFIGURED` | `MOBILE_API_KEY` env var is empty or missing on core-api | Run `load-secrets.sh`, verify with `verify-secrets.sh`, restart core-api |
| All mobile API calls return `401` with code `AUTH_INVALID` | Token mismatch — device has old token after server rotation | Re-onboard device with current token from `bws secret get dev/open-brain/mobile-api-key` |
| All mobile API calls return `401` with code `AUTH_MISSING` | Phase 6.4 client is not installed; device still on pre-Bearer build | Sideload the Phase 6.4 build and re-onboard |
| 429 responses on mobile after Phase 6.5 | Mobile tier rate limit exceeded (200 req/min) | Investigate unusually high request frequency; the mobile tier limit is generous and should not trigger under normal interactive use |
| Sustained 401s immediately after rotation cutover | Token paste did not save correctly | Clear the stored token via Settings "log out", paste the new token again, confirm 200 response |

---

## Related

- **A119** — Action item tracking the one-time BWS secret creation for `dev/open-brain/mobile-api-key`. Deferred until mobile testing begins.
- **3-step secrets lockstep (CLAUDE.md, "Backup / disaster recovery" section)** — any new secret in BWS requires lockstep updates to `deploy/.env.secrets.template`, `scripts/lib/secrets-map.sh`, and the consumer. These three files must be updated in the same commit when A119 is executed.
- **Phase 6.5 rate-limit tier** — after BYPASS removal, mobile callers are subject to a mobile tier (200 req/min) enforced in `packages/core-api/src/middleware/rate-limit.ts`. Internal Docker-network callers retain their bypass via `X-Open-Brain-Caller` + `BYPASS_CALLERS` — the internal convention is not affected by Phase 6.
- **deploy runbook** — `docs/runbooks/deploy.md` for the full core-api restart and health-check procedure.
- **restore-rehearsal runbook** — `docs/runbooks/restore-rehearsal.md` for post-DR secret reload via `load-secrets.sh`.
