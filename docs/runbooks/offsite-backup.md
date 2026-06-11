# Runbook: Encrypted Offsite Backup (RC-1)

**Installed:** 2026-06-11 (LAB_NOTEBOOK Entry 164, arch-review v3 RC-1)
**Script:** `scripts/offsite-backup.sh` · **Cron:** `deploy/cron/unraid-offsite-backup.cron` (daily 03:45)
**Log:** `/var/log/open-brain-offsite-backup.log` on the homeserver

## What it does

Copies `/mnt/user/backup/openbrain` (written by `backup.sh` at 03:00) to the
rclone **crypt** remote `open-brain-offsite:` — encrypted file contents *and*
names on Google Drive under `gdrive:Backups/open-brain-crypt`. Remote files
older than 30 days are pruned (TDD §16 design). Steady state: a rolling
~30-day window of daily backups offsite; weekly/monthly deep history remains
local-only.

Failure sends a priority-1 Pushover alert (`scripts/lib/pushover-notify.sh`).

## Key facts

| Item | Value |
|------|-------|
| Crypt remote | `[open-brain-offsite]` in `/mnt/user/appdata/rclone-onedrive/config/rclone.conf` |
| Underlying remote | `gdrive:Backups/open-brain-crypt` (Google Drive, 2 TB plan) |
| Crypt password | BWS secret `open-brain-rclone-crypt-password` (ai-work project) |
| Crypt salt (password2) | BWS secret `open-brain-rclone-crypt-salt` (ai-work project) |
| rclone runtime | Dockerized `rclone/rclone:latest` (no host rclone install) |
| Config backup | `rclone.conf.bak-2026-06-11` alongside the live conf |

**The crypt password/salt exist in exactly two places:** the obscured values in
`rclone.conf` (on the array — lost in a chassis event) and BWS. Losing both
makes the offsite data permanently undecryptable. Do not rotate them without
re-seeding the remote.

## Recreate the remote after a rebuild

```bash
PW=$(bws secret get <id-of-open-brain-rclone-crypt-password> | jq -r .value)
SALT=$(bws secret get <id-of-open-brain-rclone-crypt-salt> | jq -r .value)
OPW=$(docker run --rm rclone/rclone:latest obscure "$PW")
OSALT=$(docker run --rm rclone/rclone:latest obscure "$SALT")
cat >> /mnt/user/appdata/rclone-onedrive/config/rclone.conf <<EOF

[open-brain-offsite]
type = crypt
remote = gdrive:Backups/open-brain-crypt
password = ${OPW}
password2 = ${OSALT}
EOF
```

(The `gdrive` remote must also exist — it is part of the standing
rclone-onedrive/rclone-gdrive sync setup.)

## Restore procedure (disaster: chassis lost)

1. Rebuild the `gdrive` + `open-brain-offsite` remotes (above).
2. Pull the newest daily backup:
   ```bash
   docker run --rm \
     -v /mnt/user/appdata/rclone-onedrive/config:/config/rclone \
     -v /mnt/user/restore:/restore \
     rclone/rclone:latest copy open-brain-offsite:daily /restore/daily \
     --config /config/rclone/rclone.conf
   ls /mnt/user/restore/daily   # pick newest <date> dir
   ```
3. Follow the standard restore path: recreate Postgres, `pg_restore` the dump,
   validate row counts against `manifest.json` (same logic as
   `scripts/restore-rehearsal.sh`), rebuild `.env.secrets` via
   `scripts/load-secrets.sh`.

## Verify it is working

```bash
grep offsite-backup /etc/cron.d/root                  # cron installed
tail -20 /var/log/open-brain-offsite-backup.log       # last run
docker run --rm -v /mnt/user/appdata/rclone-onedrive/config:/config/rclone \
  rclone/rclone:latest lsd open-brain-offsite: --config /config/rclone/rclone.conf
```

A `canary/ob-canary.txt` file from the 2026-06-11 install verifies decryption
end-to-end.
