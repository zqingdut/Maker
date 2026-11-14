#!/bin/bash
# Install image-gateway as a service that survives reboot.
#
#   ./deploy/install-service.sh              # platform default (see below)
#   ./deploy/install-service.sh --user       # start at login, no root needed
#   ./deploy/install-service.sh --system     # start at boot (needs sudo)
#   ./deploy/install-service.sh --dry-run    # render everything, install nothing
#
# Two init systems are supported, chosen by uname:
#
#   macOS   launchd    --user   = LaunchAgent (~/Library/LaunchAgents, at login)
#                      --system = LaunchDaemon (/Library/LaunchDaemons, at boot)
#   Linux   systemd    --user   = user unit (~/.config/systemd/user, at login,
#                                 plus loginctl enable-linger to survive reboot)
#                      --system = system unit (/etc/systemd/system, at boot)
#
# The default scope is the one that starts at boot while asking the least of
# you: --system on Linux (normal there, and User= keeps the service running as
# you rather than as root), --user on macOS (a LaunchDaemon needs root for no
# added benefit on a laptop).
#
# Idempotent: re-running replaces the loaded service rather than stacking a
# second one. That is the intended way to pick up an edited env file.

set -eu

# `/dev/tcp` is a bash extension, and this script leans on it to decide whether
# the service came up. On Ubuntu `sh` is dash, where that probe does not fail
# loudly -- it fails *every time*, so a perfectly healthy service gets reported
# as "did NOT come up within 45s". Re-exec under bash instead of asking the
# caller to remember which shell to use.
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
  printf '%s\n' \
    "install-service.sh: this script needs bash (it probes the port via /dev/tcp)." \
    "  re-run it as: bash $0 $*" >&2
  exit 1
fi

SERVICE_NAME="image-gateway"
LAUNCHD_LABEL="com.imagegateway.relay"

SCOPE=""
DRY_RUN=0
FORCE=0

usage() {
  cat <<'USAGE'
Install image-gateway as a service.

  --user      start at login, inside your session (no root)
  --system    start at boot (sudo is requested per step, not for the whole run)
  --daemon    alias for --system
  --dry-run   render the unit and env file, print them, install nothing
  --force     proceed even if the port is already held by another process
  -h, --help  this text

Default: --system on Linux, --user on macOS.
macOS uses launchd, Linux uses systemd; the choice is made by uname.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --user) SCOPE="user" ;;
    --system | --daemon) SCOPE="system" ;;
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "install-service.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

SELF_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
PROJECT_DIR=$(dirname -- "$SELF_DIR")
ENV_FILE="$SELF_DIR/image-gateway.env"
LOG_DIR="$PROJECT_DIR/data/logs"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  printf 'install-service.sh: %s\n' "$*" >&2
  exit 1
}

# --- platform ----------------------------------------------------------------
# IMAGE_GATEWAY_PLATFORM exists so the render path of the platform you are NOT on
# can still be exercised, and reviewed, without a second machine.
PLATFORM="${IMAGE_GATEWAY_PLATFORM:-}"
if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Darwin) PLATFORM="launchd" ;;
    Linux) PLATFORM="systemd" ;;
    *)
      die "unsupported platform: $(uname -s).
  Only macOS (launchd) and Linux (systemd) are handled. Elsewhere, point your
  init system at $SELF_DIR/image-gateway-service.sh directly -- it takes no
  arguments and reconstructs its own environment."
      ;;
  esac
fi

case "$PLATFORM" in
  launchd | systemd) ;;
  *) die "IMAGE_GATEWAY_PLATFORM must be launchd or systemd, got '$PLATFORM'" ;;
esac

if [ -z "$SCOPE" ]; then
  if [ "$PLATFORM" = "systemd" ]; then SCOPE="system"; else SCOPE="user"; fi
fi

# --- who the service should run as -------------------------------------------
# `sudo ./install-service.sh` must not turn the service into root: root-owned
# files under data/ are a nuisance you cannot undo without a chown -R. SUDO_USER
# is who asked for the sudo, which is who should own the process.
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  SERVICE_USER="$SUDO_USER"
else
  SERVICE_USER="$(id -un)"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"

if [ "$SERVICE_USER" = "root" ]; then
  warn "warning: installing to run as root. Files the service writes under"
  warn "         $PROJECT_DIR/data will be root-owned. Run this script as your"
  warn "         normal user instead; it asks for sudo only where it needs it."
