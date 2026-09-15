#!/usr/bin/env bash
# Install the demo-practice playbooks into the Hermes cron fleet.
#
# Run inside the hermes container:
#   docker compose -f harness/compose/docker-compose.yml exec hermes \
#     bash /opt/data/cron/playbooks.sh
#
# Idempotent: a job whose --name already exists is left alone, so re-running
# after a redeploy neither duplicates jobs nor resets their schedules. The
# record format of ~/.hermes/cron/jobs.json is not documented, so jobs are
# always created through the CLI and never by writing that file.
set -euo pipefail

: "${SLACK_HOME_CHANNEL:?SLACK_HOME_CHANNEL must be set}"

have_job() {
  hermes cron list 2>/dev/null | grep -Fq "$1"
}

install_job() {
  local name="$1"
  shift
  if have_job "$name"; then
    echo "playbooks: '$name' already exists, leaving it alone"
    return 0
  fi
  echo "playbooks: creating '$name'"
  hermes cron create "$@" --name "$name"
}

# 1. Nightly renewal watch. The skill stages its own Slack message through
#    harness_notify, so the job delivers nothing itself: an empty night is a
#    silent tick and a busy night is exactly one message.
install_job "credentialing-expirations" \
  "0 7 * * *" \
  "Run the credentialing-expirations playbook for today. Follow the skill exactly, including its silence rule." \
  --skill credentialing-expirations \
  --deliver local

# 2. Outbox watchdog. Script only, no model: it prints nothing when the
#    dispatcher is healthy, and empty stdout is a silent tick.
install_job "harness-outbox-watchdog" \
  "*/15 * * * *" \
  --no-agent \
  --script harness-outbox-watchdog.sh \
  --deliver "slack:${SLACK_HOME_CHANNEL}"

# 3. Reconcile watchdog. Same shape, slower cadence: it complains only when the
#    approvals app has not run a reconcile pass recently.
install_job "harness-reconcile-watchdog" \
  "17 */6 * * *" \
  --no-agent \
  --script harness-reconcile-watchdog.sh \
  --deliver "slack:${SLACK_HOME_CHANNEL}"

echo "playbooks: done"
hermes cron list
