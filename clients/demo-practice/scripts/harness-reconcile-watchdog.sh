#!/usr/bin/env bash
# Silent unless reconciliation has stopped running.
#
# The approvals app calls harness_reconcile on a timer. If that timer has not
# fired within the stale window, approvals past their TTL are not being retired
# and stuck dispatches are not being parked, which is a quiet failure.
#
# No -f on curl: a 200 or a 503 both carry a JSON body worth reading (health.ts
# answers 503, not a connection failure, when the app is unhealthy), so only a
# connection error or timeout falls into the "not answering" branch below. A
# response with no "lastReconcileAt" key at all — the 500 catch-all or a 404 —
# falls into the same branch; a present-but-null value (never reconciled yet)
# is a distinct, legitimate state handled below.
set -uo pipefail

HEALTH_URL="${APPROVALS_HEALTH_URL:-http://approvals:8787/healthz}"
STALE_MINUTES="${RECONCILE_STALE_MINUTES:-90}"

# Said the same way whether the request failed outright or the body carried no
# lastReconcileAt at all: both mean the same thing to the reader.
not_answering() {
  echo "Approvals app is not answering on ${HEALTH_URL}; reconciliation is not running."
  exit 0
}

body="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null)" || not_answering

if ! printf '%s' "$body" | grep -q '"lastReconcileAt"'; then
  not_answering
fi

last="$(printf '%s' "$body" | sed -n 's/.*"lastReconcileAt":"\([^"]*\)".*/\1/p')"
if [ -z "$last" ]; then
  echo "The approvals app has not completed a reconcile pass since it started. Expired approvals are not being retired."
  exit 0
fi

last_epoch="$(date -u -d "$last" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%S' "${last%.*}" +%s 2>/dev/null || echo 0)"
now_epoch="$(date -u +%s)"
age_minutes=$(( (now_epoch - last_epoch) / 60 ))

if [ "$last_epoch" -gt 0 ] && [ "$age_minutes" -lt "$STALE_MINUTES" ]; then
  # Healthy: say nothing at all.
  exit 0
fi

echo "Reconciliation last completed ${age_minutes} minutes ago (limit ${STALE_MINUTES}). Expired approvals may still look actionable."
