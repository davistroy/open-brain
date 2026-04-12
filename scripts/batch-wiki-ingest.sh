#!/usr/bin/env bash
#
# batch-wiki-ingest.sh — Wrapper for the Python batch wiki-ingest orchestrator.
#
# Provides a convenient CLI with defaults for the Open Brain file migration
# pipeline. Checks prerequisites, activates the Python environment if available,
# and delegates to batch-wiki-ingest.py.
#
# Usage:
#   ./scripts/batch-wiki-ingest.sh                        # Process all domains
#   ./scripts/batch-wiki-ingest.sh --domain technical     # Single domain
#   ./scripts/batch-wiki-ingest.sh --dry-run              # Simulate only
#   ./scripts/batch-wiki-ingest.sh --report-only          # Show status report
#   ./scripts/batch-wiki-ingest.sh --batch-size 10 --max-files 50
#
# Environment variables (all optional, CLI flags override):
#   OPENBRAIN_DB         Path to inventory SQLite database
#   OPENBRAIN_API_URL    Core API URL (default: http://localhost:3002)
#   BATCH_SIZE           Files per checkpoint batch (default: 25)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Defaults (overridable via env vars or CLI flags)
# ---------------------------------------------------------------------------
DB="${OPENBRAIN_DB:-/mnt/user/openbrain/inventory.db}"
API_URL="${OPENBRAIN_API_URL:-http://localhost:3002}"
BATCH_SIZE="${BATCH_SIZE:-25}"
DOMAIN=""
MAX_FILES=""
DRY_RUN=""
SKIP_LINT=""
REPORT_ONLY=""

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --db)
            DB="$2"; shift 2 ;;
        --api-url)
            API_URL="$2"; shift 2 ;;
        --domain)
            DOMAIN="$2"; shift 2 ;;
        --batch-size)
            BATCH_SIZE="$2"; shift 2 ;;
        --max-files)
            MAX_FILES="$2"; shift 2 ;;
        --dry-run)
            DRY_RUN="--dry-run"; shift ;;
        --skip-lint)
            SKIP_LINT="--skip-lint"; shift ;;
        --report-only)
            REPORT_ONLY="--report-only"; shift ;;
        --help|-h)
            echo "Usage: $(basename "$0") [OPTIONS]"
            echo ""
            echo "Batch wiki-ingest orchestrator for Open Brain file migration."
            echo ""
            echo "Options:"
            echo "  --db PATH          Inventory SQLite database (default: /mnt/user/openbrain/inventory.db)"
            echo "  --api-url URL      Core API URL (default: http://localhost:3002)"
            echo "  --domain NAME      Process only this domain (category)"
            echo "  --batch-size N     Files per checkpoint (default: 25)"
            echo "  --max-files N      Max files per domain (for testing)"
            echo "  --dry-run          Simulate without API calls"
            echo "  --skip-lint        Skip wiki-lint after each domain"
            echo "  --report-only      Show status report, no processing"
            echo "  --help, -h         Show this help"
            echo ""
            echo "Environment variables:"
            echo "  OPENBRAIN_DB       Same as --db"
            echo "  OPENBRAIN_API_URL  Same as --api-url"
            echo "  BATCH_SIZE         Same as --batch-size"
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            echo "Use --help for usage." >&2
            exit 1
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v python3 &>/dev/null; then
    echo "ERROR: python3 not found in PATH" >&2
    exit 1
fi

# Check that requests is available
if ! python3 -c "import requests" 2>/dev/null; then
    echo "ERROR: Python 'requests' package not installed." >&2
    echo "  Run: pip install requests" >&2
    exit 1
fi

if [[ ! -f "$DB" ]] && [[ -z "$REPORT_ONLY" ]]; then
    echo "ERROR: Inventory database not found: $DB" >&2
    echo "  Run file-inventory.py first, or set OPENBRAIN_DB / --db" >&2
    exit 1
fi

# Quick API connectivity check (skip for report-only and dry-run)
if [[ -z "$REPORT_ONLY" ]] && [[ -z "$DRY_RUN" ]]; then
    if ! curl -sf "${API_URL}/health" >/dev/null 2>&1; then
        # /health is Docker-internal only; try captures endpoint
        if ! curl -sf "${API_URL}/api/v1/captures?limit=1" \
             -H "X-Open-Brain-Caller: batch-wiki-ingest" >/dev/null 2>&1; then
            echo "WARNING: Cannot reach core-api at ${API_URL}" >&2
            echo "  Proceeding anyway — the Python script will report connection errors." >&2
        fi
    fi
fi

# ---------------------------------------------------------------------------
# Build command
# ---------------------------------------------------------------------------
CMD=(
    python3 "$SCRIPT_DIR/batch-wiki-ingest.py"
    --db "$DB"
    --api-url "$API_URL"
    --batch-size "$BATCH_SIZE"
)

[[ -n "$DOMAIN" ]]      && CMD+=(--domain "$DOMAIN")
[[ -n "$MAX_FILES" ]]    && CMD+=(--max-files "$MAX_FILES")
[[ -n "$DRY_RUN" ]]      && CMD+=($DRY_RUN)
[[ -n "$SKIP_LINT" ]]    && CMD+=($SKIP_LINT)
[[ -n "$REPORT_ONLY" ]]  && CMD+=($REPORT_ONLY)

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "=== Open Brain Batch Wiki-Ingest ==="
echo "Database:   $DB"
echo "API URL:    $API_URL"
echo "Batch size: $BATCH_SIZE"
[[ -n "$DOMAIN" ]]      && echo "Domain:     $DOMAIN"
[[ -n "$MAX_FILES" ]]    && echo "Max files:  $MAX_FILES"
[[ -n "$DRY_RUN" ]]      && echo "Mode:       DRY RUN"
[[ -n "$REPORT_ONLY" ]]  && echo "Mode:       REPORT ONLY"
echo "==================================="
echo ""

exec "${CMD[@]}"
