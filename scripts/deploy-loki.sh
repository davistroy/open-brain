#!/usr/bin/env bash
# deploy-loki.sh — Deploy Loki for log aggregation on homeserver
#
# Run from the Open Brain deploy directory on homeserver:
#   cd /mnt/user/appdata/open-brain && bash scripts/deploy-loki.sh
#
# Prerequisites:
#   - Docker running
#   - Grafana running on port 3050 (already deployed)
#   - open-brain_open-brain Docker network exists (from docker-compose up)

set -euo pipefail

LOKI_CONTAINER="loki"
LOKI_IMAGE="grafana/loki:latest"
LOKI_DATA_DIR="/mnt/user/appdata/loki"
LOKI_CONFIG="$(pwd)/config/loki/loki-config.yaml"
LOKI_PORT="3100"
DOCKER_NETWORK="open-brain_open-brain"
GRAFANA_URL="http://localhost:3050"

echo "=== Loki Deployment for Open Brain ==="
echo ""

# ── Step 1: Check prerequisites ──────────────────────────────────────────────

if ! docker info > /dev/null 2>&1; then
  echo "ERROR: Docker is not running or not accessible."
  exit 1
fi

if ! docker network inspect "$DOCKER_NETWORK" > /dev/null 2>&1; then
  echo "ERROR: Docker network '$DOCKER_NETWORK' does not exist."
  echo "       Run 'docker compose up -d' first to create the network."
  exit 1
fi

if [ ! -f "$LOKI_CONFIG" ]; then
  echo "ERROR: Loki config not found at $LOKI_CONFIG"
  echo "       Run this script from the open-brain deploy directory."
  exit 1
fi

# ── Step 2: Install Loki Docker log driver plugin ────────────────────────────

echo "[1/5] Checking Loki Docker log driver plugin..."
if docker plugin ls --format '{{.Name}}' 2>/dev/null | grep -q "loki"; then
  echo "       Loki Docker log driver already installed."
else
  echo "       Installing Loki Docker log driver plugin..."
  docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
  echo "       Loki Docker log driver installed."
fi

# ── Step 3: Create data directory ────────────────────────────────────────────

echo "[2/5] Ensuring data directory exists at $LOKI_DATA_DIR..."
mkdir -p "$LOKI_DATA_DIR"

# ── Step 4: Deploy Loki container ────────────────────────────────────────────

echo "[3/5] Deploying Loki container..."

if docker ps -a --format '{{.Names}}' | grep -q "^${LOKI_CONTAINER}$"; then
  echo "       Stopping and removing existing Loki container..."
  docker stop "$LOKI_CONTAINER" 2>/dev/null || true
  docker rm "$LOKI_CONTAINER" 2>/dev/null || true
fi

docker run -d \
  --name "$LOKI_CONTAINER" \
  --network "$DOCKER_NETWORK" \
  -v "${LOKI_DATA_DIR}:/loki/data" \
  -v "${LOKI_CONFIG}:/etc/loki/local-config.yaml:ro" \
  -p "${LOKI_PORT}:3100" \
  --memory=512m \
  --restart unless-stopped \
  "$LOKI_IMAGE" \
  -config.file=/etc/loki/local-config.yaml

echo "       Loki container started."

# ── Step 5: Wait for Loki to be ready ────────────────────────────────────────

echo "[4/5] Waiting for Loki to become ready..."
RETRIES=15
for i in $(seq 1 $RETRIES); do
  if curl -sf "http://localhost:${LOKI_PORT}/ready" > /dev/null 2>&1; then
    echo "       Loki is ready."
    break
  fi
  if [ "$i" -eq "$RETRIES" ]; then
    echo "WARNING: Loki did not become ready within ${RETRIES} attempts."
    echo "         Check logs: docker logs $LOKI_CONTAINER"
  fi
  sleep 2
done

# ── Step 6: Add Loki as Grafana data source ──────────────────────────────────

echo "[5/5] Configuring Loki as Grafana data source..."

# Check if data source already exists
EXISTING=$(curl -sf "${GRAFANA_URL}/api/datasources/name/Loki" 2>/dev/null || echo "")
if echo "$EXISTING" | grep -q '"id"'; then
  echo "       Loki data source already exists in Grafana."
else
  RESULT=$(curl -sf -X POST "${GRAFANA_URL}/api/datasources" \
    -H 'Content-Type: application/json' \
    -d '{
      "name": "Loki",
      "type": "loki",
      "url": "http://loki:3100",
      "access": "proxy",
      "isDefault": false
    }' 2>&1) || true

  if echo "$RESULT" | grep -q '"id"'; then
    echo "       Loki data source added to Grafana."
  else
    echo "WARNING: Could not add Loki data source to Grafana."
    echo "         Response: $RESULT"
    echo "         You may need to add it manually in Grafana UI:"
    echo "         Configuration > Data Sources > Add > Loki > URL: http://loki:3100"
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== Loki deployment complete ==="
echo ""
echo "Loki is running at: http://localhost:${LOKI_PORT}"
echo "Grafana Explore:    ${GRAFANA_URL}/explore (select Loki data source)"
echo ""
echo "=== Next step: Configure Docker log driver for Open Brain containers ==="
echo ""
echo "Add the following logging section to each service in docker-compose.yml:"
echo ""
echo "    logging:"
echo "      driver: loki"
echo "      options:"
echo "        loki-url: \"http://localhost:${LOKI_PORT}/loki/api/v1/push\""
echo "        loki-batch-size: \"400\""
echo "        loki-retries: \"2\""
echo "        loki-timeout: \"2s\""
echo "        labels: \"container_name\""
echo ""
echo "Or apply to ALL containers via Docker daemon config (/etc/docker/daemon.json):"
echo ""
echo "  {"
echo "    \"log-driver\": \"loki\","
echo "    \"log-opts\": {"
echo "      \"loki-url\": \"http://localhost:${LOKI_PORT}/loki/api/v1/push\","
echo "      \"loki-batch-size\": \"400\","
echo "      \"loki-retries\": \"2\","
echo "      \"loki-timeout\": \"2s\","
echo "      \"labels\": \"container_name\""
echo "    }"
echo "  }"
echo ""
echo "After adding logging config, restart containers:"
echo "  docker compose down && docker compose up -d"
echo ""
