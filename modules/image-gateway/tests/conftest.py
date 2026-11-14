"""Shared fixtures. Every test runs against an app built from explicit settings,
so the developer's shell environment can never change the outcome.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.upstream import DEVICE_HEADER  # noqa: E402

CAPTURED_PNG = ROOT / "assets" / "captured-generated.png"
SPEC_JSON = ROOT / "capture" / "spec.json"

#: A stand-in for the device id in the capture. The real value is a credential
#: belonging to whoever took that capture, so the committed tree carries a
#: syntactically valid placeholder instead. Nothing in the suite reaches the
#: origin, so the value only has to match DEVICE_PATTERN.
DEVICE = "web-00000000-0000-0000-0000-000000000000"

#: Scratch space for the tests that must write real files (the gateway's whole job
#: is storing what it fetches, so a fake store would not be testing it).
#:
#: Two constraints shaped this design:
#:
#:   * pytest's own `tmp_path` is unusable -- creating anything under the system
#:     temp directory is refused here;
#:   * *deleting* is gated behind an interactive approval, so a fixture that cleans
#:     up after itself cannot be relied on, and a silent `ignore_errors` teardown
#:     just leaks directories instead of failing.
#:
#: So the path is derived from the test id: stable across runs, therefore nothing
#: accumulates, and nothing ever has to be deleted. Tests that care how much is
#: stored assert a *delta* rather than an absolute count, which makes them
#: indifferent to whatever earlier runs left behind.
WORK_ROOT = ROOT / ".pytest-work"


@pytest.fixture
def work_dir(request):
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", request.node.nodeid)
    path = WORK_ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path


@pytest.fixture
def make_settings():
    """Settings for a hermetic test.

    No filesystem involvement at all: latency is zero and file logging is off.
    The request log is still inspectable because the store keeps an in-memory ring
    buffer -- which also means the suite runs in a read-only sandbox.
    """

    def _make(**overrides) -> Settings:
        base = dict(
            latency_min_ms=0,
            latency_max_ms=0,
            log_requests=False,
        )
        base.update(overrides)
        return Settings(**base)

    return _make


@pytest.fixture
def settings(make_settings) -> Settings:
    return make_settings()


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def captured_body() -> dict:
    """The exact body from re.txt, read out of the parsed capture."""
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    body = spec["captures"][0]["body"]
    return {"mode": body["mode"], "prompt": body["prompt"], "aspect": body["aspect"]}


@pytest.fixture
def device_headers() -> dict:
    return {DEVICE_HEADER: DEVICE, "Content-Type": "application/json"}
