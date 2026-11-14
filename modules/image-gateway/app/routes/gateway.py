"""The client-facing 中转站 API.

Everything under `/v1` and `/files` is *ours* -- the origin has no such paths
(which is why `relay.should_relay` refuses to forward them). A client points its
base URL here, presents one shared token, and gets back a short immutable URL
instead of a multi-megabyte base64 blob it would have to carry around.

    POST   /v1/images          generate: auth -> gate -> upstream -> re-host
    GET    /v1/images          recent generations, newest first
    GET    /v1/images/{id}     metadata for one stored image
    GET    /files/{name}       the bytes (immutable, ETag, Range-capable)
    GET    /v1/config          the public contract -- no secrets

The division of labour with `app/gateway.py`: this module owns HTTP concerns
(status codes, headers, caching, auth), that one owns the upstream call and the
re-hosting. Nothing here talks to the network directly.

On validation: we reject locally only what the origin would reject *identically*
(`mode` and `empty_prompt` were both observed live), because a local check that is
stricter than the origin turns a working request into a fake failure. Aspect is
therefore never validated here -- and that is now a *finding*, not a hedge: the
origin accepted `"99:1"` and served 200 at the default 1184x864, so any local
aspect table would have rejected a request that works.
`IMAGE_GATEWAY_GATEWAY_VALIDATE=0` disables even the local checks and forwards
everything untouched.
"""

from __future__ import annotations

import logging
import pathlib
from email.utils import parsedate_to_datetime

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .. import gateway, security
from ..filestore import etag_for, last_modified
from ..urls import file_url, public_base
from ..validation import BINDING_ORDER, ApiError, BindingError, fit_prompt, parse_json_body

logger = logging.getLogger("image-gateway.gateway.routes")

router = APIRouter(tags=["gateway"])

#: One year. A content-addressed URL can never point at different bytes, so this
#: is the one place `immutable` is not a lie.
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

PLAYGROUND = (
    pathlib.Path(__file__).resolve().parent.parent.parent
    / "assets"
    / "playground"
    / "index.html"
)


# --- shared helpers ------------------------------------------------------
def _ctx(request: Request):
    return request.app.state.ctx


def _require_ready(settings) -> None:
    """Is this gateway able to spend money on the caller's behalf?"""
    if not settings.gateway_enabled:
        raise ApiError(404, "gateway_disabled", "set IMAGE_GATEWAY_GATEWAY_ENABLED=1")
    if not settings.upstream:
        raise ApiError(503, "no_upstream", "set IMAGE_GATEWAY_UPSTREAM to the real origin")


def _caller_key(request: Request, settings) -> str:
    return security.caller_key(request, settings)


def _may_see_internals(request: Request, settings) -> bool:
    """Reveal the upstream host only to a caller who could already infer it.

    With no token configured there is no secret to protect; with one configured,
    an anonymous caller has no business learning where we forward to.
    """
    if not settings.auth_required:
        return True
    try:
        security.require_token(request, settings)
    except ApiError:
        return False
    return True


def _validate(body: dict, settings) -> str | None:
    """Local pre-flight, deliberately narrower than the origin's own rules.

    Every check here reproduces one the origin performs *identically*, in the same
    order, so a local rejection can never turn a working request into a fake
    failure. Codes were probed live on 2026-09-24 -- note `empty_prompt`, not
    `bad_prompt`, and note that a wrong JSON type is a model-binding failure with
    its own problem+json shape rather than the flat envelope.

    Returns the prompt to use when it had to be shortened, else `None`. The caller
    writes it back into `body` -- this function only judges, it never mutates.
    """
    for name in BINDING_ORDER:
        if name in body and body[name] is not None and not isinstance(body[name], str):
            raise BindingError(name)

    mode = body.get("mode")
    if not isinstance(mode, str) or mode not in settings.modes:
        # Observed live: `POST {}` -> 400 {"error":"bad_mode"}. The origin checks
        # `mode` before anything else and we reproduce that ordering exactly.
        raise ApiError(400, "bad_mode", f"supported modes: {', '.join(settings.modes)}")

    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ApiError(400, "empty_prompt", "prompt must be a non-empty string")
    fitted, truncated = fit_prompt(prompt, settings)
    return fitted if truncated else None

    # `aspect` is NOT validated, and that is a finding, not an omission: the origin
    # accepted "99:1" and answered 200 at the default 1184x864. A local size table
    # is a guess, and rejecting on it would refuse a request the origin would serve.


