# Rollback: Restore packages/web

## When to use
If `packages/web-next` has a critical regression that blocks production use of brain.troy-davis.com, and the fix will take longer than acceptable downtime.

## Prerequisites
- Tag `pre-web-sunset-2026-05` exists in the repo (created 2026-05-06 before Phase 8b deletion)
- Docker host has the old `open-brain-web` image cached, or can rebuild

## Steps

1. **Restore the web package from the tag:**
   ```bash
   git checkout pre-web-sunset-2026-05 -- packages/web
   ```

2. **Re-add the web service to docker-compose.yml:**
   Copy the web service block from the tagged commit:
   ```bash
   git show pre-web-sunset-2026-05:docker-compose.yml | grep -A 40 'web:' | head -45
   ```
   Paste into docker-compose.yml (was at ~line 474).

3. **Reinstall dependencies:**
   ```bash
   pnpm install
   ```

4. **Rebuild and start:**
   ```bash
   docker compose up -d --build web
   ```

5. **Switch Cloudflare Tunnel ingress:**
   In `config/cloudflare/tunnel.yaml`, change `brain.troy-davis.com` service from `http://web-next:3000` to `http://web:80`.

6. **Restart cloudflared:**
   ```bash
   docker compose restart cloudflared
   ```

## Verification
- `curl -s https://brain.troy-davis.com` returns the Vite SPA shell
- Dashboard loads captures, search works, settings page renders

## Reverting the rollback
Once the web-next fix is deployed, reverse all steps: remove packages/web, remove docker-compose web service, switch tunnel back to web-next, `pnpm install`, redeploy.
