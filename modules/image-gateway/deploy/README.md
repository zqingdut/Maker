# Running image-gateway as a service

Native service management, no Docker, no `nohup`, no third-party supervisor.
Two init systems are supported and the choice is made by `uname`:

| Platform | Init system | `--user` scope | `--system` scope |
|---|---|---|---|
| macOS | launchd | LaunchAgent, at login | LaunchDaemon, at boot |
| Linux | systemd | user unit, at login (+ linger for boot) | system unit, at boot |

```sh
./deploy/install-service.sh          # install + start, platform default
./deploy/uninstall-service.sh        # stop + remove
```

That is the whole workflow. The rest of this file explains what those two commands
actually do, because a service that starts itself at boot is a thing you want to
understand before you trust it.

## Which scope?

The default is the one that starts at boot while asking the least of you:

- **Linux → `--system`.** This is the normal way to run a daemon there, and the
  unit carries `User=<you>`, so it starts at boot *and* still runs as you rather
  than as root. `sudo` is requested per step, not for the whole script, so the
  generated env file stays owned by you.
- **macOS → `--user`.** A LaunchAgent starts when you log in. A LaunchDaemon would
  start earlier, but it needs root and buys nothing on a laptop.

Pass `--user` or `--system` to override. `--daemon` is kept as an alias for
`--system`.

On Linux, `--user` additionally runs `loginctl enable-linger <you>`; without
lingering, a user unit is torn down at logout and would **not** survive a reboot.

## What gets installed

| File | Role |
|---|---|
| `image-gateway-service.sh` | the program the service manager runs |
| `launchd/agent.plist.in` | macOS, at login |
| `launchd/daemon.plist.in` | macOS, at boot |
| `systemd/system.service.in` | Linux, at boot |
| `systemd/user.service.in` | Linux, at login |
| `install-service.sh` | renders the unit, validates it, installs, enables, verifies |
| `uninstall-service.sh` | stops and removes the unit |
| `image-gateway.env.example` | annotated template for the runtime env file |
| `image-gateway.env` | **generated**, gitignored, `chmod 600` — holds the secrets |

Both installer scripts need **bash**, and say so in their first lines. Invoke them
as `./deploy/install-service.sh`, which reads the shebang. If you type
`sh deploy/install-service.sh` on Ubuntu, `sh` is dash: the script notices and
re-executes itself under bash, because its readiness probe uses `/dev/tcp` — a
bash extension. Under dash that probe fails *every time*, which once turned a
healthy service into a 45-second wait and a false "did NOT come up".

Install destinations:

| Platform / scope | Path | Control |
|---|---|---|
| macOS `--user` | `~/Library/LaunchAgents/com.imagegateway.relay.plist` | `launchctl` |
| macOS `--system` | `/Library/LaunchDaemons/com.imagegateway.relay.plist` | `launchctl` |
| Linux `--system` | `/etc/systemd/system/image-gateway.service` | `systemctl` |
| Linux `--user` | `~/.config/systemd/user/image-gateway.service` | `systemctl --user` |

## Where the secrets live, and where they must not

