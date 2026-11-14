"""Application factory.

Behaviour deliberately mirrored from a live probe of the origin:

  * `Server: Kestrel`               (the real backend is ASP.NET Core)
  * unmatched GET  -> 200 text/html (SPA fallback, NOT 404)
  * unmatched POST -> 405, Allow: GET, HEAD, empty body
  * 400 {"error":"bad_mode"}        (flat snake_case envelope, no wrapper)
  * unexpected errors never leak upstream detail to the caller
"""

from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import time
import traceback

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware

from .config import Settings
from .filestore import FileStore
from .security import RateLimiter
from .store import Store
from .upstream import DEVICE_HEADER_LOWER
from .validation import ApiError, BindingError
from . import relay
from .routes import assets, control, gateway, media

logger = logging.getLogger("image-gateway")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPA_FALLBACK = ROOT / "assets" / "web" / "index.html"

MINIMAL_FALLBACK = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>image-gateway</title></head>
<body style="font:14px/1.6 ui-monospace,monospace;padding:2rem">
<h1>image-gateway</h1>
<p>SPA fallback. The real service answers unmatched GETs with index.html.</p>
<p>API: <code>POST /api/v1/media/ai/image</code> &middot;
      state: <code>GET /__mock__/state</code></p>
</body></html>
"""


class Context:
    """Everything the routes need, hung off app.state."""

    __slots__ = (
        "settings",
        "store",
        "started_at",
        "relay_transport",
        "filestore",
        "upstream_semaphore",
        "rate_limiter",
    )

    def __init__(self, settings: Settings, relay_transport=None):
        self.settings = settings
        log_path = pathlib.Path(settings.log_path) if settings.log_path else None
        self.store = Store(log_path=log_path, log_enabled=settings.log_requests)
        self.started_at = time.time()
        #: Injection point for tests: an httpx transport that stands in for the
        #: real origin. None means "use the network".
        self.relay_transport = relay_transport
        #: Re-hosted images. Constructing this touches no disk -- the directory
        #: is only created when something is actually stored.
        self.filestore = FileStore(settings.resolved_files_dir)
        #: Caps simultaneous upstream calls. Constructing a Semaphore outside a
        #: running loop is safe on 3.10+; it binds lazily on first await.
        self.upstream_semaphore = asyncio.Semaphore(max(1, settings.max_concurrent_upstream))
        self.rate_limiter = RateLimiter(settings.rate_limit_per_minute)


def _warn_about_proxy_env(settings) -> None:
    """Say at boot that a proxy in the environment will take over every call.

    `relay_trust_env` defaults to True, so `HTTPS_PROXY` in the service
    environment silently reroutes paid generations. The failure surfaces much
    later as a 502 that looks exactly like the origin being down. Naming the
    variable at startup turns that into a one-line diagnosis.

    Only the variable *names* are logged: a proxy URL can carry credentials.
    """
    if not settings.relay_trust_env:
        return
    names = [
        name
        for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")
        if os.environ.get(name)
    ]
    if names:
        logger.warning(
            "outbound calls follow the proxy in %s; set IMAGE_GATEWAY_RELAY_TRUST_ENV=false "
            "to connect directly",
            ", ".join(names),
        )


def create_app(settings: Settings | None = None, relay_transport=None) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(
        title="image-gateway",
        version="1.0.0",
        description=(
            "A local stand-in for the upstream.example.com media API, reconstructed from a "
            "captured browser session (re.txt). Runs in `mock` mode by default; set "
            "IMAGE_GATEWAY_MODE=relay to forward real requests to IMAGE_GATEWAY_UPSTREAM."
        ),
        docs_url="/__mock__/docs",
        openapi_url="/__mock__/openapi.json",
        redoc_url=None,
    )
    app.state.ctx = Context(settings, relay_transport)
    _warn_about_proxy_env(settings)

    # ------------------------------------------------------------------
    # CORS. The real service sends no CORS headers at all (same-origin app);
    # a dev mock is usually called from another origin, so this defaults on.
    # Set IMAGE_GATEWAY_CORS= to reproduce the real behaviour exactly.
    # ------------------------------------------------------------------
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=[
                "X-Mock-Injected",
                "X-Mock-Placeholder",
                "X-Mock-Proxied",
                "X-Mock-Relay",
                "X-Mock-Upstream-Status",
                "X-Relay-Id",
                "X-Relay-Cache",
                "X-Relay-Upstream",
                "X-Relay-Upstream-Status",
                "Retry-After",
                "Location",
                "ETag",
            ],
        )

    # ------------------------------------------------------------------
    # Relay gate + request logging + server header + body guard.
    #
    # The relay decision has to happen before routing, because in relay mode the
    # request must not be answered by a local route at all. Keeping it in this one
    # middleware also guarantees relayed calls get logged like everything else.
    # ------------------------------------------------------------------
    @app.middleware("http")
    async def observe(request: Request, call_next):
        ctx: Context = app.state.ctx
        started = time.perf_counter()

        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > ctx.settings.max_body_bytes:
            response = JSONResponse(status_code=413, content={"error": "payload_too_large"})
        else:
            try:
                if relay.should_relay(request, ctx.settings):
                    body = await request.body()
                    if len(body) > ctx.settings.max_body_bytes:
                        raise ApiError(413, "payload_too_large")
                    response = await relay.forward(request, ctx, body)
                else:
                    response = await call_next(request)
            except ApiError as exc:
                response = _error_response(exc)
            except Exception:
                # Catch here rather than letting ServerErrorMiddleware do it, so the
                # failure is logged and gets the same headers as every other response.
                logger.error("unhandled error on %s %s", request.method, request.url.path)
                logger.error("%s", traceback.format_exc())
                response = JSONResponse(status_code=500, content={"error": "internal_error"})

        if ctx.settings.server_header:
            response.headers["server"] = ctx.settings.server_header
        response.headers.setdefault("x-mock", "image-gateway")

        # Always feed the in-memory ring buffer -- IMAGE_GATEWAY_LOG_REQUESTS only
        # decides whether the JSONL file is written. The control plane reads the
        # buffer, so "what did my client send?" works even with logging off.
        if request.url.path != "/__mock__/requests":
            record = {
                "ts": _iso_now(),
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query) or None,
                "status": response.status_code,
                "durationMs": round((time.perf_counter() - started) * 1000, 1),
                "device": request.headers.get(DEVICE_HEADER_LOWER),
                "origin": request.headers.get("origin"),
                "userAgent": request.headers.get("user-agent"),
            }
            record.update(getattr(request.state, "log_extra", None) or {})
            ctx.store.log_request(record)

        return response

    # ------------------------------------------------------------------
    # Error envelope: {"error": "<code>"} -- never a FastAPI 422 shape, and
    # never an upstream stack trace.
    # ------------------------------------------------------------------
    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return _error_response(exc)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(
            status_code=400,
            content={
                "error": "bad_body",
                "detail": [
                    {"loc": list(err.get("loc", ())), "msg": err.get("msg", "")}
                    for err in exc.errors()
                ],
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_handler(request: Request, exc: Exception):
        logger.error("unhandled error on %s %s", request.method, request.url.path)
        logger.error("%s", traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={"error": "internal_error"},
            headers={"X-Mock-Injected": "false"},
        )

    # ------------------------------------------------------------------
    # Routes. Order matters: the SPA catch-all is registered last.
    # ------------------------------------------------------------------
    app.include_router(control.router)
    app.include_router(gateway.router)
    app.include_router(media.router)
    app.include_router(assets.router)

    # ------------------------------------------------------------------
    # The H5 manual, if it has been built. Mounted so the prompt box's link to it
    # resolves same-origin, which also means one server rather than two.
    #
    # `check_dir=False` on purpose: the manual is a *generated* artifact
    # (`scripts/build_manual.py`), and its absence must never stop the app from
    # booting -- a missing directory should 404, not raise at import time.
    # ------------------------------------------------------------------
    app.mount(
        "/manual",
        StaticFiles(directory=ROOT / "docs" / "manual", html=True, check_dir=False),
        name="manual",
    )

    @app.api_route(
        "/{full_path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def spa_fallback(full_path: str, request: Request):
        if request.method == "OPTIONS":
            # Observed: OPTIONS /api/v1/media/ai/image -> 204, no body, no CORS headers.
            # (With IMAGE_GATEWAY_CORS enabled the CORS middleware answers preflights first.)
            return Response(status_code=204)

        if request.method in ("GET", "HEAD"):
            request.state.log_extra = {"spaFallback": True}
            body = SPA_FALLBACK.read_text(encoding="utf-8") if SPA_FALLBACK.exists() else MINIMAL_FALLBACK
            if request.method == "HEAD":
                return Response(status_code=200, media_type="text/html", headers={"cache-control": "no-cache"})
            return Response(
                content=body,
                status_code=200,
                media_type="text/html",
                headers={"cache-control": "no-cache"},
            )

        # Observed on the real service: POST to a non-route -> 405, Allow: GET, HEAD
        request.state.log_extra = {"methodNotAllowed": True}
        return Response(status_code=405, headers={"allow": "GET, HEAD"})

    return app


def _error_response(exc: ApiError) -> JSONResponse:
    headers = dict(exc.headers)
    if exc.note:
        try:
            exc.note.encode("ascii")
        except UnicodeEncodeError:
            pass  # keep non-ASCII notes out of HTTP headers
        else:
            headers.setdefault("X-Mock-Error-Note", exc.note)
    # A binding failure is a problem+json document, and the real service labels it
    # as one. Sending it as application/json would be the wrong media type for a
    # client that dispatches on Content-Type.
    if isinstance(exc, BindingError):
        headers.setdefault("Content-Type", "application/problem+json; charset=utf-8")
    return JSONResponse(status_code=exc.status, content=exc.envelope(), headers=headers or None)


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


#: uvicorn entry point: `uvicorn app.main:app`
app = create_app()
