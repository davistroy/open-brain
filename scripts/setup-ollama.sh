#!/usr/bin/env bash
# Setup script for Ollama container — pull the Gemma 4 12B quantized model.
# Run once after first `docker compose up` when the Ollama container is healthy.
#
# Usage:
#   ./scripts/setup-ollama.sh
#
# Prerequisites:
#   - Ollama container must be running and healthy
#   - Run from the open-brain project root (where docker-compose.yml lives)

set -euo pipefail

MODEL="gemma4:12b-q4_K_M"

echo "Pulling ${MODEL} into Ollama container..."
docker compose exec ollama ollama pull "${MODEL}"

echo ""
echo "Verifying model availability..."
docker compose exec ollama ollama list

echo ""
echo "Model pull complete. Verify with:"
echo "  curl http://localhost:11434/v1/models"
