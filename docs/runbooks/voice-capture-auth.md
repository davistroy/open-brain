# Runbook: Voice-Capture Bearer Auth (`VOICE_CAPTURE_SECRET`)

**Applies to:** Phase 8 (INT-M5) deployments of the voice-capture service
**Auth mechanism:** `Authorization: Bearer <secret>` on `POST /api/capture`
**Secret:** `dev/open-brain/voice-capture-secret` → `VOICE_CAPTURE_SECRET`
**Decision:** D132 / Option 1 — voice-capture stays on the LAN (`:3001`, `0.0.0.0`); the Bearer is the security control. The SEC-02 loopback bind (8.2) is **deferred** until voice routes through a tunnel (tracked in the Deployment & Ops backlog).

---

## How it works

`POST /api/capture` is **fail-closed when `VOICE_CAPTURE_SECRET` is set** and **warn-and-allow when unset**:

- **Set** → every request must present `Authorization: Bearer <VOICE_CAPTURE_SECRET>`. A timing-safe compare (`crypto.timingSafeEqual`) gates the route; a missing/wrong token returns `401 UNAUTHORIZED` **before** any paid transcription.
- **Unset** → the route logs a startup warning and allows all requests (pre-rollout state).

This split enables a safe **two-phase rollout**: deploy the code (secret unset → nothing breaks) → update every client to send the Bearer → then set the secret to switch enforcement on.

### Three client paths to `:3001`

| Client | How it sends the Bearer |
|--------|-------------------------|
| **iOS Shortcut** (the live voice path) | **Manual** — add a request header `Authorization: Bearer <secret>` to the "Get Contents of URL" action (see below). |
| **Expo mobile app** | Reads `EXPO_PUBLIC_VOICE_SECRET` (bundled at build) → `Authorization` header in `packages/mobile/src/lib/audio.ts`. |
| **Web (`/voice` page)** | Goes through the core-api proxy `POST /api/v1/voice-captures`, which **forwards the Bearer upstream automatically** from its own `VOICE_CAPTURE_SECRET` env (no client change). |

> Because the iOS Shortcut and mobile app post **directly** to `homeserver:3001`, both must be updated to send the Bearer **before** you set `VOICE_CAPTURE_SECRET`, or they will 401.

---

## Enabling enforcement (two-phase rollout)

### Phase A — deploy code, clients still bare

The Phase 8 images already contain the Bearer check (inert while the secret is unset). Nothing to do beyond the normal deploy. Captures keep working unauthenticated.

### Phase B — distribute the secret to clients

1. **Generate + store the secret in Bitwarden** (operator-deferred until you start this rollout):

   ```bash
   # dev machine with BWS_ACCESS_TOKEN set
   bws secret create \
     --key "dev/open-brain/voice-capture-secret" \
     --value "$(openssl rand -hex 32)" \
     --project-id "<your-bws-project-id>"
   export VOICE_SECRET=$(bws secret get dev/open-brain/voice-capture-secret --output value)
   ```

2. **iOS Shortcut** — open the Open Brain capture Shortcut → the **Get Contents of URL** action (the `POST` to `http://homeserver.k4jda.net:3001/api/capture`) → **Headers** → add:
   - Key: `Authorization`
   - Value: `Bearer <paste VOICE_SECRET>`

   Treat the value as a password. Do not screenshot or paste it into notes.

3. **Mobile app** (if in use) — set `EXPO_PUBLIC_VOICE_SECRET=<VOICE_SECRET>` in the build env and rebuild/sideload (`npx expo run:ios --device`).

### Phase C — switch enforcement on

1. **Propagate the secret to the homeserver and restart the consumers** (both voice-capture and core-api read it — voice-capture to enforce, core-api to forward):

   ```bash
   ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
   export BWS_ACCESS_TOKEN="<token>"
   bash scripts/load-secrets.sh   --target-dir /mnt/user/appdata/open-brain
   bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain   # exits 0 = clean
   cd /mnt/user/appdata/open-brain
   sudo docker compose up -d --no-deps voice-capture core-api
   ```

2. **Smoke test** — unauthenticated must 401, authenticated must succeed:

   ```bash
   # From a LAN host — no Bearer → 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://homeserver.k4jda.net:3001/api/capture
   # With Bearer + a tiny audio file → not 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H "Authorization: Bearer $VOICE_SECRET" \
     -F file=@sample.m4a http://homeserver.k4jda.net:3001/api/capture
   ```