fi

SUDO=""
if [ "$(id -u)" != 0 ]; then SUDO="sudo"; fi

say "platform      $PLATFORM ($SCOPE), service user $SERVICE_USER"

# --- 1. which interpreter ----------------------------------------------------
# run.sh would fall back to bare `python3`. Under a service manager that failure
# is a restart loop in a log nobody reads, so resolve it now and record it.
detect_python() {
  for cand in \
    "${IMAGE_GATEWAY_PYTHON:-}" \
    "$PROJECT_DIR/.venv/bin/python" \
    "$HOME/.workbuddy-ai/binaries/python/envs/default/bin/python" \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /usr/bin/python3 \
    "$(command -v python3 2>/dev/null || true)"; do
    [ -n "$cand" ] || continue
    [ -x "$cand" ] || continue
    if "$cand" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}

PY=$(detect_python) || die "no interpreter with fastapi + uvicorn found.
  Install into a project-local venv:
    python3 -m venv $PROJECT_DIR/.venv
    $PROJECT_DIR/.venv/bin/pip install -r $PROJECT_DIR/requirements.txt
  then re-run this script."

say "interpreter   $PY"

# --- 2. the env file ---------------------------------------------------------
# Secrets live here, not in the unit: a plist in ~/Library/LaunchAgents is
# world-readable, and so is a unit in /etc/systemd/system.
if [ ! -f "$ENV_FILE" ]; then
  say "env file      creating $ENV_FILE"

  token=""
  [ -f "$PROJECT_DIR/data/access-token" ] &&
    token=$(tr -d '\r\n' < "$PROJECT_DIR/data/access-token")
  if [ -z "$token" ]; then
    token=$(openssl rand -hex 24)
    say "              generated a new gateway token (also written to data/access-token)"
  else
    say "              reused the token in data/access-token"
  fi

  device=""
  [ -f "$PROJECT_DIR/data/device-id" ] &&
    device=$(tr -d '\r\n' < "$PROJECT_DIR/data/device-id")
  if [ -z "$device" ]; then
    warn "              no data/device-id -- the gateway will pass the client's"
    warn "              device header through untouched, which the origin rejects."
  fi

  if [ "$DRY_RUN" = 1 ]; then
    say "              (dry run: not written)"
  else
    mkdir -p "$PROJECT_DIR/data"
    (
      umask 077
      cat > "$ENV_FILE" <<EOF
# Generated by deploy/install-service.sh. Gitignored; keep it chmod 600.
# Annotated reference for every option: deploy/image-gateway.env.example

# Deliberately empty, not a placeholder host. Empty makes POST /v1/images answer
# 503 no_upstream, and that message names the variable to set. A made-up host
# fails DNS at request time instead: the caller sees a 502 that is
# indistinguishable from the origin being down. The first Linux deploy was
# diagnosed as "upstream is broken" for exactly this reason.
IMAGE_GATEWAY_UPSTREAM=
IMAGE_GATEWAY_MODE=mock
IMAGE_GATEWAY_HOST=127.0.0.1
IMAGE_GATEWAY_PORT=4399
IMAGE_GATEWAY_PYTHON=$PY
IMAGE_GATEWAY_RATE_LIMIT_PER_MINUTE=20
IMAGE_GATEWAY_MAX_CONCURRENT_UPSTREAM=2
IMAGE_GATEWAY_ACCESS_TOKEN=$token
IMAGE_GATEWAY_DEVICE_ID=$device
EOF
    )
    chmod 600 "$ENV_FILE"
    # Keep the hand-run workflow working off the same value.
    printf '%s\n' "$token" > "$PROJECT_DIR/data/access-token"
  fi
else
  say "env file      reusing $ENV_FILE"
fi

# A pre-existing env file may still be missing the upstream credential, and that
# failure is quiet at runtime: the service comes up, the port answers, and only
# the actual generation is rejected by the origin. Say it at install time.
if ! sed -n 's/^IMAGE_GATEWAY_DEVICE_ID=\(..*\)$/\1/p' "$ENV_FILE" 2>/dev/null | grep -q .; then
  warn "warning: IMAGE_GATEWAY_DEVICE_ID is empty in $ENV_FILE"
  warn "         the service will start, but the origin rejects every"
  warn "         generation because no device credential is presented."
  warn "         Fill it from your own browser capture (its device header):"
  warn "           IMAGE_GATEWAY_DEVICE_ID=web-<uuid>"
