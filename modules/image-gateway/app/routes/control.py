"""Mock control plane.

Nothing here exists in the real service -- every path is namespaced under
/__mock__ so it can never collide with a real endpoint. It exists so you can
retune a running mock from a test or a shell instead of restarting it.
"""

from __future__ import annotations

import json
import pathlib
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .. import aspects
from ..config import secret_hint
from ..images import CAPTURED_PATH, captured_metadata
from ..validation import ApiError

router = APIRouter(prefix="/__mock__")

SPEC_PATH = pathlib.Path(__file__).resolve().parent.parent.parent / "capture" / "spec.json"


class ConfigPatch(BaseModel):
    """Every field is optional; only what you send is applied.

    `relay_headers` is deliberately absent: injecting an auth token over an
    unauthenticated HTTP endpoint is not something a config API should offer.
    Set IMAGE_GATEWAY_RELAY_HEADERS in the environment instead.
    """

    model_config = {"extra": "forbid"}

    response_style: str | None = Field(default=None, pattern="^(inline|url|openai)$")
    variant: str | None = Field(default=None, pattern="^(captured|placeholder)$")
    latency_min_ms: int | None = Field(default=None, ge=0, le=60_000)
    latency_max_ms: int | None = Field(default=None, ge=0, le=60_000)
    fail_rate: float | None = Field(default=None, ge=0.0, le=1.0)
    fail_status: int | None = Field(default=None, ge=400, le=599)
    require_device: bool | None = None
    report_credential: bool | None = None
    deterministic: bool | None = None
    asset_miss: str | None = Field(default=None, pattern="^(not_found|placeholder|proxy)$")
    log_requests: bool | None = None
    public_base_url: str | None = None
    # --- relay ---
    mode: str | None = Field(default=None, pattern="^(mock|relay)$")
    upstream: str | None = None
    relay_paths: list[str] | None = None
    relay_timeout_s: float | None = Field(default=None, gt=0, le=600)
    # --- gateway ---
    gateway_enabled: bool | None = None
    gateway_validate: bool | None = None
    normalize_response: bool | None = None
    # Deliberately absent: rate_limit_per_minute and max_concurrent_upstream.
    # Their runtime objects (RateLimiter, Semaphore) are built once at startup, so
    # patching the setting would be a silent no-op -- worse than not offering it.
    # Restart with the env var instead.


#: Fields that must never be read back over HTTP even in redacted form.
UNSAFE_TO_REPORT = frozenset({"relay_headers"})


@router.get("/state")
async def state(request: Request) -> JSONResponse:
    ctx = request.app.state.ctx
    settings = ctx.settings
    return JSONResponse(
        content={
            "uptimeSeconds": round(time.time() - ctx.started_at, 3),
            "settings": settings.as_dict(),
            "counters": dict(sorted(ctx.store.counters.items())),
            "storedItems": len(ctx.store.list(limit=1000)),
            "capturedImage": captured_metadata(),
            "supportedAspects": aspects.supported(),
            "responseEnvelope": "reconstructed -- only requests were captured",
        }
    )


@router.post("/config")
async def patch_config(patch: ConfigPatch, request: Request) -> JSONResponse:
    ctx = request.app.state.ctx
    settings = ctx.settings

    applied: dict = {}
    for key, value in patch.model_dump(exclude_none=True).items():
        if key == "relay_paths":
            value = tuple(value)
        elif key == "upstream":
            value = value.rstrip("/")
        if getattr(settings, key, None) != value:
            setattr(settings, key, value)
            applied[key] = value

    try:
        settings.validate()
    except ValueError as exc:
        raise ApiError(400, "bad_config", str(exc)) from None

    return JSONResponse(content={"applied": applied, "settings": settings.as_dict()})


@router.post("/reset")
async def reset(request: Request) -> JSONResponse:
    ctx = request.app.state.ctx
    ctx.store.reset()
    ctx.started_at = time.time()
    return JSONResponse(content={"reset": True})


