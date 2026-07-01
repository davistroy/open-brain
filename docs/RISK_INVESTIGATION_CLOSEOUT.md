# Risk Investigation Closeout

**Generated:** 2026-06-30
**Arch-review wave:** Wave 3 (Phase 10.4)
**Author:** Claude Code agent (Phase 10 orchestration)

This document records the findings and dispositions for three open risk investigations from the arch-review v3 cycle. Each RI is a bounded research item that cannot be closed by code change alone.

---

## RI-1: Branch Protection + Repo Visibility

**Investigation date:** 2026-06-30
**Method:** `gh api repos/davistroy/open-brain/branches/main/protection` and `gh api repos/davistroy/open-brain --jq '{visibility,private,name}'`

### Actual State (API response)

**Branch protection (main):**

```json
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Integration tests (core-api + real DB)",
      "build-and-test"
    ]
  },
  "enforce_admins": { "enabled": false },
  "required_pull_request_reviews": null,
  "allow_force_pushes": { "enabled": false },
  "allow_deletions": { "enabled": false }
}
```

**Repository:**

```json
{ "name": "open-brain", "private": false, "visibility": "public" }
```

### Comparison to Intended Posture (CLAUDE.md "Branch protection on main")

| Property | Intended (CLAUDE.md Phase 5b) | Actual |
|----------|-------------------------------|--------|
| `required_status_checks.contexts` | `["Integration tests (core-api + real DB)"]` with note that `build-and-test` "can now be promoted" (A126 resolved) | `["Integration tests (core-api + real DB)", "build-and-test"]` |
| `strict` | false | false ✓ |
| `enforce_admins` | false | false ✓ |
| `required_pull_request_reviews` | null | null ✓ |
| Repository visibility | Private (implied by CLAUDE.md note on ADR-0002/LAN exposure model) | **PUBLIC** |
| `allow_force_pushes` | Not specified (should be false for main) | false ✓ |

### Findings

**No drift on branch protection.** The `build-and-test` check being present alongside "Integration tests" is the correct promoted state that CLAUDE.md explicitly anticipated ("can now be promoted to required — A126 resolved"). All other protection fields match intent.

**DRIFT — repo is public, not private.** The CLAUDE.md `Branch protection on main` note discusses `enforce_admins=false` as an "admin escape hatch preserved for solo recovery" — a posture that makes sense for a private repo. The ADR-0002 risk model (LAN exposure) also assumes the threat model is controlled access. The repo being public means source code, configuration examples, and any accidental plaintext references are world-readable. The investigation cannot determine whether this was intentional (open-source mindset for a personal project) or an oversight. **Action required: operator confirms intentional or sets repo to private via GitHub Settings.**

---

## R1: urBackup Off-Chassis Coverage

**Investigation date:** 2026-06-30
**Method:** Cannot SSH to homeserver from this dev environment. Finding based on CLAUDE.md/MEMORY.md documented state and derived procedure.

### Known State

Open Brain has an **encrypted offsite backup** (RC-1, Entry 164, CLAUDE.md `Encrypted offsite backup` section):

- Script: `scripts/offsite-backup.sh`
- Transport: `rclone copy` to `open-brain-offsite:` (a crypt remote over `gdrive:Backups/open-brain-crypt`)
- Retention: 30-day remote, with age-prune on the crypt side
- Cron: homeserver root cron `daily 03:45` (CLAUDE.md documents 5 root cron entries including `offsite-backup`)
- Encryption keys: Bitwarden `open-brain-rclone-crypt-password`/`-salt` — losing both makes offsite data undecryptable

urBackup is documented as a **separate homeserver application** (MEMORY.md `urBackup` section) covering local snapshots on the Unraid array. It is explicitly NOT to be placed on the cache pool.

### Residual Question

urBackup provides local/LAN snapshot coverage; the rclone crypt offsite provides off-chassis encrypted coverage. The risk investigation asks whether the **urBackup job** is additionally replicating off-chassis (to a NAS or remote) as a second offsite path, or whether the rclone crypt offsite is the **only** off-chassis copy.

### Verification Procedure (operator)

1. Open the urBackup web UI on the homeserver (typically `http://homeserver.k4jda.net:55414`).
2. Navigate to **Settings → Backup Storage**.
3. Confirm the backup destination path — likely `/mnt/user/backup` or a similar Unraid share.
4. Check whether any **Internet/remote backend** is configured under Settings → Internet / Internet Clients. If none, urBackup is LAN-only.
5. Check the **Status** page: verify the open-brain data directory (or the Unraid share containing Docker volumes) appears in a client's backup list and last backup timestamp is recent.
6. Cross-check: run `rclone ls open-brain-offsite:` on the homeserver to confirm the gdrive crypt remote has recent tarballs (`ls -lt` equivalent).

### Disposition

- **Off-chassis coverage confirmed via rclone crypt** (RC-1, documented). The daily `offsite-backup.sh` cron is in the Unraid root cron (`/boot/config/plugins/dynamix/custom.cron`).
- **urBackup off-chassis replication:** operator must verify in the UI. If urBackup is LAN-only (expected), the rclone crypt path is the sole off-chassis tier — acceptable for a single-user system with daily encrypted offsite.
- **No action required** if urBackup is confirmed LAN-only and rclone offsite is operational. Only gap would be if rclone cron has silently failed — verify by checking `gdrive:Backups/open-brain-crypt` for a timestamp within the last 48 hours.

---

## PLT-RI-1: `docker compose up --remove-orphans` vs Compose Profiles

**Investigation date:** 2026-06-30
**Method:** `grep profiles: docker-compose.yml`

### Finding

`docker-compose.yml` uses `profiles:` on **four services**, all tagged `observability`:

| Service | Container | Profile |
|---------|-----------|---------|
| loki | open-brain-loki | observability |
| pushgateway | open-brain-pushgateway | observability |
| prometheus | open-brain-prometheus | observability |
| grafana | open-brain-grafana | observability |

These services are defined at lines 504–603 of `docker-compose.yml`.

### Risk

`docker compose up -d --remove-orphans` without `--profile observability` (or `COMPOSE_PROFILES=observability` in the environment) does **not** activate the observability profile. Docker Compose considers profile-gated containers that are already running (from a prior `--profile observability` deploy) as **orphans** and removes them. Result: monitoring stack goes dark on the next deploy if the profile flag is omitted.

This is a real operational hazard. The Phase 4 observability deploy (Entry 172) was the first time these services ran. Subsequent deploys without `COMPOSE_PROFILES=observability` will remove them silently.

### Recommendation

**Pin `COMPOSE_PROFILES` in the deploy environment.** Add the following to `/mnt/user/appdata/open-brain/.env` (the non-secret env file sourced by `docker compose`):

```bash
COMPOSE_PROFILES=observability
```

When this is set, `docker compose up -d --remove-orphans` correctly includes the observability services and will not orphan-remove them. Alternatively, the deploy runbook (`docs/runbooks/deploy.md`) should document using:

```bash
docker compose --profile observability up -d --remove-orphans
```

**Check `docs/runbooks/deploy.md`** for any existing `up` command that omits `--profile observability` and add it. The `--remove-orphans` flag is safe once profiles are pinned.

No code change required. Operator action: set `COMPOSE_PROFILES=observability` in `.env` or in the Unraid cron wrapper before the next deploy that uses `--remove-orphans`.
