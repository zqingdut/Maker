"""The endpoints that matter: the captured AI image call, plus an upload endpoint.

Observed contract (probed live, no generation triggered):
    POST /api/v1/media/ai/image  {}                       -> 400 {"error":"bad_mode"}
    OPTIONS /api/v1/media/ai/image                        -> 204, no CORS headers
    POST /api/v1/<unknown>                                -> 405, Allow: GET, HEAD

Per-request overrides, all optional, all mock-only:
    X-Mock-Delay: 1500          force a specific latency in ms
    X-Mock-Fail: 502            force this status (or "off" to disable injection)
    X-Mock-Style: url           inline | url | openai
    X-Mock-Variant: placeholder captured | placeholder
    X-Mock-Seed: abc123         pin the deterministic seed
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import random
import re
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..images import render
from ..responses import build_success
from ..upstream import DEVICE_HEADER_LOWER, GENERATE_PATH
from ..urls import public_base
from ..validation import ApiError, parse_json_body, validate_image_request

router = APIRouter()

DATA_URL_RE = re.compile(r"^data:(?P<mime>[\w.+-]+/[\w.+-]+)?;base64,(?P<payload>[A-Za-z0-9+/=\s]+)$")

STYLES = ("inline", "url", "openai")
VARIANTS = ("captured", "placeholder")


def _header(request: Request, name: str) -> str | None:
    value = request.headers.get(name)
    return value.strip() if value and value.strip() else None


def _style(request: Request, default: str) -> str:
    value = _header(request, "x-mock-style")
    if value is None:
        return default
    if value not in STYLES:
        raise ApiError(400, "bad_style", f"X-Mock-Style must be one of {', '.join(STYLES)}")
    return value


def _variant(request: Request, default: str) -> str:
    value = _header(request, "x-mock-variant")
    if value is None:
        return default
    if value not in VARIANTS:
        raise ApiError(400, "bad_variant", f"X-Mock-Variant must be one of {', '.join(VARIANTS)}")
    return value


def _forced_failure(request: Request, settings) -> int | None:
    forced = _header(request, "x-mock-fail")
    if forced is not None:
        if forced.lower() in ("off", "none", "0"):
            return None
        if not forced.isdigit():
            raise ApiError(400, "bad_fail_directive", "X-Mock-Fail must be a status code or 'off'")
        return int(forced)
    if settings.fail_rate > 0 and random.random() < settings.fail_rate:
        return settings.fail_status
    return None


async def _sleep(request: Request, settings) -> None:
    forced = _header(request, "x-mock-delay")
    if forced is not None:
        if not forced.lstrip("-").isdigit():
            raise ApiError(400, "bad_delay_directive", "X-Mock-Delay must be an integer")
        delay_ms = max(0, min(int(forced), 60_000))
    else:
        delay_ms = random.randint(settings.latency_min_ms, settings.latency_max_ms)
    if delay_ms:
        await asyncio.sleep(delay_ms / 1000.0)


def _request_id(request: Request) -> str:
    return _header(request, "x-request-id") or uuid.uuid4().hex


@router.post(GENERATE_PATH)
async def create_image(request: Request) -> JSONResponse:
    ctx = request.app.state.ctx
    settings = ctx.settings

    # Tag the log record up front so that *rejected* calls are greppable too --
    # "which prompt did my client send that got bad_mode?" is a real question.
    request.state.log_extra = {"kind": "ai-image"}

    raw = await request.body()
    body = parse_json_body(raw, settings)
    image_request = validate_image_request(
        body,
        settings,
        device=_header(request, DEVICE_HEADER_LOWER),
        seed_override=_header(request, "x-mock-seed"),
    )
    style = _style(request, settings.response_style)
    variant = _variant(request, settings.variant)
    request_id = _request_id(request)

    request.state.log_extra.update(
        {
            "mode": image_request.mode,
            "aspect": image_request.aspect,
            "promptChars": len(image_request.prompt),
            "prompt": image_request.prompt[:2000],
            "promptTruncated": image_request.prompt_truncated,
            "device": image_request.device,
            "style": style,
            "variant": variant,
            "seed": image_request.seed,
        }
    )

    forced = _forced_failure(request, settings)
    if forced is not None:
        await asyncio.sleep(min(0.3, settings.latency_min_ms / 1000.0))
        ctx.store.bump(f"status_{forced}")
        request.state.log_extra["injectedFailure"] = forced
        return JSONResponse(
            status_code=forced,
            content={"error": _error_code_for(forced)},
            headers={"X-Mock-Injected": "true"},
        )

    await _sleep(request, settings)

    rendered = render(variant, image_request.seed, image_request.width, image_request.height)
    item_id = (
        f"img_{image_request.seed[:20]}"
        if settings.deterministic
        else f"img_{uuid.uuid4().hex[:20]}"
    )

    payload = build_success(
        style=style,
        item_id=item_id,
        request=image_request,
        rendered=rendered,
        base_url=public_base(request, settings),
        request_id=request_id,
        report_credential=settings.report_credential,
    )

    if style == "url":
        # keep the bytes around so /assets/generated/<id>.png can serve them
        ctx.store.put(
            item_id,
            {"kind": "generated", "payload": payload, "bytes": rendered.data, "mime": rendered.mime},
        )

    ctx.store.bump("generated")
    ctx.store.bump(f"style_{style}")
    request.state.log_extra["id"] = item_id
    request.state.log_extra["bytes"] = rendered.size
    # A header rather than a body field: the body is a reconstruction of the
    # origin's contract, and inventing a key there would make the mock disagree
    # with the thing it exists to imitate.
    headers = {"X-Prompt-Truncated": "true"} if image_request.prompt_truncated else {}
    return JSONResponse(content=payload, headers=headers)


def _error_code_for(status: int) -> str:
    return {
        400: "bad_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        413: "payload_too_large",
        429: "rate_limited",
        500: "internal_error",
        502: "upstream_error",
        503: "upstream_unavailable",
        504: "upstream_timeout",
    }.get(status, "error")


@router.post("/api/v1/media/upload")
async def upload_media(request: Request) -> JSONResponse:
    """Mock extension.

    The second capture entry was a 2.88MB `data:image/png;base64,...` whose target
    URL the exporter destroyed, so the real upload endpoint (if any) is unknown.
    This is the obvious shape: hand us a data URL, get an id and a URL back.
    """
    ctx = request.app.state.ctx
    settings = ctx.settings

    raw = await request.body()
    if len(raw) > settings.max_body_bytes:
        raise ApiError(413, "payload_too_large")

    data_url: str | None = None
    if raw[:5] == b"data:":
        data_url = raw.decode("utf-8", errors="replace").strip()
    else:
        body = parse_json_body(raw, settings)
        for key in ("dataUrl", "data_url", "image", "file"):
            candidate = body.get(key)
            if isinstance(candidate, str) and candidate.startswith("data:"):
                data_url = candidate
                break

    if not data_url:
        raise ApiError(400, "bad_payload", "expected a data: URL body or a dataUrl field")

    match = DATA_URL_RE.match(data_url)
    if not match:
        raise ApiError(400, "bad_payload", "only base64 data URLs are accepted")
    mime = match.group("mime") or "application/octet-stream"
    try:
        decoded = base64.b64decode(match.group("payload"), validate=False)
    except (binascii.Error, ValueError):
        raise ApiError(400, "bad_payload", "base64 payload could not be decoded") from None

    request.state.log_extra = {
        "kind": "upload",
        "mime": mime,
        "bytes": len(decoded),
    }

    await _sleep(request, settings)

    item_id = f"up_{uuid.uuid4().hex[:20]}"
    ctx.store.put(
        item_id,
        {
            "kind": "uploaded",
            "mime": mime,
            "bytes": decoded,
            "payload": {"id": item_id, "mimeType": mime, "size": len(decoded)},
        },
    )
    ctx.store.bump("uploaded")
    request.state.log_extra["id"] = item_id
    return JSONResponse(
        content={
            "id": item_id,
            "mimeType": mime,
            "size": len(decoded),
            "url": f"{public_base(request, settings)}/assets/uploaded/{item_id}.bin",
        }
    )
