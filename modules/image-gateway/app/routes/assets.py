"""Static asset serving.

The capture only ever *requested* one asset (a woff2 font); the response body was
not recorded, so we cannot ship it. Three policies, chosen with
IMAGE_GATEWAY_ASSET_MISS:

  not_found    (default) 404 + {"error":"asset_not_captured"} -- honest
  placeholder             200 with an empty body and the right content-type, so a
                          page under test does not break on a missing font
  proxy                   200 streamed from IMAGE_GATEWAY_ASSET_UPSTREAM (e.g.
                          https://upstream.example.com) -- real bytes, real network
"""

from __future__ import annotations

import mimetypes
import pathlib

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..images import ASSETS_DIR
from ..validation import ApiError

router = APIRouter()

GENERATED_PREFIX = "generated/"
UPLOADED_PREFIX = "uploaded/"


def _safe_path(relative: str) -> pathlib.Path | None:
    """Resolve inside ASSETS_DIR, refusing traversal."""
    candidate = (ASSETS_DIR / relative).resolve()
    try:
        candidate.relative_to(ASSETS_DIR.resolve())
    except ValueError:
        return None
    return candidate


@router.get("/assets/generated/{name}")
async def generated_asset(name: str, request: Request) -> Response:
    return _stored_asset(name, request, expected_kind="generated")


@router.get("/assets/uploaded/{name}")
async def uploaded_asset(name: str, request: Request) -> Response:
    return _stored_asset(name, request, expected_kind="uploaded")


def _stored_asset(name: str, request: Request, expected_kind: str) -> Response:
    ctx = request.app.state.ctx
    wants_metadata = name.endswith(".json")
    stem = name
    for suffix in (".png", ".bin", ".json"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break

    record = ctx.store.get(stem)
    if record is None or record.get("kind") != expected_kind:
        raise ApiError(404, "unknown_generation", f"nothing stored under {stem!r}")

    request.state.log_extra = {"kind": f"{expected_kind}-asset", "id": stem}

    if wants_metadata:
        payload = record["payload"]
        return JSONResponse(content=payload.get("_meta", payload))

    return Response(
        content=record["bytes"],
        media_type=record["mime"],
        headers={"Cache-Control": "no-store"},
    )


@router.get("/assets/{path:path}")
async def static_asset(path: str, request: Request) -> Response:
    ctx = request.app.state.ctx
    settings = ctx.settings

    if path.startswith(GENERATED_PREFIX) or path.startswith(UPLOADED_PREFIX):
        raise ApiError(404, "unknown_generation", f"nothing stored at /assets/{path}")

    resolved = _safe_path(path)
    if resolved is None:
        raise ApiError(400, "bad_path")

    if resolved.is_file():
        request.state.log_extra = {"kind": "asset", "asset": path, "served": "local"}
        media_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        return Response(content=resolved.read_bytes(), media_type=media_type)

    request.state.log_extra = {"kind": "asset", "asset": path, "served": settings.asset_miss}

    if settings.asset_miss == "placeholder":
        media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        return Response(
            content=b"",
            media_type=media_type,
            headers={"X-Mock-Placeholder": "true"},
        )

    if settings.asset_miss == "proxy":
        return await _proxy(path, settings.asset_upstream)

    raise ApiError(404, "asset_not_captured", f"/assets/{path} was never captured")


async def _proxy(path: str, upstream: str) -> Response:
    url = f"{upstream}/assets/{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            upstream_response = await client.get(url)
    except httpx.HTTPError as exc:
        raise ApiError(502, "upstream_error", f"{type(exc).__name__} fetching {url}") from None

    if upstream_response.status_code != 200:
        raise ApiError(upstream_response.status_code, "asset_not_captured", f"upstream {url}")

    media_type = upstream_response.headers.get("content-type", "application/octet-stream")
    return Response(
        content=upstream_response.content,
        media_type=media_type.split(";")[0],
        headers={"X-Mock-Proxied": upstream},
    )