# --- POST /v1/images -----------------------------------------------------
@router.post("/v1/images")
async def create_image(request: Request) -> JSONResponse:
    ctx = _ctx(request)
    settings = ctx.settings
    request.state.log_extra = {"kind": "gateway"}

    _require_ready(settings)
    security.require_token(request, settings)

    body = parse_json_body(await request.body(), settings)
    if settings.gateway_validate:
        fitted = _validate(body, settings)
        if fitted is not None:
            # Cut before the rate limiter and before the upstream call: the
            # truncated text is what we are billed for, so it is also what the
            # caller must be told about.
            body["prompt"] = fitted
            request.state.prompt_truncated = True

    # The limiter guards the upstream bill, so it is charged only once the request
    # is known to be one that would actually be forwarded. Rejecting a bad body
    # costs us a few microseconds and the origin nothing, and charging for it would
    # let a client with a broken payload lock itself out.
    retry_after = ctx.rate_limiter.check(_caller_key(request, settings))
    if retry_after:
        ctx.store.bump("gateway_rate_limited")
        request.state.log_extra["rateLimited"] = True
        raise ApiError(
            429,
            "rate_limited",
            f"{settings.rate_limit_per_minute} requests per minute",
            headers={"Retry-After": str(retry_after)},
        )

    ctx.store.bump("gateway_requests")
    request.state.log_extra.update(
        {
            "mode": body.get("mode"),
            "aspect": body.get("aspect"),
            "promptChars": len(body["prompt"]) if isinstance(body.get("prompt"), str) else None,
            "prompt": (body.get("prompt") or "")[:2000],
            "promptTruncated": bool(getattr(request.state, "prompt_truncated", False)),
        }
    )

    result = await gateway.generate(ctx, request, body)
    stored = result.stored

    if not settings.normalize_response and isinstance(result.upstream_payload, dict):
        # Escape hatch: hand back exactly what the origin said. The image is still
        # re-hosted (we already paid for it), and the URL is still in `Location`.
        payload: dict = dict(result.upstream_payload)
    else:
        payload = _normalize(result, request, settings)

    headers = {
        "location": payload.get("url") or file_url(request, settings, stored.file_id),
        "x-relay-id": stored.path.stem,
        "x-relay-cache": "hit" if result.cached else "miss",
        "x-relay-upstream": stored.meta.get("upstreamHost") or "",
        "x-relay-upstream-status": str(result.upstream_status),
    }
    if getattr(request.state, "prompt_truncated", False):
        headers["x-prompt-truncated"] = "true"
    request.state.log_extra.update(
        {
            "id": stored.path.stem,
            "bytes": stored.size,
            "cached": result.cached,
            "upstreamStatus": result.upstream_status,
            "sourceField": result.source_field,
        }
    )
    return JSONResponse(content=payload, headers=headers)


def _normalize(result, request: Request, settings) -> dict:
    """The gateway's own envelope: short URL in, upstream detail alongside."""
    stored = result.stored
    meta = stored.meta
    file_id = stored.file_id

    payload = {
        "id": stored.path.stem,
        "url": file_url(request, settings, file_id),
        "path": f"/files/{file_id}",
        "mimeType": stored.mime,
        "size": stored.size,
        "sha256": meta.get("sha256"),
        "cached": result.cached,
        "createdAt": meta.get("storedAt"),
        "prompt": meta.get("prompt"),
        "aspect": meta.get("aspect"),
        "upstream": {
            "host": meta.get("upstreamHost"),
            "path": meta.get("upstreamPath"),
            "status": result.upstream_status,
            "id": result.upstream_id,
            "sourceField": result.source_field,
        },
    }
    for key in ("width", "height"):
        value = meta.get(key)
        if isinstance(value, int):
            payload[key] = value
    if meta.get("c2pa"):
        payload["c2pa"] = True
    if getattr(request.state, "prompt_truncated", False):
        payload["promptTruncated"] = True
    return payload