The unit file is **world-readable** — it has to be, it sits in a directory other
tools inspect. So nothing sensitive goes in it. `install-service.sh` writes the
credentials to `deploy/image-gateway.env` (`chmod 600`, gitignored) and the wrapper
loads them at startup. The unit references that file by path only
(`EnvironmentFile=-…` on systemd, and the wrapper's own loader on macOS).

The two credentials point in opposite directions and are easy to confuse:

- `IMAGE_GATEWAY_ACCESS_TOKEN` — **ours**. Clients present it. The gateway is open to
  anyone who can reach the port if this is empty, which is why the wrapper refuses
  to start in that state.
- `IMAGE_GATEWAY_DEVICE_ID` — the credential the gateway presents **to the origin**
  (its device header; `X-Device-Id` is the stand-in name used throughout these
  docs, the real one is in `app/upstream.py`). Not shipped in this repo; take it
  from your own browser capture. **With this empty the service starts fine and
  every generation fails upstream** — the client's own device header is passed
  through instead, and the origin rejects it.

The wrapper also falls back to `data/access-token` and `data/device-id`, so
switching from a hand-run instance to the service needs no copying.
`install-service.sh` seeds the env file from those same files, and generates a
token if there is none.

## Why a wrapper script instead of pointing the unit at `run.sh`

A service manager gives a process almost nothing: no shell rc files, no `PATH` from
your terminal, none of the variables you exported interactively. A unit that ran
`run.sh` directly would work right up until it needed `IMAGE_GATEWAY_PYTHON`, and then
fail in a log nobody reads.

So `image-gateway-service.sh` reconstructs that environment: it resolves the project
root from its own location, loads the env file, falls back to `data/`, prints a
startup banner (no secrets, only "set"/"MISSING"), and `exec`s `run.sh` so the
manager keeps tracking a single PID — which is also what makes `systemctl stop`
and `launchctl bootout` deliver SIGTERM to the right process.

One useful side effect: because the manager inherits no shell environment, an
`HTTP_PROXY` exported in your `.zshrc` is invisible to the service. The outbound
leg connects directly, which is what you want on a box whose proxy is meant for
interactive use only.

## Logs

**Linux (systemd)** — stdout and stderr go to the journal. Nothing to rotate.

```sh
journalctl -u image-gateway -f          # --system
journalctl --user -u image-gateway -f   # --user
```

**macOS (launchd)** — written to files:

```
data/logs/launchd.out.log     stdout (nearly empty; uvicorn logs to stderr)
data/logs/launchd.err.log     the startup banner and uvicorn's output
```

launchd opens these **before** it execs the program, so the directory must exist
first — `install-service.sh` creates it. If the directory is missing, the job does
not start at all and the only clue is a line in `system.log`.

**These files are never rotated.** They grow for as long as the service runs. A
gateway that logs one line per request is not a problem at hobby volume, but check
the size occasionally (`ls -lh data/logs/`). To reset, stop the service, delete the
files, start it again.

## Common operations

```sh
# Linux
sudo systemctl status image-gateway
sudo systemctl restart image-gateway
sudo systemctl stop image-gateway
journalctl -u image-gateway -n 40 --no-pager

# macOS
DOMAIN="gui/$(id -u)/com.imagegateway.relay"
launchctl print "$DOMAIN"
launchctl kickstart -k "$DOMAIN"
launchctl bootout "$DOMAIN"
```

Editing `deploy/image-gateway.env` does **not** take effect on its own — the
environment is read once, at spawn. Re-run `install-service.sh`, or
`systemctl restart image-gateway` / `launchctl kickstart -k`.

## Troubleshooting

Start with the log. It is almost always there.

```sh
journalctl -u image-gateway -n 40 --no-pager      # Linux
tail -40 data/logs/launchd.err.log            # macOS
```

| Symptom | Cause |
|---|---|
| job never starts, no log file (macOS) | `data/logs` missing, or the wrapper is not executable |
| restarts every ~10 s | a config error — `RestartSec`/`ThrottleInterval` is what spaces them out. Read the log. |
| banner says `token MISSING` and exits 78 | no `IMAGE_GATEWAY_ACCESS_TOKEN` anywhere. Expected, and fixed by setting one. |
| `Failed to start` / `Service could not be loaded` | malformed unit. Re-run the installer; it validates before installing. |
| `Address already in use` | a hand-run instance still holds the port. The installer checks for this and refuses unless `--force`. |
| `503 no_upstream` from the API | `IMAGE_GATEWAY_UPSTREAM` unset — the service is up, the outbound leg is not configured |
| generation returns an upstream error, banner says `device id MISSING` | `IMAGE_GATEWAY_DEVICE_ID` empty — see above |

The last two are worth stating plainly: **the service starting successfully does
not mean it can reach the origin.** Check `GET /v1/config` — it reports `upstream`
and `ready` separately. See the "Wiring it to the real API" section of the main
README.

## What uninstalling does not do

`uninstall-service.sh` stops the service and removes the unit. It leaves `data/`
alone — your images, the gateway token, the device id. So re-installing picks up
exactly where you left off. Losing a credential or a library should never be a side
effect of uninstalling a service.

On Linux `--user` installs it also leaves lingering enabled; if you want that
reverted, `sudo loginctl disable-linger <you>` — but check whether other user
services depend on it first.

## Not covered

Windows, and Linux without systemd (Alpine/OpenRC, Devuan/sysvinit, containers).
For those, point your init system at `deploy/image-gateway-service.sh` directly: it
takes no arguments and reconstructs its own environment.
