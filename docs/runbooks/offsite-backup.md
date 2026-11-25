# Runbook: Encrypted Offsite Backup (RC-1)

**Installed:** 2026-06-11 (LAB_NOTEBOOK Entry 164, arch-review v3 RC-1)
**Script:** `scripts/offsite-backup.sh` · **Cron:** `deploy/cron/unraid-offsite-backup.cron` (daily 03:45)
**Log:** `/var/log/open-brain-offsite-backup.log` on the homeserver

## What it does

Copies `/mnt/user/backup/openbrain` (written by `backup.sh` at 03:00) to the
rclone **crypt** remote `open-brain-offsite:` — encrypted file contents *and*
names on Google Drive under `gdrive:Backups/open-brain-crypt`. The copy uses
`rclone copy --max-age 2d` (never `sync`: a local wipe must not delete remote
files). Remote files are then pruned **per tier**:

| Tier | Remote retention | Local retention |
|------|------------------|-----------------|
| `daily/` | 30 days | 14 |
| `weekly/` | 35 days | 4 |
| `monthly/` | 100 days | 3 |

The remote windows are longer than the local ones on purpose. Every prune
passes `--exclude 'canary/**'`, so `canary/ob-canary.txt` is never deleted.

## Freshness checks (the script exits 1 on either)

1. **Source check, before the prune.** The newest local
   `daily/*/openbrain.pgdump` must be younger than
   `OFFSITE_SOURCE_MAX_AGE_HOURS` (default 48). Older, or none at all: the
   prune is skipped, the run exits 1, and a Pushover alert is sent. Without
   this guard an age-based prune drains the remote to empty once the local
   backup stops (2026-09 incident: 0 objects, every run logged "complete").
2. **Result check, after the copy.** `rclone lsf -R --max-age 48h --include
   '*/openbrain.pgdump' open-brain-offsite:daily` must return a file. An empty
   listing exits 1 and skips the prune.

On success the script writes the timestamp to
`${BACKUP_ROOT}/.offsite-last-success` (read by the freshness alert, item 7.3).

Seeding run: `OFFSITE_MAX_AGE=off` copies the whole tree once (config files
whose mtime predates the 2-day window); the next normal run is back to `2d`.
Do not leave `off` set while the prune is age-based, or files are re-uploaded
and deleted in a loop.

Test: `bash scripts/test-offsite-backup.sh` (stub `RCLONE_CMD`, no network).

Failure sends a priority-1 Pushover alert (`scripts/lib/pushover-notify.sh`).

## Key facts

| Item | Value |
|------|-------|
| Crypt remote | `[open-brain-offsite]` in `/mnt/user/appdata/rclone-onedrive/config/rclone.conf` |
| Underlying remote | `gdrive:Backups/open-brain-crypt` (Google Drive, 2 TB plan) |
| Crypt password | BWS secret `open-brain-rclone-crypt-password` (ai-work project) |
| Crypt salt (password2) | BWS secret `open-brain-rclone-crypt-salt` (ai-work project) |
| rclone runtime | Dockerized `rclone/rclone:1.76.0` (no host rclone install) |
| Config backup | `rclone.conf.bak-2026-06-11` alongside the live conf |

**The crypt password/salt exist in exactly two places:** the obscured values in
`rclone.conf` (on the array — lost in a chassis event) and BWS. Losing both
makes the offsite data permanently undecryptable. Do not rotate them without
re-seeding the remote.

## Recreate the remote after a rebuild

```bash
PW=$(bws secret get <id-of-open-brain-rclone-crypt-password> | jq -r .value)
SALT=$(bws secret get <id-of-open-brain-rclone-crypt-salt> | jq -r .value)
OPW=$(docker run --rm rclone/rclone:1.76.0 obscure "$PW")
OSALT=$(docker run --rm rclone/rclone:1.76.0 obscure "$SALT")
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
     rclone/rclone:1.76.0 copy open-brain-offsite:daily /restore/daily \
     --config /config/rclone/rclone.conf
   ls /mnt/user/restore/daily   # pick newest <date> dir
   ```
3. Follow the manual-restore checklist in `docs/runbooks/restore-rehearsal.md`
   ("Manual restore (actual DR)"), with `B=/mnt/user/restore/daily/<date>` in its step 4.
   The checklist rebuilds `.env.secrets`, restores the dump with `scripts/restore.sh`
   (empty database, no schema applied first), and deploys through `scripts/deploy.sh`.

## Verify it is working

```bash
grep offsite-backup /etc/cron.d/root                  # cron installed
tail -20 /var/log/open-brain-offsite-backup.log       # last run
docker run --rm -v /mnt/user/appdata/rclone-onedrive/config:/config/rclone \
  rclone/rclone:1.76.0 lsd open-brain-offsite: --config /config/rclone/rclone.conf
```

A `canary/ob-canary.txt` file from the 2026-06-11 install verifies decryption
end-to-end.
