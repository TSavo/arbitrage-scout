#!/bin/bash
# Daily supervisor — sleeps until the next scheduled run (13:00 UTC =
# 06:00 PT), invokes daily-scan.sh, then repeats. Replaces docker
# restart-policy-as-a-scheduler.
#
# Target hour configurable via DAILY_HOUR_UTC (default 13).

set -e

HOUR="${DAILY_HOUR_UTC:-13}"

while true; do
  now=$(date -u +%s)
  # Next run: today at HOUR:00 UTC, or tomorrow if past.
  todays_run=$(date -u -d "today ${HOUR}:00:00" +%s 2>/dev/null \
    || date -u -d "$(date -u +%Y-%m-%d) ${HOUR}:00:00" +%s)
  if [ "$now" -ge "$todays_run" ]; then
    target=$(date -u -d "tomorrow ${HOUR}:00:00" +%s)
  else
    target=$todays_run
  fi
  sleep_for=$((target - now))
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] UTC — sleeping ${sleep_for}s (until $(date -u -d @$target +'%Y-%m-%d %H:%M:%S') UTC)"
  sleep "$sleep_for"
  echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] UTC — launching daily-scan.sh"
  bash bin/daily-scan.sh || echo "[$(date -u +'%Y-%m-%d %H:%M:%S')] UTC — daily-scan.sh exited non-zero; continuing"
done
