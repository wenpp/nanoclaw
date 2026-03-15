#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /mnt/d/python_project/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/mnt/d/python_project/nanoclaw"

# Stop existing instance if running
if [ -f "/mnt/d/python_project/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/mnt/d/python_project/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/mnt/d/python_project/nanoclaw/dist/index.js" \
  >> "/mnt/d/python_project/nanoclaw/logs/nanoclaw.log" \
  2>> "/mnt/d/python_project/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/mnt/d/python_project/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /mnt/d/python_project/nanoclaw/logs/nanoclaw.log"
