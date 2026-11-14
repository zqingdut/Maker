#!/bin/sh
# The program launchd actually runs. `install-service.sh` points the plist at
# this file rather than at `run.sh` directly, because launchd hands a process
# almost nothing: no shell rc files, no PATH from your terminal, and none of the
# variables you exported interactively.
#
# So this script's job is to reconstruct the environment a hand-run instance
# would have had, then hand off to `run.sh` with `exec` so launchd keeps
# tracking one PID (and so SIGTERM from `launchctl bootout` reaches uvicorn).
#
# Secrets are read from disk, never baked into the plist. Resolution order, most
# explicit first:
#
#   1. deploy/image-gateway.env   (gitignored, chmod 600 -- see the .example)
#   2. data/access-token      (where a hand-run instance already keeps it)
#   3. data/device-id         (same)
#
# The plist is world-readable by design (it lives in ~/Library/LaunchAgents and
# is reviewable), which is exactly why nothing sensitive belongs in it.

set -eu

# Resolve the project root from this script's own location. `WorkingDirectory`
# is set in the plist too, but a service should not depend on that being right:
# if it is wrong, `run.sh`'s relative `.venv` probe silently misses.
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROJECT_DIR=$(dirname -- "$SELF_DIR")

ENV_FILE="$SELF_DIR/image-gateway.env"
if [ -f "$ENV_FILE" ]; then
  # `set -a` exports every assignment the file makes. The file is ours and is
  # not world-readable, so this is a config load, not a code execution surface.
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Fall back to the files a hand-run instance already uses, so switching to the
# service does not require copying secrets anywhere new.
if [ -z "${IMAGE_GATEWAY_ACCESS_TOKEN:-}" ] && [ -f "$PROJECT_DIR/data/access-token" ]; then
  IMAGE_GATEWAY_ACCESS_TOKEN=$(tr -d '\r\n' < "$PROJECT_DIR/data/access-token")
  export IMAGE_GATEWAY_ACCESS_TOKEN
fi
if [ -z "${IMAGE_GATEWAY_DEVICE_ID:-}" ] && [ -f "$PROJECT_DIR/data/device-id" ]; then
  IMAGE_GATEWAY_DEVICE_ID=$(tr -d '\r\n' < "$PROJECT_DIR/data/device-id")
  export IMAGE_GATEWAY_DEVICE_ID
fi

# --- refuse to run an open gateway -------------------------------------------
# A hand-run instance that is missing its token is a mistake you notice. A
# launchd instance is a listener that stays open across reboots, and every call
# it accepts spends real upstream quota. So this is a hard stop, not a warning.
gateway_on=0
case "${IMAGE_GATEWAY_GATEWAY_ENABLED:-true}" in
  1 | true | True | TRUE | yes | on) gateway_on=1 ;;
esac

if [ "$gateway_on" = 1 ] && [ -z "${IMAGE_GATEWAY_ACCESS_TOKEN:-}" ]; then
  {
    echo "image-gateway: refusing to start -- the gateway is enabled but"
    echo "IMAGE_GATEWAY_ACCESS_TOKEN is empty, so POST /v1/images would be open to"
    echo "anything that can reach the port, and every call spends real quota."
    echo
    echo "Fix one of:"
    echo "  cp $SELF_DIR/image-gateway.env.example $ENV_FILE"
    echo "  printf 'IMAGE_GATEWAY_ACCESS_TOKEN=%s\\n' \"\$(openssl rand -hex 24)\" >> $ENV_FILE"
    echo "  chmod 600 $ENV_FILE"
    echo
    echo "or set IMAGE_GATEWAY_GATEWAY_ENABLED=false to run the mock/relay only."
  } >&2
  # 78 is EX_CONFIG. A non-zero exit with KeepAlive.SuccessfulExit=false means
  # launchd will retry, so fixing the config brings the service up by itself.
  exit 78
fi

# --- a banner that says what actually started --------------------------------
# Goes to launchd's stderr log. Deliberately prints no secret material: only
# whether each credential is present.
{
  echo "image-gateway: starting"
  echo "  project    $PROJECT_DIR"
  echo "  python     ${IMAGE_GATEWAY_PYTHON:-<run.sh will probe .venv, then python3>}"
  echo "  listen     ${IMAGE_GATEWAY_HOST:-127.0.0.1}:${IMAGE_GATEWAY_PORT:-4399}"
  echo "  mode       ${IMAGE_GATEWAY_MODE:-mock}  (relay paths only; the gateway ignores this)"
  echo "  gateway    $([ "$gateway_on" = 1 ] && echo enabled || echo disabled)"
  echo "  upstream   ${IMAGE_GATEWAY_UPSTREAM:-<unset: gateway returns 503 no_upstream>}"
  echo "  token      $([ -n "${IMAGE_GATEWAY_ACCESS_TOKEN:-}" ] && echo set || echo MISSING)"
  echo "  device id  $([ -n "${IMAGE_GATEWAY_DEVICE_ID:-}" ] && echo set || echo MISSING)"
} >&2

# run.sh probes ./.venv relative to the cwd, so be in the right place.
cd "$PROJECT_DIR"

exec "$PROJECT_DIR/run.sh"
