#!/bin/bash
# Connect standalone containers to the Open Brain Docker network.
# Run after every: docker compose up -d
#
# Ollama and Gitea run as standalone containers outside docker-compose
# (Unraid community applications — D31 decision: not moving into compose).
# Compose recreates the bridge network on every `up`, so these containers
# must be re-connected each time.
#
# NOTE: Loki, Prometheus, Grafana, and Pushgateway are NOT handled here.
# They are managed via the observability compose profile (P12):
#   docker compose --profile observability up -d
# See docs/runbooks/observability.md for the full bring-up procedure.

set -euo pipefail

NETWORK="open-brain_open-brain"

# Verify the network exists (compose must be up first)
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "ERROR: Network $NETWORK does not exist. Run 'docker compose up -d' first."
  exit 1
fi

ERRORS=0

for CONTAINER in ollama Gitea; do
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    if docker network connect "$NETWORK" "$CONTAINER" 2>/dev/null; then
      echo "OK: Connected $CONTAINER to $NETWORK"
    else
      # Already connected (docker network connect returns non-zero if already attached)
      echo "OK: $CONTAINER already connected to $NETWORK"
    fi
  else
    echo "WARNING: $CONTAINER container not found — skipping"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  echo "$ERRORS container(s) not found. Verify they are running with 'docker ps'."
  exit 1
fi

echo ""
echo "All standalone containers connected to $NETWORK."