fi

# Same class of quiet failure for the origin itself. The generated file ships a
# placeholder host, and a placeholder is worse than an empty value: empty makes
# the gateway answer 503 `no_upstream` ("set IMAGE_GATEWAY_UPSTREAM"), whereas a
# made-up host fails DNS at request time and reads like an upstream outage.
upstream_value=$(sed -n 's/^IMAGE_GATEWAY_UPSTREAM=\(.*\)$/\1/p' "$ENV_FILE" 2>/dev/null | tail -1)
case "$upstream_value" in
  "" | *upstream.example.com*)
    warn "warning: IMAGE_GATEWAY_UPSTREAM is ${upstream_value:-empty} in $ENV_FILE"
    warn "         the service will start, but POST /v1/images cannot reach an"
    warn "         origin until this points at your real one."
    ;;
esac

# --- 3. log directory --------------------------------------------------------
# launchd opens StandardOutPath *before* exec, so a missing directory means the
# job never starts and the only clue is in system.log. systemd journals stdout
# instead and needs nothing.
if [ "$PLATFORM" = "launchd" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    say "log dir       $LOG_DIR (dry run: not created)"
  else
    mkdir -p "$LOG_DIR" || die "could not create $LOG_DIR"
  fi
fi

# --- 4. port check -----------------------------------------------------------
port_from_env() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n 's/^IMAGE_GATEWAY_PORT=\([0-9]*\)$/\1/p' "$ENV_FILE" | tail -1
}
PORT="$(port_from_env)"
[ -n "$PORT" ] || PORT=4399

# lsof is not guaranteed on a minimal Ubuntu; ss (iproute2) is. Neither being
# present is survivable -- we just lose the PID in the message.
port_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1
  fi
}

# Bash's own /dev/tcp: no curl, no nc, works on both platforms. The `$PY`
# fallback is not belt-and-braces -- it is what keeps the probe honest if this
# file is ever run by a shell whose /dev/tcp support depends on a build flag.
# A probe that silently fails is indistinguishable from a dead service, which is
# exactly the bug this function used to have.
port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
  "$PY" - "$1" <<'PROBE' 2>/dev/null
import socket, sys
try:
    socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1).close()
except OSError:
    sys.exit(1)
PROBE
}

holder=$(port_pid "$PORT" || true)
if [ -n "$holder" ]; then
  warn "port $PORT is already held by PID $holder:"
  warn "  $(ps -o command= -p "$holder" 2>/dev/null | cut -c1-120)"
  if [ "$FORCE" != 1 ]; then
    die "stop it first, or pass --force if you know it is about to exit.
  kill $holder"
  fi
  warn "  --force given; continuing anyway"
fi

# --- 5. render the unit ------------------------------------------------------
case "$PLATFORM:$SCOPE" in
  launchd:user) TEMPLATE="$SELF_DIR/launchd/agent.plist.in" ;;
  launchd:system) TEMPLATE="$SELF_DIR/launchd/daemon.plist.in" ;;
  systemd:user) TEMPLATE="$SELF_DIR/systemd/user.service.in" ;;
  systemd:system) TEMPLATE="$SELF_DIR/systemd/system.service.in" ;;
esac

[ -f "$TEMPLATE" ] || die "missing template: $TEMPLATE"
[ -f "$PROJECT_DIR/run.sh" ] || die "missing $PROJECT_DIR/run.sh -- wrong directory?"

# sed replacement text treats & | \ specially; a path containing one is rare,
# and a silently mangled unit is a bad way to find out.
sed_escape() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }

# Portable mktemp. `mktemp -t prefix` is BSD-only: GNU coreutils requires the
# template to contain at least three X's and rejects `-t prefix` outright with
# "too few X's in template". A full template works on both.
RENDERED=$(mktemp "${TMPDIR:-/tmp}/image-gateway-unit.XXXXXX") || die "mktemp failed"
trap 'rm -f "$RENDERED"' EXIT

