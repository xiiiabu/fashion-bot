#!/usr/bin/env bash
# Start/stop the operator panel by PID file.
#
# Two traps this avoids:
#   - `pkill -f "next start"` matches the shell running it, so the command kills
#     itself and reports exit 144. A PID file is unambiguous.
#   - `npx next start` forks a `next-server` child that outlives its parent, so
#     killing the recorded PID alone leaves port 3000 held by an orphan. The
#     server is started in its own process group with setsid and the whole group
#     is signalled on stop.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/admin"
PID_FILE="$ROOT/.admin.pid"
LOG_FILE="$ROOT/.admin.log"
PORT="${ADMIN_PORT:-3001}"

running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    # Negative PID signals the whole process group, which is where the
    # next-server child lives.
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..40}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -KILL "-$pid" 2>/dev/null || true
    echo "admin stopped (pgid $pid)"
    rm -f "$PID_FILE"
  else
    echo "admin not running"
  fi
  # Belt and braces: whatever still holds the port goes too, so a restart never
  # fails with EADDRINUSE because of an earlier orphan.
  if curl -fsS --noproxy '*' -o /dev/null --max-time 2 "http://localhost:$PORT/" 2>/dev/null; then
    "$ROOT/scripts/kill-port.py" "$PORT" || true
  fi
}

start() {
  if running; then
    echo "admin already running (pid $(cat "$PID_FILE"))"
    return 0
  fi
  cd "$APP"
  setsid npx next start --port "$PORT" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in {1..60}; do
    if curl -fsS --noproxy '*' -o /dev/null "http://localhost:$PORT/"; then
      echo "admin listening on $PORT (pid $(cat "$PID_FILE"), log $LOG_FILE)"
      return 0
    fi
    sleep 0.5
  done
  echo "admin did not come up; see $LOG_FILE" >&2
  tail -20 "$LOG_FILE" >&2
  return 1
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  build)
    cd "$APP"
    rm -rf .next
    npx next build
    ;;
  status)
    if running; then echo "running (pid $(cat "$PID_FILE"))"; else echo "stopped"; fi
    ;;
  logs) tail -n "${2:-40}" "$LOG_FILE" ;;
  *)
    echo "usage: $0 {start|stop|restart|build|status|logs [n]}" >&2
    exit 64
    ;;
esac
