#!/usr/bin/env bash
# validate-alert-rules.sh — Validate Prometheus alert rule YAML files.
#
# Uses promtool when available (bundled with Prometheus binary) for full semantic
# validation. Falls back to python3 yaml.safe_load() for syntactic validation when
# promtool is not in PATH (CI without Prometheus, Windows dev).
#
# Usage:
#   bash scripts/validate-alert-rules.sh
#
# Exit codes:
#   0 — all files valid
#   1 — validation failure

set -euo pipefail

ALERTS_DIR="${1:-config/prometheus/alerts}"

if [ ! -d "$ALERTS_DIR" ]; then
  echo "ERROR: alerts directory not found: $ALERTS_DIR"
  exit 1
fi

RULE_FILES=("$ALERTS_DIR"/*.yml)
if [ "${#RULE_FILES[@]}" -eq 0 ] || [ ! -f "${RULE_FILES[0]}" ]; then
  echo "ERROR: no .yml files found in $ALERTS_DIR"
  exit 1
fi

echo "Validating ${#RULE_FILES[@]} alert rule file(s) in $ALERTS_DIR..."
echo ""

if command -v promtool > /dev/null 2>&1; then
  echo "Using: promtool check rules"
  echo ""
  for f in "${RULE_FILES[@]}"; do
    echo "  Checking $f ..."
    promtool check rules "$f"
    echo "  OK: $f"
  done
else
  echo "promtool not found — using python3 yaml.safe_load() for YAML syntax validation"
  echo "(Install Prometheus to get promtool for full semantic validation)"
  echo ""
  if ! command -v python3 > /dev/null 2>&1; then
    echo "ERROR: neither promtool nor python3 is available"
    exit 1
  fi
  for f in "${RULE_FILES[@]}"; do
    echo "  Checking $f ..."
    python3 -c "
import sys, yaml
with open(sys.argv[1]) as fh:
    doc = yaml.safe_load(fh)
    assert isinstance(doc, dict), 'top-level must be a dict'
    assert 'groups' in doc, 'missing required key: groups'
    for g in doc['groups']:
        assert 'name' in g, 'group missing name'
        assert 'rules' in g, f'group {g[\"name\"]} missing rules'
print('  OK:', sys.argv[1])
" "$f"
  done
fi

echo ""
echo "All ${#RULE_FILES[@]} alert rule file(s) valid."