sed \
  -e "s|@@LABEL@@|$(sed_escape "$LAUNCHD_LABEL")|g" \
  -e "s|@@SERVICE_NAME@@|$(sed_escape "$SERVICE_NAME")|g" \
  -e "s|@@PROJECT_DIR@@|$(sed_escape "$PROJECT_DIR")|g" \
  -e "s|@@LOG_DIR@@|$(sed_escape "$LOG_DIR")|g" \
  -e "s|@@ENV_FILE@@|$(sed_escape "$ENV_FILE")|g" \
  -e "s|@@USER@@|$(sed_escape "$SERVICE_USER")|g" \
  -e "s|@@GROUP@@|$(sed_escape "$SERVICE_GROUP")|g" \
  "$TEMPLATE" > "$RENDERED"

# An unfilled placeholder is the one mistake the linters do not catch: a plist
# with "@@PROJECT_DIR@@/deploy/..." is well-formed XML, and a unit with it is a
# plausible-looking ExecStart that only fails at runtime.
if grep -q '@@[A-Z_]*@@' "$RENDERED" 2>/dev/null; then
  warn "unfilled placeholder(s) in the rendered unit:"
  grep -n '@@[A-Z_]*@@' "$RENDERED" >&2 || true
  die "template is missing a substitution -- this is a bug in install-service.sh"
fi

if [ "$PLATFORM" = "launchd" ]; then
  if command -v plutil >/dev/null 2>&1; then
    if ! plutil -lint "$RENDERED" >/dev/null; then
      plutil -lint "$RENDERED" >&2
      die "rendered plist is malformed"
    fi
    say "validated     plutil -lint"
  fi
else
  # Advisory only: systemd-analyze is strict about things that turn out fine,
  # and the authoritative check is whether the service comes up below.
  if command -v systemd-analyze >/dev/null 2>&1; then
    if systemd-analyze verify "$RENDERED" >"${TMPDIR:-/tmp}/image-gateway-verify.log" 2>&1; then
      say "validated     systemd-analyze verify"
    else
      warn "systemd-analyze verify complained (continuing; the start check is authoritative):"
      sed 's/^/  /' "${TMPDIR:-/tmp}/image-gateway-verify.log" >&2 || true
    fi
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  say ""
  say "=== rendered $PLATFORM unit ($SCOPE) ==="
  cat "$RENDERED"
  exit 0
fi

chmod +x "$SELF_DIR/image-gateway-service.sh"

# --- 6. install + (re)load ---------------------------------------------------
if [ "$PLATFORM" = "launchd" ]; then
  if [ "$SCOPE" = "system" ]; then
    DEST="/Library/LaunchDaemons/$LAUNCHD_LABEL.plist"
    DOMAIN="system"
  else
    DEST="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
    DOMAIN="gui/$(id -u)"
  fi

  mkdir -p "$(dirname "$DEST")" 2>/dev/null || true
  $SUDO install -m 644 "$RENDERED" "$DEST" || die "could not write $DEST"
  if [ "$SCOPE" = "system" ]; then
    # launchd refuses to load a daemon plist any user could rewrite.
    $SUDO chown root:wheel "$DEST"
    $SUDO chmod 644 "$DEST"
  fi
  say "installed     $DEST"

  $SUDO launchctl bootout "$DOMAIN/$LAUNCHD_LABEL" >/dev/null 2>&1 || true
  if ! $SUDO launchctl bootstrap "$DOMAIN" "$DEST" 2>/dev/null; then
    warn "bootstrap failed, falling back to load -w"
    $SUDO launchctl load -w "$DEST" || die "could not load $DEST"
  fi
  say "loaded        $DOMAIN/$LAUNCHD_LABEL"

