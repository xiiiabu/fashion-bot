#!/usr/bin/env bash
# Start / stop / restart the bot by PID file and process group.
#
# Same two traps as the other service scripts: a pattern-matching pkill also
# matches the shell running it, and a wrapper process can outlive its parent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${ROOT}/apps/bot"
PID_FILE="${ROOT}/.bot.pid"
LOG_FILE="${ROOT}/.bot.log"
PORT="${BOT_PORT:-4100}"

running() {
  [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null
}

stop_bot() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    # SIGTERM to the group: the bot releases its claimed notifications and
    # closes the Telegram connection on the way out.
    kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "${pid}" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "-${pid}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    echo "bot stopped"
  else
    echo "bot not running"
  fi
}

start_bot() {
  if running; then
    echo "bot already running (pid $(cat "${PID_FILE}"))"
    return 0
  fi
  cd "${APP}"
  setsid node dist/main.js >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"
  for _ in $(seq 1 40); do
    if curl -fsS --noproxy '*' -m 2 "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
      echo "bot running (pid $(cat "${PID_FILE}"), log ${LOG_FILE})"
      return 0
    fi
    sleep 0.5
  done
  echo "bot did not become healthy; last log lines:" >&2
  tail -25 "${LOG_FILE}" >&2
  return 1
}

case "${1:-status}" in
  start) start_bot ;;
  stop) stop_bot ;;
  restart) stop_bot; start_bot ;;
  status)
    if running; then
      curl -fsS --noproxy '*' "http://localhost:${PORT}/healthz" 2>/dev/null || echo "running (pid $(cat "${PID_FILE}"))"
      echo
    else
      echo "stopped"
    fi
    ;;
  logs) tail -n "${2:-40}" "${LOG_FILE}" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [n]}" >&2
    exit 64
    ;;
esac
