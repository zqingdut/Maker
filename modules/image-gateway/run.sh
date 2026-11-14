#!/bin/sh
# Start image-gateway.
#
#   ./run.sh                 # 127.0.0.1:4399
#   ./run.sh --reload        # dev, auto-restart on edit
#   IMAGE_GATEWAY_PORT=8080 ./run.sh
#
# Python resolution order: $IMAGE_GATEWAY_PYTHON, ./.venv/bin/python, python3.
set -e

PY="${IMAGE_GATEWAY_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x "./.venv/bin/python" ]; then
    PY="./.venv/bin/python"
  else
    PY="python3"
  fi
fi

HOST="${IMAGE_GATEWAY_HOST:-127.0.0.1}"
PORT="${IMAGE_GATEWAY_PORT:-4399}"

# Fail with an actionable message instead of a ModuleNotFoundError traceback.
if ! "$PY" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
  {
    echo "image-gateway: '$PY' does not have the dependencies installed."
    echo
    echo "  install them into a project-local venv:"
    echo "    $PY -m venv .venv && ./.venv/bin/pip install -r requirements.txt"
    echo
    echo "  or point IMAGE_GATEWAY_PYTHON at an interpreter that already has them:"
    echo "    IMAGE_GATEWAY_PYTHON=/path/to/python ./run.sh"
  } >&2
  exit 1
fi

# --no-server-header: we set `Server: Kestrel` ourselves to match the real
# service; letting uvicorn add its own would emit a duplicate header.
exec "$PY" -m uvicorn app.main:app \
  --host "$HOST" \
  --port "$PORT" \
  --no-server-header \
  "$@"
