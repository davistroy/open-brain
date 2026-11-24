# ADR-0006: Deployed State Derives from One Commit and Is Recorded in a Manifest

**Status:** Accepted (2026-11-24, item 5.2)
**Date:** 2026-11-22
**Deciders:** Troy Davis (single-user system owner)
**Driven by:** `/ultra-plan` remediation of arch-review v7 — findings SA7-03, PLT-005, RC7-12, SA7-09, PLT-022, INT-019 (change set Phase 3)

---

## Context

A deploy today is a set of hand-run commands on the homeserver: `docker compose pull`, then `up -d --force-recreate --no-deps <services>`. Four things decide what runs, and they move independently:

1. **Images.** Every service uses the `:latest` tag. The running image is whatever `:latest` was when the service was last recreated. Images carry no label naming the commit they were built from.
2. **The host working tree.** `docker-compose.yml`, `config/`, and `scripts/` are read from a git checkout on the host. On 2026-11-22 that checkout was at a commit from 2026-06-16, had 72 modified or untracked paths, and its `HEAD` was no longer an ancestor of `main` after a history rewrite.
3. **Host-only files.** `docker-compose.override.yml`, `.env`, `.env.secrets`, and several config files exist only on the host.
4. **The schema ledger.** Migrations are applied by hand.

Consequences observed on the live host: three merged changes were never deployed over four months; the host compose file was a mixture of two versions; the running Redis image differed from the one the host's own compose file named; and the daily drift check had failed on every run without anyone noticing, because it compared one file and reported its own failure as a missing repository.

The Postgres and Redis data directories also sit inside the git working tree and are not gitignored, so an ordinary `git clean` there would delete the database.

## Decision

A deploy is one command that takes one commit, and it writes down what it did.

1. **Images name their commit.** `build-images.yml` adds the label `org.opencontainers.image.revision` (the full commit) and pushes a `sha-<first 7 characters of the full commit>` tag (`${GITHUB_SHA::7}`; `deploy.sh` computes the same, never `git rev-parse --short`, which git lengthens in a large repository). Compose image references become `:${IMAGE_TAG:-latest}`. After a recreate, `deploy.sh` writes exactly one `IMAGE_TAG=sha-…` line into the host `.env` (backup first, atomic replace, every other line kept), so the daily drift check and any later manual compose command render the deployed tag instead of `:latest`. The tag is global: after a partial deploy, the services not named render the new tag and show as stale until they are deployed.
2. **The host tree is a clean checkout of that commit.** Host-only files are an explicit allowlist. The data directories are gitignored. The compose project name is pinned (`name: open-brain`) so a renamed directory cannot orphan volumes.
3. **`scripts/deploy.sh <sha> <services>`** runs, in order: argument refusals; root check; fetch and resolve the commit; `scripts/preflight.sh --ref <sha>` (log plugin, external networks, `TAILSCALE_IP`, `.env.secrets`, bind sources, `model_aliases.json`); a clean-tree check against the allowlist; a registry check that every named service's `sha-*` image exists; the config gate on the commit's compose read from git, which asserts the 13 known services and that Postgres and Redis render as raw binds whose sources equal the running containers' mounts. Only then does it check out the commit (`--detach`, never `-f`), run the drift check against it (layers `file` and `tree`; `UNDEPLOYED` is the one finding expected before a deploy), repeat the config gate on the checked-out tree, `pull`, recreate **named application services only** (`up -d --force-recreate --no-deps`), set `IMAGE_TAG` in `.env`, and verify health, the revision label, and optional markers inside the running containers. A failure after the checkout prints the command that returns the tree to the previous commit. `--dry-run` changes nothing; `--tree-only` moves the tree, runs every gate, records, and recreates nothing (it leaves `IMAGE_TAG` alone, because no container was made from a new image); `--allow-unlabeled` skips only the label check, for a rollback to a commit built before the label existed.
4. **The script refuses stateful services.** Postgres, Redis, and the tunnel are recreated one at a time, by hand, in a planned window, after a same-hour backup.
5. **`DEPLOYED.json`** (gitignored, on the host allowlist) records the commit, the image tag, the UTC time, the services recreated, the image ID and repository digest of all 13 containers, the schema-ledger maximum, and a hand-kept `cloudflare_workers` field that the script preserves. It is written only after verification passes, by temp file and rename. The same record is appended as one line to `${BACKUP_ROOT}/deploy-log.jsonl`, inside the backup tree, so a restored host knows what it was running.
6. **Drift is checked on four layers** each day: compose file text, each service's rendered config hash against the running container's label, the working tree against the allowlist (plus `UNDEPLOYED` when code or config outside `docs/` and `*.md` changed between the `DEPLOYED.json` commit and `main`), and the alert rules. The check runs git with an explicit `safe.directory` so it works as root in a tree owned by another user.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| **Continuous deployment from GitHub Actions** (a self-hosted runner or an SSH step deploys on every merge) | Puts a deploy credential for the home network into a public repository's CI, and removes the human check before a recreate on a host with one copy of the data. The failure being fixed is "nobody can say what is running", which a manifest fixes without that exposure. Can be revisited once `deploy.sh` has a record of safe runs. |
| **Pull-based auto-update (for example Watchtower)** | Recreates on a schedule with no config gate and no bind assertion — the exact operation the project's rules forbid for Postgres and Redis. It also updates images without updating the compose file or config they depend on. |
| **Keep the hand-run procedure; improve the runbook** | The runbook already described the safe procedure. It drifted, and one section described a "normal deploy" that would have recreated two stateful services. Prose does not enforce order. |
| **Bake `config/` and compose into the images** | Removes one of the four moving parts but breaks the hot-reload of `config/ai-routing.yaml` and the host-only config files that hold financial data by design. |

## Consequences

**Positive**
- "What is running?" has one answer, in one file, that survives a restore.
- A merged change that was never deployed shows up in the daily drift check as a difference between `main` and `DEPLOYED.json`.
- The unsafe operations (unscoped `up`, a recreate with a named-volume render) are refused by the tool.

**Negative**
- The first run requires reconciling the host tree in place — the riskiest single step in the remediation plan. It is preceded by a root-only snapshot of every modified and untracked path.
- Deploys stay manual: one command, run by the owner. Four dormant months showed that manual deploys do not happen; the daily drift alert is the mitigation, and it is only as good as ADR-0005's alert path.
- Image references by commit mean a rollback is "deploy the previous commit", which requires that commit's images to still exist in the registry.

**Neutral**
- Cloudflare workers are deployed with `wrangler` and are outside this mechanism; their deployed version is recorded in the manifest by hand.
