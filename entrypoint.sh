#!/bin/bash
set -euo pipefail

GRAFANA_PORT="${GF_SERVER_HTTP_PORT:-3000}"
CONTROL_PORT="${CONTROL_PORT:-80}"

echo "Starting Grafana on :${GRAFANA_PORT}..."
/run.sh &
GRAFANA_PID=$!

echo "Waiting for Grafana..."
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${GRAFANA_PORT}/api/health" >/dev/null 2>&1; then
    echo "Grafana is up"
    break
  fi
  if ! kill -0 "$GRAFANA_PID" 2>/dev/null; then
    echo "Grafana exited early" >&2
    wait "$GRAFANA_PID" || true
    exit 1
  fi
  sleep 2
done

echo "Starting control page (MQTT: ${MQTT_HOST:-host.docker.internal}:${MQTT_PORT:-1883}, root: ${MQTT_ROOT:-blueos}) on :${CONTROL_PORT}..."
node /app/control-ui/server.js &
CONTROL_PID=$!

shutdown() {
  echo "Shutting down..."
  kill "$CONTROL_PID" "$GRAFANA_PID" 2>/dev/null || true
  wait "$CONTROL_PID" "$GRAFANA_PID" 2>/dev/null || true
}
trap shutdown INT TERM

while kill -0 "$GRAFANA_PID" 2>/dev/null && kill -0 "$CONTROL_PID" 2>/dev/null; do
  sleep 2
done

echo "A child process exited; shutting down." >&2
shutdown
exit 1
