#!/usr/bin/env bash
# Silent unless reconciliation has stopped running.
#
# The approvals app calls harness_reconcile on a timer. If that timer has not
# fired within the stale window, approvals past their TTL are not being retired
# and stuck dispatches are not being parked, which is a quiet failure.
set -uo pipefail

HEALTH_URL="${APPROVALS_HEALTH_URL:-http://approvals:8787/healthz}"
STALE_MINUTES="${RECONCILE_STALE_MINUTES:-90}"

body="$(curl -fsS --max-time 10 "$HEALTH_URL" 2>/dev/null)" || {
  echo "Approvals app is not answering on ${HEALTH_URL}; reconciliation is not running."
  exit 0
}

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