@router.get("/capture")
async def capture(request: Request) -> JSONResponse:
    if not SPEC_PATH.exists():
        raise ApiError(
            404,
            "no_capture",
            "run: python scripts/extract_capture.py",
        )
    return JSONResponse(content=json.loads(SPEC_PATH.read_text(encoding="utf-8")))


@router.get("/requests")
async def recent_requests(
    request: Request, limit: int = 20, source: str = "memory"
) -> JSONResponse:
    """Recent requests.

    `source=memory` (the default) reads the in-process ring buffer, so it works
    even with file logging off. `source=file` tails the JSONL log, which is the
    one that survives a restart.
    """
    ctx = request.app.state.ctx
    if source not in ("memory", "file"):
        raise ApiError(400, "bad_source", "source must be 'memory' or 'file'")

    limit = max(1, min(limit, 500))
    records = (
        ctx.store.read_log_file(limit) if source == "file" else ctx.store.recent(limit)
    )
    return JSONResponse(
        content={
            "source": source,
            "path": str(ctx.settings.log_path or ctx.store.log_path),
            "fileLoggingEnabled": ctx.store.log_enabled,
            "records": records,
        }
    )


@router.get("/relay")
async def relay_status(request: Request) -> JSONResponse:
    """Is this instance going to spend real money? Answer that unambiguously."""
    settings = request.app.state.ctx.settings
    return JSONResponse(
        content={
            "enabled": settings.relay_enabled,
            "mode": settings.mode,
            "upstream": settings.upstream or None,
            "relayPaths": list(settings.relay_paths),
            "timeoutSeconds": settings.relay_timeout_s,
            "injectedHeaders": sorted(settings.relay_headers),
            "forwardClientHeaders": settings.relay_forward_client_headers,
            "trustEnv": settings.relay_trust_env,
            "perRequestOverride": "X-Mock-Mode: relay | mock",
            "warning": (
                "relay mode is ON -- matching requests are forwarded to the real origin"
                if settings.mode == "relay" and settings.relay_enabled
                else None
            ),
        }
    )


@router.get("/gateway")
async def gateway_status(request: Request) -> JSONResponse:
    """The 中转站, in one screen.

    Mirrors `/relay`: the question it exists to answer is "is this instance about
    to spend real money, and on whose behalf?" -- plus where the results land.
    """
    ctx = request.app.state.ctx
    settings = ctx.settings

    warning = None
    if settings.gateway_enabled and not settings.auth_required:
        warning = (
            "the gateway is OPEN: IMAGE_GATEWAY_ACCESS_TOKEN is unset, so anyone who can "
            "reach this port can spend your upstream quota"
        )
    elif settings.gateway_enabled and not settings.upstream:
        warning = "gateway_enabled but IMAGE_GATEWAY_UPSTREAM is unset -- POST /v1/images answers 503"

    return JSONResponse(
        content={
            "enabled": settings.gateway_enabled,
            "ready": settings.gateway_ready,
            "upstream": settings.upstream or None,
            "authRequired": settings.auth_required,
            "deviceOverride": settings.override_device,
            "deviceIdHint": secret_hint(settings.device_id) if settings.override_device else None,
            "files": {**ctx.filestore.stats(), "requireToken": settings.files_require_token},
            "rateLimit": ctx.rate_limiter.snapshot(),
            "concurrency": {
                "maxConcurrentUpstream": settings.max_concurrent_upstream,
                "queueTimeoutSeconds": settings.queue_timeout_s,
            },
            "retries": settings.relay_retries,
            "normalizeResponse": settings.normalize_response,
            "localValidation": settings.gateway_validate,
            "endpoints": {
                "generate": "POST /v1/images",
                "list": "GET /v1/images",
                "metadata": "GET /v1/images/{id}",
                "file": "GET /files/{name}",
                "config": "GET /v1/config",
            },
            "warning": warning,
        }
    )


@router.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    ctx = request.app.state.ctx
    return JSONResponse(
        content={
            "status": "ok",
            "capturedImagePresent": CAPTURED_PATH.exists(),
            "uptimeSeconds": round(time.time() - ctx.started_at, 3),
        }
    )
