#!/usr/bin/env bash
# Silent unless the effects outbox needs a human.
#
# Cron copies this to $HERMES_HOME/scripts/ and runs it with no_agent, so its
# stdout is delivered verbatim and empty stdout is a silent tick. Cron also
# strips provider credentials from the environment, which is why this reads the
# approvals app's health endpoint rather than the database.
#
# No -f on curl: a 200 or a 503 both carry a JSON body worth reading (health.ts
# answers 503, not a connection failure, when the app is unhealthy), so only a
# connection error or timeout falls into the "not answering" branch below. A
# response with no recognizable body — the 500 catch-all or a 404 — has no
# "failed"/"needs_review" counts either, so it falls into the same branch.
set -uo pipefail

HEALTH_URL="${APPROVALS_HEALTH_URL:-http://approvals:8787/healthz}"

body="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null)" || {
  echo "Approvals app is not answering on ${HEALTH_URL}. Slack approvals and file delivery are stopped until it is back."
  exit 0
}

failed="$(printf '%s' "$body" | sed -n 's/.*"failed":\([0-9]*\).*/\1/p')"
review="$(printf '%s' "$body" | sed -n 's/.*"needs_review":\([0-9]*\).*/\1/p')"

if [ -z "$failed" ] || [ -z "$review" ]; then
  echo "Approvals app is not answering on ${HEALTH_URL}. Slack approvals and file delivery are stopped until it is back."
  exit 0
fi

if [ "$failed" -eq 0 ] && [ "$review" -eq 0 ]; then
  # Healthy: say nothing at all.
  exit 0
fi

echo "Effects outbox needs a human: ${failed} failed, ${review} awaiting review."
echo "Check the sink before resolving anything — a parked row does not mean nothing was sent."
echo "See the 'Effects outbox' section of docs/runbook.md."