3. **Exercise the real iOS Shortcut once** to confirm the header was saved correctly.

---

## Rotation

Rotate when the secret may be exposed, a device is lost, or on a scheduled cycle.

```bash
# 1. New value in Bitwarden (overwrites the existing secret)
bws secret update dev/open-brain/voice-capture-secret "$(openssl rand -hex 32)"

# 2. Reload + restart on homeserver
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
export BWS_ACCESS_TOKEN="<token>"
bash scripts/load-secrets.sh   --target-dir /mnt/user/appdata/open-brain
bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain
cd /mnt/user/appdata/open-brain && sudo docker compose up -d --no-deps voice-capture core-api

# 3. Update the iOS Shortcut header (and rebuild the mobile app) with the new value.
```

During the cutover window (server restarted, clients not yet updated) direct voice captures 401. For a single-user system this brief window is acceptable; update the Shortcut promptly. The web `/voice` path is unaffected (core-api forwards the new secret automatically after its restart).

**Staleness alerting is automatic.** The `secret-rotation` skill (monthly, `0 10 1 * *`) runs `bws secret list` over **all** BWS secrets and Pushover-alerts on any not rotated within 90 days — `voice-capture-secret` (and `mobile-api-key`) are covered the moment they exist in BWS. No list to maintain.

---

## Failure modes

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| iOS Shortcut / mobile capture returns `401 UNAUTHORIZED` after enabling the secret | Client not sending (or sending a wrong) Bearer | Re-check the Shortcut `Authorization` header value / rebuild the app with the right `EXPO_PUBLIC_VOICE_SECRET` |
| Web `/voice` returns `401` from upstream | core-api was not restarted after the secret changed (proxy still forwarding the old/no secret) | `sudo docker compose up -d --no-deps core-api` |
| All voice captures still succeed without a Bearer | `VOICE_CAPTURE_SECRET` is unset on voice-capture (pre-rollout warn-and-allow) | Confirm it is in `.env.secrets` and voice-capture was recreated |
| Transcribed memo "lost" during a core-api outage | It was not lost — INT-M4 dead-letters it to the `voice_spool_data` volume; the 30-min retry sweep re-ingests it | Check `docker exec open-brain-voice-capture ls /data/voice-spool`; confirm core-api is healthy |

---

## Recoverability

The voice-capture pipeline has two distinct failure boundaries with different recoverability characteristics:

**Ingest failures are recoverable (INT-M4).**
After a voice memo is successfully transcribed and classified, `server.ts` calls `spoolTranscript()` (a write-ahead to `voice_spool_data:/data/voice-spool`) *before* posting to core-api. If the core-api ingest call fails — e.g. core-api is restarting or temporarily down — the spool file survives the failure. A `setInterval` sweep (default 30 min, configurable via `VOICE_SPOOL_RETRY_MS`) calls `retrySpooledTranscripts()`, which replays each spooled payload through `ingestService.ingest()` and removes the file on success. Corrupt spool files are discarded (logged as WARN) so the spool cannot loop forever.

**Transcription and classification failures are unrecoverable server-side.**
The audio bytes are read from the multipart request but never written to disk. If Whisper/OpenAI transcription fails (step 1) or LLM classification fails (step 2), `server.ts` returns a 502 error before `spoolTranscript()` is ever called — nothing is durably stored. The client must retry the full upload. For iOS Shortcut users this means re-running the capture; for the mobile app, an in-app retry prompt is appropriate.

---

## Related

- **`docs/runbooks/mobile-onboarding.md`** — the `MOBILE_API_KEY` Bearer (separate secret, main-API auth) and its rotation.
- **3-step secrets lockstep (CLAUDE.md, "Backup / disaster recovery")** — `VOICE_CAPTURE_SECRET` was added in lockstep to `deploy/.env.secrets.template` + `scripts/lib/secrets-map.sh` (consumer: voice-capture + core-api via `env_file`).
- **ADR-0002 / D132** — voice-capture LAN exposure is accepted (Bearer-gated); the loopback bind (SEC-02 8.2) is deferred with the voice-tunnel work.
- **INT-M4 dead-letter** — `packages/voice-capture/src/lib/transcript-spool.ts`; spool dir `voice_spool_data` → `/data/voice-spool`.