# --- reading back --------------------------------------------------------
@router.get("/v1/images")
async def list_images(request: Request, limit: int = 20) -> JSONResponse:
    ctx = _ctx(request)
    settings = ctx.settings
    security.require_token(request, settings)

    limit = max(1, min(limit, 200))
    records = ctx.filestore.list(limit=limit)
    request.state.log_extra = {"kind": "gateway-list", "count": len(records)}

    base = public_base(request, settings)
    return JSONResponse(
        content={
            "count": len(records),
            "items": [_record_view(record, base) for record in records],
            "stats": ctx.filestore.stats(),
        }
    )


@router.get("/v1/images/{image_id}")
async def get_image(image_id: str, request: Request) -> JSONResponse:
    ctx = _ctx(request)
    settings = ctx.settings
    security.require_token(request, settings)

    stored = ctx.filestore.resolve(image_id)
    if stored is None:
        raise ApiError(404, "not_found", f"no image stored under {image_id!r}")

    request.state.log_extra = {"kind": "gateway-meta", "id": stored.path.stem}
    return JSONResponse(content=_record_view(stored.meta, public_base(request, settings)))


def _record_view(record: dict, base: str) -> dict:
    """One stored image, as seen from outside.

    The raw sidecar is not returned: it is an internal record and its shape is
    free to change. This is the stable view.
    """
    digest = str(record.get("id") or "")
    extension = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
    }.get(str(record.get("mimeType")), "")
    file_id = f"{digest}{extension}"

    view = {
        "id": digest,
        "url": f"{base}/files/{file_id}",
        "path": f"/files/{file_id}",
        "mimeType": record.get("mimeType"),
        "size": record.get("size"),
        "sha256": record.get("sha256"),
        "createdAt": record.get("storedAt"),
        "prompt": record.get("prompt"),
        "aspect": record.get("aspect"),
        "upstream": {
            "host": record.get("upstreamHost"),
            "path": record.get("upstreamPath"),
            "status": record.get("upstreamStatus"),
            "id": record.get("upstream_id"),
            "sourceField": record.get("sourceField"),
        },
    }
    for key in ("width", "height"):
        if isinstance(record.get(key), int):
            view[key] = record[key]
    if record.get("c2pa"):
        view["c2pa"] = True
    return view


# --- GET /files/{name} ---------------------------------------------------
# GET and HEAD are registered as two routes rather than one `api_route` with
# `methods=["GET", "HEAD"]`: FastAPI's default operation-id generator keys off
# `list(route.methods)[0]`, which for a two-method route is whichever the set
# happens to yield -- giving both operations the same id and a duplicate warning.
@router.get("/files/{name:path}")
@router.head("/files/{name:path}")
async def get_file(name: str, request: Request):
    """Serve stored bytes. Content-addressed, so the URL is immutable.

    `{name:path}` rather than `{name}` on purpose: a request carrying an encoded
    slash then *reaches* the id guard and is refused with an explicit 404, instead
    of falling through the non-match to the SPA catch-all and answering 200 with a
    page of HTML.

    `FileResponse` gives us Range support and honours a pre-set ETag, but it does
    *not* evaluate `If-None-Match` -- verified against Starlette, which answers
    200 where 304 is correct. So the conditional check is done here, before the
    response is built.
    """
    ctx = _ctx(request)
    settings = ctx.settings

    if settings.files_require_token:
        security.require_token(request, settings)

    stored = ctx.filestore.resolve(name)
    if stored is None:
        raise ApiError(404, "not_found", f"nothing stored under {name!r}")

    etag = etag_for(stored)
    modified = last_modified(stored)
    cache_headers = {
        "cache-control": IMMUTABLE_CACHE,
        "etag": etag,
        "last-modified": modified,
        # The bytes came from a third party. Even though the content type is
        # ours to choose, nosniff stops a browser from second-guessing it.
        "x-content-type-options": "nosniff",
        "x-relay-id": stored.path.stem,
    }

    if _not_modified(request, etag, modified):
        ctx.store.bump("file_not_modified")
        request.state.log_extra = {"kind": "file", "id": stored.path.stem, "notModified": True}
        return Response(status_code=304, headers=cache_headers)

    ctx.store.bump("file_served")
    request.state.log_extra = {
        "kind": "file",
        "id": stored.path.stem,
        "bytes": stored.size,
        "mime": stored.mime,
    }
    return FileResponse(stored.path, media_type=stored.mime, headers=cache_headers)


