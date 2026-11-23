# ADR-0006: Deployed State Derives from One Commit and Is Recorded in a Manifest

**Status:** Proposed
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

1. **Images name their commit.** `build-images.yml` adds the label `org.opencontainers.image.revision` and pushes a `sha-<commit>` tag. Compose image references become `:${IMAGE_TAG:-latest}`.
2. **The host tree is a clean checkout of that commit.** Host-only files are an explicit allowlist. The data directories are gitignored. The compose project name is pinned (`name: open-brain`) so a renamed directory cannot orphan volumes.
3. **`scripts/deploy.sh <sha>`** runs, in order: a preflight (log plugin, external networks, required variables, bind sources); a clean-tree check against the allowlist; the drift check; the config gate, which asserts that Postgres and Redis render as raw binds whose sources equal the running containers' mounts; `pull` of the `sha-*` tags; a recreate of **named application services only**; and a marker check inside the running container.
4. **The script refuses stateful services.** Postgres, Redis, and the tunnel are recreated one at a time, by hand, in a planned window, after a same-hour backup.
5. **`DEPLOYED.json`** records the commit, each service's image digest, and the schema-ledger maximum. An append-only deploy log is written inside the backup tree, so a restored host knows what it was running.
6. **Drift is checked on four layers** each day: compose file text, each service's rendered config hash against the running container's label, the working tree against the allowlist, and the alert rules. The check runs git with an explicit `safe.directory` so it works as root in a tree owned by another user.

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