else
  if [ "$SCOPE" = "system" ]; then
    DEST="/etc/systemd/system/$SERVICE_NAME.service"
    SYSTEMCTL="$SUDO systemctl"
    JOURNALCTL="$SUDO journalctl"
  else
    DEST="$HOME/.config/systemd/user/$SERVICE_NAME.service"
    SYSTEMCTL="systemctl --user"
    JOURNALCTL="journalctl --user"
  fi

  mkdir -p "$(dirname "$DEST")" 2>/dev/null || true
  $SUDO install -m 644 "$RENDERED" "$DEST" || die "could not write $DEST"
  say "installed     $DEST"

  $SYSTEMCTL daemon-reload || die "systemctl daemon-reload failed"
  # enable before start: a service that fails to start is still enabled, so
  # fixing the config brings it up by itself rather than needing a reinstall.
  $SYSTEMCTL enable "$SERVICE_NAME.service" || die "systemctl enable failed"
  if ! $SYSTEMCTL restart "$SERVICE_NAME.service"; then
    die "systemctl restart failed -- see: journalctl -u $SERVICE_NAME -n 40"
  fi
  say "enabled + started  $SERVICE_NAME.service"

  if [ "$SCOPE" = "user" ]; then
    # A user manager is normally torn down at logout, so a --user unit would not
    # survive a reboot without lingering.
    if loginctl enable-linger "$SERVICE_USER" >/dev/null 2>&1; then
      say "linger enabled     starts at boot without a login"
    else
      warn "could not enable lingering; the --user unit will NOT start at boot."
      warn "  run: sudo loginctl enable-linger $SERVICE_USER"
    fi
  fi
fi

# --- 7. confirm it is actually up -------------------------------------------
# "loaded" only means the manager accepted the job. uvicorn's cold start is slow
# enough that waiting for the listener is the only honest check.
say "waiting for 127.0.0.1:$PORT ..."
i=0
up=0
while [ "$i" -lt 45 ]; do
  if port_open "$PORT"; then
    up=1
    break
  fi
  sleep 1
  i=$((i + 1))
done

say ""
if [ "$up" = 1 ]; then
  say "image-gateway is running."
  say "  playground  http://127.0.0.1:$PORT/playground"
  say "  manual      http://127.0.0.1:$PORT/manual/"
  say "  config      http://127.0.0.1:$PORT/v1/config"
  say ""
  say "  gateway token: $PROJECT_DIR/data/access-token"
  if [ "$PLATFORM" = "launchd" ]; then
    say "  logs:          $LOG_DIR/launchd.err.log"
  else
    say "  logs:          journalctl -u $SERVICE_NAME -f"
  fi
  say ""
  say "Manage it with:"
  if [ "$PLATFORM" = "launchd" ]; then
    say "  launchctl print $DOMAIN/$LAUNCHD_LABEL"
    say "  launchctl kickstart -k $DOMAIN/$LAUNCHD_LABEL"
    say "  launchctl bootout $DOMAIN/$LAUNCHD_LABEL"
  elif [ "$SCOPE" = "system" ]; then
    say "  sudo systemctl status $SERVICE_NAME"
    say "  sudo systemctl restart $SERVICE_NAME"
    say "  sudo systemctl stop $SERVICE_NAME"
    say "  journalctl -u $SERVICE_NAME -f"
  else
    say "  systemctl --user status $SERVICE_NAME"
    say "  systemctl --user restart $SERVICE_NAME"
    say "  systemctl --user stop $SERVICE_NAME"
    say "  journalctl --user -u $SERVICE_NAME -f"
  fi
  say "  ./deploy/uninstall-service.sh          # remove entirely"
else
  warn "image-gateway did NOT come up within 45s."
  warn ""
  # Print the reason instead of naming two commands to run later. Whoever reads
  # this is already in a "it didn't work" state; making them retype the next
  # command is how a five-second fix turns into a support thread. Bounded to the
  # tail so a crash loop cannot flood the terminal.
  if [ "$PLATFORM" = "launchd" ]; then
    warn "--- launchctl print (tail) ---"
    $SUDO launchctl print "$DOMAIN/$LAUNCHD_LABEL" 2>&1 | tail -25 | sed 's/^/  /' || true
    warn ""
    warn "--- $LOG_DIR/launchd.err.log (tail) ---"
    tail -40 "$LOG_DIR/launchd.err.log" 2>&1 | sed 's/^/  /' || true
    warn ""
    warn "logs: tail -f $LOG_DIR/launchd.err.log"
  else
    warn "--- $SYSTEMCTL status ---"
    $SYSTEMCTL status "$SERVICE_NAME.service" --no-pager 2>&1 | sed 's/^/  /' || true
    warn ""
    warn "--- journal, last 40 lines ---"
    $JOURNALCTL -u "$SERVICE_NAME" -n 40 --no-pager 2>&1 | sed 's/^/  /' || true
    warn ""
    warn "logs: $JOURNALCTL -u $SERVICE_NAME -f"
  fi
  exit 1
fi