def _not_modified(request: Request, etag: str, modified: str) -> bool:
    """RFC 9110 conditional-GET evaluation, for the two headers that matter here."""
    if_none_match = request.headers.get("if-none-match")
    if if_none_match:
        # If-None-Match takes precedence over If-Modified-Since.
        return _etag_matches(if_none_match, etag)

    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since:
        try:
            since = parsedate_to_datetime(if_modified_since)
            actual = parsedate_to_datetime(modified)
        except (TypeError, ValueError):
            return False
        if since is None or actual is None:
            return False
        # HTTP dates have one-second resolution, so "not newer" is the test.
        return actual <= since

    return False


def _etag_matches(header: str, etag: str) -> bool:
    """`*`, `"a"`, `W/"a"`, or a comma-separated list of any of those."""
    if header.strip() == "*":
        return True
    wanted = etag.strip().lstrip("W/")
    for candidate in header.split(","):
        if candidate.strip().lstrip("W/") == wanted:
            return True
    return False


# --- GET /v1/config ------------------------------------------------------
@router.get("/v1/config")
async def public_config(request: Request) -> JSONResponse:
    """What a client needs to know before its first call. No secrets.

    Unauthenticated on purpose: a caller has to be able to discover whether a
    token is required *before* it has one.
    """
    settings = _ctx(request).settings
    reveal = _may_see_internals(request, settings)
    return JSONResponse(
        content={
            "service": "image-gateway",
            "gatewayEnabled": settings.gateway_enabled,
            "ready": settings.gateway_ready,
            "upstream": settings.upstream if reveal else None,
            "endpoints": {
                "generate": "POST /v1/images",
                "list": "GET /v1/images",
                "metadata": "GET /v1/images/{id}",
                "file": "GET /files/{name}",
            },
            "auth": {
                "required": settings.auth_required,
                "schemes": ["Authorization: Bearer <token>", "X-Relay-Token: <token>"],
            },
            "limits": {
                "maxBodyBytes": settings.max_body_bytes,
                "maxPromptChars": settings.max_prompt_chars,
                "promptOverflow": settings.prompt_overflow,
                "rateLimitPerMinute": settings.rate_limit_per_minute,
                "maxConcurrentUpstream": settings.max_concurrent_upstream,
                "queueTimeoutSeconds": settings.queue_timeout_s,
            },
            "modes": list(settings.modes),
            "aspectValidation": "upstream",
            "normalizeResponse": settings.normalize_response,
            "localValidation": settings.gateway_validate,
            "filesRequireToken": settings.files_require_token,
        }
    )


# --- GET /playground -----------------------------------------------------
# Two paths on purpose. Relying on Starlette's `redirect_slashes` would not work
# here: the SPA catch-all also matches `/playground/`, so the router never sees a
# no-match and never issues the redirect -- a trailing slash would quietly serve
# the mock landing page instead of the prompt box.
@router.get("/playground", include_in_schema=False)
@router.get("/playground/", include_in_schema=False)
async def playground() -> Response:
    """A prompt box for the gateway.

    Unauthenticated on purpose. It is a static page carrying no secret, and it has
    to be loadable *before* you have a token to type into it -- the token lives in
    a field the page keeps in localStorage and sends as `X-Relay-Token`. Nothing
    is baked into the HTML, so serving it to an anonymous caller gives nothing away.

    It is also not a gateway endpoint in the `/v1` sense: it spends nothing, and
    `relay.should_relay` never forwards it (it is outside `relay_paths`).
    """
    if not PLAYGROUND.is_file():
        raise ApiError(404, "not_found", "assets/playground/index.html is missing")
    # no-cache: this is a development surface, and a stale copy of the page is far
    # more confusing than a re-read on every load.
    return FileResponse(
        PLAYGROUND,
        media_type="text/html",
        headers={"cache-control": "no-cache"},
    )
