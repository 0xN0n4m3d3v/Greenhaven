#!/usr/bin/env bash
#
# Spec 50 — Live verification harness CLI wrapper.
#
# Hits /api/debug/verify-specialists on a running web-server, prints
# a compact per-specialist pass/fail/skipped summary, and exits 0 only
# when ZERO fails. Skipped is acceptable (a specialist legitimately
# didn't fire — e.g., dialogue_anchor with no active partner).
#
# Usage:
#   scripts/verify-specialists.sh                  # default localhost:7777, playerId=1000
#   GREENHAVEN_HOST=http://10.0.0.5:7777 scripts/verify-specialists.sh
#   PLAYER_ID=2000 scripts/verify-specialists.sh
#   GREENHAVEN_DEBUG_KEY=... scripts/verify-specialists.sh
#
# Requires: bash, curl, jq.

set -euo pipefail

HOST="${GREENHAVEN_HOST:-http://localhost:7777}"
PLAYER_ID="${PLAYER_ID:-1000}"
ENDPOINT="$HOST/api/debug/verify-specialists"

if ! command -v jq >/dev/null 2>&1; then
  echo "verify-specialists: jq is required (apt: sudo apt install jq; brew: brew install jq)" >&2
  exit 2
fi

echo "→ POST $ENDPOINT  (playerId=$PLAYER_ID)"
curl_headers=(-H 'content-type: application/json')
if [[ -n "${GREENHAVEN_DEBUG_KEY:-}" ]]; then
  curl_headers+=(-H "x-debug-key: $GREENHAVEN_DEBUG_KEY")
fi
RAW="$(curl -sS --max-time 90 -X POST "$ENDPOINT" \
  "${curl_headers[@]}" \
  -d "{\"playerId\":$PLAYER_ID}" || true)"

if [[ -z "$RAW" ]]; then
  echo "verify-specialists: empty response. Server up? cURL output empty." >&2
  exit 3
fi

# Validate JSON.
if ! echo "$RAW" | jq -e '.' >/dev/null 2>&1; then
  echo "verify-specialists: non-JSON response:" >&2
  echo "$RAW" | head -c 800 >&2
  echo >&2
  exit 4
fi

OK=$(echo "$RAW" | jq -r '.ok')
SUMMARY=$(echo "$RAW" | jq -r '.summary | "pass=\(.pass) skipped=\(.skipped) fail=\(.fail) total=\(.total)"')
echo "→ summary: $SUMMARY"
echo

# Print per-spec lines, padded for readability.
echo "$RAW" | jq -r '
  .verdicts[] |
  "  \(.spec)  \(.name | tostring | (. + (" " * (24 - length))))  \(.status | tostring | (. + (" " * (8 - length))))  \(.durationMs)ms  \(.notes)"
'

echo
if [[ "$OK" == "true" ]]; then
  echo "✓ all specialists healthy (no fails)"
  exit 0
else
  echo "✗ failures detected — see fail rows above" >&2
  exit 1
fi
