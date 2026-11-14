"""The installers must not inherit the caller's shell.

`sh deploy/install-service.sh` is what people actually type, and on Ubuntu `sh`
is dash. The script decides whether the service came up by opening
`/dev/tcp/127.0.0.1/<port>`, which is a **bash** extension -- under dash that
open fails every single time, so the readiness loop runs its full 45 seconds and
then reports a perfectly healthy service as dead.

That is not a hypothetical: it is what happened on the first Linux deployment.
The fix is to re-exec under bash, and these tests pin it so it cannot come back.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy"
SCRIPTS = ["install-service.sh", "uninstall-service.sh"]

dash = shutil.which("dash")


def _guard_offset(text: str) -> int:
    marker = "exec bash \"$0\" \"$@\""
    assert marker in text, "the bash re-exec guard is gone"
    return text.index(marker)


def _first_probe_offset(text: str) -> int:
    # The code, not the prose: both files explain /dev/tcp in a comment above
    # the guard, and matching that would make this test pass for the wrong
    # reason.
    return text.index('exec 3<>"/dev/tcp')


@pytest.mark.parametrize("name", SCRIPTS)
def test_the_guard_runs_before_the_first_bash_only_probe(name: str) -> None:
    """A guard placed after the probe it protects protects nothing."""
    text = (DEPLOY / name).read_text(encoding="utf-8")

    assert _guard_offset(text) < _first_probe_offset(text), (
        f"{name} reaches /dev/tcp before it has switched to bash"
    )


def test_the_generated_env_does_not_ship_a_placeholder_upstream() -> None:
    """An empty value is the honest default; a placeholder host is a trap.

    `https://upstream.example.com` looks configured. It is not -- it does not
    resolve, so the first generation fails DNS and surfaces as a 502 that reads
    exactly like the origin being down. That is how the first Linux deploy was
    misdiagnosed. Empty answers `503 no_upstream`, which names the variable.
    """
    text = (DEPLOY / "install-service.sh").read_text(encoding="utf-8")

    assert "IMAGE_GATEWAY_UPSTREAM=https://" not in text, (
        "the installer must not write a host it cannot reach"
    )
    assert "\nIMAGE_GATEWAY_UPSTREAM=\n" in text, "write it empty, on purpose"


@pytest.mark.skipif(dash is None, reason="dash is not installed; nothing to compare against")
def test_the_installer_still_renders_when_invoked_by_sh() -> None:
    """End to end: `sh` must produce the same rendered unit as `bash`.

    The script is copied to a temporary project root so the real deploy/ env
    file and data/ directory are never touched. PORT=0 in the stub env file
    keeps the port-conflict check from firing on a busy machine.

    `tempfile.mkdtemp` rather than pytest's `tmp_path`: the latter creates its
    shared base directory with `exist_ok=True`, which some sandboxed
    environments broker badly, and a flaky fixture is worse than no test.
    """
    project = Path(tempfile.mkdtemp(prefix="ig-deploy-"))
    try:
        shutil.copytree(DEPLOY, project / "deploy")
        (project / "run.sh").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        (project / "deploy" / "image-gateway.env").write_text(
            "IMAGE_GATEWAY_PORT=0\n"
            "IMAGE_GATEWAY_ACCESS_TOKEN=stub\n"
            "IMAGE_GATEWAY_DEVICE_ID=web-00000000-0000-0000-0000-000000000000\n",
            encoding="utf-8",
        )

        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(project),
            "IMAGE_GATEWAY_PLATFORM": "systemd",
            # detect_python probes interpreters in order; pin the one running the
            # tests so the check does not depend on what happens to be installed.
            "IMAGE_GATEWAY_PYTHON": sys.executable,
        }
        result = subprocess.run(
            [dash, str(project / "deploy" / "install-service.sh"), "--dry-run"],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)

    assert result.returncode == 0, result.stderr
    assert "=== rendered systemd unit (system) ===" in result.stdout
    # The unit it rendered is a real one, not an early bail-out.
    assert "ExecStart=" in result.stdout
    assert "@@" not in result.stdout
