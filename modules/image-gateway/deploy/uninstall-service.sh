#!/bin/bash
# Stop and remove the image-gateway service. Works on macOS (launchd) and Linux
# (systemd); the platform is chosen by uname.
#
#   ./deploy/uninstall-service.sh            # stop it, remove the unit
#   ./deploy/uninstall-service.sh --purge    # also delete data/logs
#
# Removing the service does not touch your data: images under data/files, the
# gateway token in data/access-token and deploy/image-gateway.env all stay put, so
# re-installing picks up exactly where you left off. That is deliberate -- an
# uninstall should never be the step that loses a credential or your library.

set -eu

# Same reason as install-service.sh: `/dev/tcp` is bash-only, and under dash
# (`sh` on Ubuntu) the probe below fails every time -- which here means "the
# port is still open" is reported for a service that is already gone.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  printf '%s\n' \
    "uninstall-service.sh: this script needs bash (it probes the port via /dev/tcp)." \
    "  re-run it as: bash $0 $*" >&2
  exit 1
fi

SERVICE_NAME="image-gateway"
LAUNCHD_LABEL="com.imagegateway.relay"
PURGE=0

usage() {
  cat <<'USAGE'
Remove the image-gateway service.

  --purge     also delete data/logs (the launchd stdout/stderr files)
  -h, --help  this text

Removes whichever of the user-scope and system-scope units exist. System-scope
units live outside your home directory, so sudo is requested for those.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "uninstall-service.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
PROJECT_DIR=$(dirname -- "$SELF_DIR")
LOG_DIR="$PROJECT_DIR/data/logs"

case "${IMAGE_GATEWAY_PLATFORM:-$(uname -s)}" in
  launchd | Darwin) PLATFORM="launchd" ;;
  systemd | Linux) PLATFORM="systemd" ;;
  *)
    echo "uninstall-service.sh: unsupported platform: $(uname -s)" >&2
    echo "  remove the unit your init system uses by hand." >&2
    exit 1
    ;;
esac

SUDO=""
if [ "$(id -u)" != 0 ]; then SUDO="sudo"; fi

# Bash's own /dev/tcp: no curl, no nc.
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

removed_any=0

if [ "$PLATFORM" = "launchd" ]; then
  remove_one() {
    domain="$1"
    plist="$2"
    [ -f "$plist" ] || return 0

    if ! $SUDO launchctl bootout "$domain/$LAUNCHD_LABEL" >/dev/null 2>&1; then
      # bootout also reports failure when the job is loaded but not running,
      # and does not exist on very old systems. Neither is fatal here.
      $SUDO launchctl unload -w "$plist" >/dev/null 2>&1 || true
    fi
    echo "stopped       $domain/$LAUNCHD_LABEL"

    if $SUDO rm -f "$plist" 2>/dev/null; then
      echo "removed       $plist"
      removed_any=1
    else
      echo "could not remove $plist" >&2
    fi
  }

  remove_one "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  remove_one "system" "/Library/LaunchDaemons/$LAUNCHD_LABEL.plist"

else
  remove_one() {
    scope="$1"
    unit="$2"

    if [ "$scope" = "system" ]; then
      CTL="$SUDO systemctl"
    else
      CTL="systemctl --user"
    fi

    # Nothing to do if the unit is not installed. `systemctl` would happily
    # report "Unit not loaded" as a failure, which reads like a real problem.
    [ -f "$unit" ] || return 0

    # disable stops it starting at boot; --now also stops the running instance.
    $CTL disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
    echo "stopped       $SERVICE_NAME.service ($scope)"

    if $SUDO rm -f "$unit" 2>/dev/null; then
      echo "removed       $unit"
      removed_any=1
    else
      echo "could not remove $unit" >&2
    fi

    $CTL daemon-reload >/dev/null 2>&1 || true
  }

  remove_one "user" "$HOME/.config/systemd/user/$SERVICE_NAME.service"
  remove_one "system" "/etc/systemd/system/$SERVICE_NAME.service"
fi

if [ "$removed_any" = 0 ]; then
  echo "nothing to remove: no $SERVICE_NAME unit found"
fi

# Give the process a moment to release the port, then say so plainly: a port
# still held after "uninstalled" is exactly the kind of thing that makes
# someone think the script lied.
sleep 1
if port_open 4399; then
  holder=""
  if command -v lsof >/dev/null 2>&1; then
    holder=$(lsof -nP -iTCP:4399 -sTCP:LISTEN -t 2>/dev/null | head -1 || true)
  elif command -v ss >/dev/null 2>&1; then
    holder=$(ss -ltnpH "sport = :4399" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
  fi
  echo ""
  echo "note: port 4399 is still open${holder:+ (PID $holder)} and is not this service:"
  [ -n "$holder" ] && echo "  $(ps -o command= -p "$holder" 2>/dev/null | cut -c1-120)"
  [ -n "$holder" ] && echo "  kill $holder"
fi

if [ "$PURGE" = 1 ]; then
  if [ -d "$LOG_DIR" ]; then
    rm -rf "$LOG_DIR"
    echo "purged        $LOG_DIR"
  fi
else
  [ -d "$LOG_DIR" ] && {
    echo ""
    echo "logs kept at  $LOG_DIR  (--purge to delete)"
  }
fi

echo "data kept at  $PROJECT_DIR/data  (never touched by this script)"
