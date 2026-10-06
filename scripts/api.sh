#!/usr/bin/env bash
# Start / stop / restart the built API by PID file.
#
# Matching on the command line (pgrep -f dist/main.js) also matches the shell
# running this script, so a PID file is the only way to stop the server
# without taking the caller down with it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="${ROOT}/.api.pid"
LOG_FILE="${API_LOG:-${ROOT}/.api.log}"
PORT="${API_PORT:-4000}"

stop_api() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 0.25
      done
      kill -9 "${pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi
}

start_api() {
  stop_api
  cd "${ROOT}/apps/api"
  nohup node dist/main.js >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
      echo "api listening on ${PORT} (pid $(cat "${PID_FILE}"), log ${LOG_FILE})"
      return 0
    fi
    sleep 0.5
  done
  echo "api failed to become healthy; last log lines:" >&2
  tail -30 "${LOG_FILE}" >&2
  return 1
}

case "${1:-start}" in
  start) start_api ;;
  stop) stop_api && echo 'api stopped' ;;
  restart) start_api ;;
  status)
    if curl -fsS -m 2 "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
      echo "api up on ${PORT}"
    else
      echo "api down"
      exit 1
    fi
    ;;
  logs) tail -n "${2:-60}" "${LOG_FILE}" ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs [n]}" >&2
    exit 2
    ;;
esac
