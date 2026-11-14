"""Runtime configuration.

Everything is env-overridable with the IMAGE_GATEWAY_ prefix, and everything has a
safe default so `python -m uvicorn app.main:app` works with zero setup.
"""

from __future__ import annotations

import json
import os
import pathlib
from dataclasses import dataclass, field, fields

ENV_PREFIX = "IMAGE_GATEWAY_"


def secret_hint(value: str, keep: int = 4) -> str:
    """`web-00000000-…-0000` -> `web-…0000`.

    Enough to tell two secrets apart in a log, not enough to use one.
    """
    if not value:
        return ""
    if len(value) <= keep * 2:
        return "***"
    return f"{value[:keep]}…{value[-keep:]}"


def _env(name: str, default: str) -> str:
    return os.environ.get(ENV_PREFIX + name, default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(ENV_PREFIX + name)
    if raw is None or raw == "":
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(ENV_PREFIX + name)
    if raw is None or raw == "":
        return default
    return float(raw)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(ENV_PREFIX + name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_list(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    """Comma-separated list.

    An *unset* variable keeps the default; a variable that is set but empty means
    "no values", which is how IMAGE_GATEWAY_CORS= turns CORS off.
    """
    if ENV_PREFIX + name not in os.environ:
        return default
    raw = os.environ[ENV_PREFIX + name]
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _env_json(name: str, default: dict | None = None) -> dict:
    raw = os.environ.get(ENV_PREFIX + name)
    if raw is None or raw.strip() == "":
        return dict(default or {})
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{ENV_PREFIX}{name} must be JSON: {exc}") from None
    if not isinstance(parsed, dict):
        raise ValueError(f"{ENV_PREFIX}{name} must be a JSON object")
    return {str(k): str(v) for k, v in parsed.items()}


@dataclass
class Settings:
    # --- server ---------------------------------------------------------
    host: str = "127.0.0.1"
    port: int = 4399
    #: The real service is ASP.NET Core behind Kestrel, so we advertise the same
    #: server header. Set to "" to let uvicorn use its own.
    server_header: str = "Kestrel"
    #: The real service returns no CORS headers (the app is same-origin). A dev
    #: mock is usually called cross-origin, so we default to permissive and
    #: document the deviation. Set IMAGE_GATEWAY_CORS= to restore real behaviour.
    cors_origins: tuple[str, ...] = ("*",)

    # --- request contract ------------------------------------------------
    #: Only "image" was ever observed. Anything else gets {"error":"bad_mode"},
    #: which is exactly what the real service does for an unknown mode.
    modes: tuple[str, ...] = ("image",)
    #: The real service validated `mode` before anything else (probe: POST {} -> bad_mode).
    default_aspect: str = "4:3"
    max_prompt_chars: int = 4000
    #: What to do when a prompt is longer than `max_prompt_chars`:
    #:   "truncate" (default) -- cut it and generate anyway, flagging the cut
    #:   "reject"             -- 400 {"error":"prompt_too_long"}
    #: Truncating is the default because a caller who pasted too much text wants
    #: an image, not a validation lecture. `reject` exists for callers who would
    #: rather fail loudly than ship an image built from half their prompt.
    prompt_overflow: str = "truncate"
    max_body_bytes: int = 16 * 1024 * 1024
    #: Observed device header shape: "web-<uuid>". When True, a missing or
    #: malformed header is rejected with {"error":"bad_device"}.
    require_device: bool = False
    device_pattern: str = r"^web-[0-9a-fA-F-]{36}$"

    # --- response ---------------------------------------------------------
    #: inline | url | openai  -- see app/responses.py
    response_style: str = "inline"
    #: captured | placeholder -- which image bytes to return
    variant: str = "captured"
    #: Base URL used to build absolute image URLs in `url` style. Empty means
    #: "derive from the incoming request".
    public_base_url: str = ""
    #: Include the C2PA note in the response payload.
    report_credential: bool = True

    # --- simulation -------------------------------------------------------
    latency_min_ms: int = 700
    latency_max_ms: int = 2200
    #: 0.0 = never fail. 0.05 = 5% of calls get a simulated upstream failure.
    fail_rate: float = 0.0
    fail_status: int = 502
    #: Deterministic per-prompt ids/images. Off means every call differs.
    deterministic: bool = True

    # --- assets -----------------------------------------------------------
    #: not_found | placeholder | proxy
    asset_miss: str = "not_found"
    #: Used when asset_miss == "proxy". Falls back to `upstream` when empty.
    asset_upstream: str = ""

    # --- relay (中转) ------------------------------------------------------
    #: mock  -- always answer locally (default; never spends money)
    #: relay -- forward matching requests to `upstream` and return its response
    mode: str = "mock"
    #: The real origin, e.g. https://upstream.example.com. Empty disables relay entirely.
    upstream: str = ""
    #: Only these path prefixes may be forwarded. A relay that forwards anything
    #: is an open proxy, so the allowlist is not optional.
    relay_paths: tuple[str, ...] = ("/api/", "/assets/")
    relay_timeout_s: float = 60.0
    #: Extra headers to send upstream (auth tokens live here, never in the API).
    relay_headers: dict = field(default_factory=dict)
    #: Pass the client's own headers through (minus hop-by-hop and X-Mock-*).
    relay_forward_client_headers: bool = True
    #: Honour HTTP_PROXY/HTTPS_PROXY for the outbound leg. Correct for a relay
    #: that must traverse a corporate or sandbox proxy to reach the internet.
    relay_trust_env: bool = True

    # --- gateway (中转站) --------------------------------------------------
    #: The wrapped, client-facing flow at POST /v1/images. Needs `upstream`.
    gateway_enabled: bool = True
    #: Shared secret every client must present. Empty means the gateway is OPEN --
    #: anyone who can reach the port can spend your upstream quota. Set it.
    access_token: str = ""
    #: The device id the gateway presents upstream, shape ``web-<uuid>``. Clients
    #: never see it. **Empty by default on purpose**: the value in the original
    #: capture is a real credential belonging to whoever took that capture, so it
    #: is not shipped here. Set IMAGE_GATEWAY_DEVICE_ID from your own capture.
    device_id: str = ""
    #: Replace the client's device header with `device_id` (the point of a gateway).
    #: Only takes effect when `device_id` is set -- see `gateway._build_headers`.
    override_device: bool = True
    #: Where re-hosted images live. Empty -> <project>/data/files
    files_dir: str = ""
    #: Require the access token to fetch /files/* too. Off by default so an
    #: <img src> works; ids are 128-bit and unguessable.
    files_require_token: bool = False
    #: Requests per minute per credential. 0 disables the limiter.
    rate_limit_per_minute: int = 0
    #: Cap on simultaneous upstream calls; excess callers wait, then get 503.
    max_concurrent_upstream: int = 8
    queue_timeout_s: float = 10.0
    #: Retries for the outbound leg. See app/gateway.py -- retrying a *paid*
    #: generation can bill twice, so this only ever retries connect-stage
    #: failures, and 0 is the default for a reason.
    relay_retries: int = 0
    #: Rewrite the upstream's inline image into a short URL on this host.
    normalize_response: bool = True
    #: Reject a request locally when it is obviously unusable (missing mode,
    #: empty prompt) instead of spending an upstream call to be told so. Only
    #: checks we can reproduce *identically* to the origin are applied -- `mode`
    #: ordering was observed live, `prompt` is inferred. Aspect is never checked
    #: here: our size table is a local guess, so the origin stays the authority.
    #: Set to 0 to forward everything untouched.
    gateway_validate: bool = True

    # --- observability ----------------------------------------------------
    log_requests: bool = True
    log_path: str = ""  # default: <project>/capture/requests.jsonl

    extra: dict = field(default_factory=dict)

    # ------------------------------------------------------------------
    @classmethod
    def from_env(cls) -> "Settings":
        s = cls(
            host=_env("HOST", cls.host),
            port=_env_int("PORT", cls.port),
            server_header=_env("SERVER_HEADER", cls.server_header),
            cors_origins=_env_list("CORS", cls.cors_origins),
            modes=_env_list("MODES", cls.modes),
            default_aspect=_env("DEFAULT_ASPECT", cls.default_aspect),
            max_prompt_chars=_env_int("MAX_PROMPT_CHARS", cls.max_prompt_chars),
            prompt_overflow=_env("PROMPT_OVERFLOW", cls.prompt_overflow).strip().lower(),
            max_body_bytes=_env_int("MAX_BODY_BYTES", cls.max_body_bytes),
            require_device=_env_bool("REQUIRE_DEVICE", cls.require_device),
            device_pattern=_env("DEVICE_PATTERN", cls.device_pattern),
            response_style=_env("RESPONSE_STYLE", cls.response_style),
            variant=_env("VARIANT", cls.variant),
            public_base_url=_env("PUBLIC_BASE_URL", cls.public_base_url).rstrip("/"),
            report_credential=_env_bool("REPORT_CREDENTIAL", cls.report_credential),
            latency_min_ms=_env_int("LATENCY_MIN_MS", cls.latency_min_ms),
            latency_max_ms=_env_int("LATENCY_MAX_MS", cls.latency_max_ms),
            fail_rate=_env_float("FAIL_RATE", cls.fail_rate),
            fail_status=_env_int("FAIL_STATUS", cls.fail_status),
            deterministic=_env_bool("DETERMINISTIC", cls.deterministic),
            asset_miss=_env("ASSET_MISS", cls.asset_miss),
            asset_upstream=_env("ASSET_UPSTREAM", cls.asset_upstream).rstrip("/"),
            mode=_env("MODE", cls.mode),
            upstream=_env("UPSTREAM", cls.upstream).rstrip("/"),
            relay_paths=_env_list("RELAY_PATHS", cls.relay_paths),
            relay_timeout_s=_env_float("RELAY_TIMEOUT_S", cls.relay_timeout_s),
            relay_headers=_env_json("RELAY_HEADERS"),
            relay_forward_client_headers=_env_bool(
                "RELAY_FORWARD_CLIENT_HEADERS", cls.relay_forward_client_headers
            ),
            relay_trust_env=_env_bool("RELAY_TRUST_ENV", cls.relay_trust_env),
            gateway_enabled=_env_bool("GATEWAY_ENABLED", cls.gateway_enabled),
            access_token=_env("ACCESS_TOKEN", cls.access_token),
            device_id=_env("DEVICE_ID", cls.device_id),
            override_device=_env_bool("OVERRIDE_DEVICE", cls.override_device),
            files_dir=_env("FILES_DIR", cls.files_dir),
            files_require_token=_env_bool("FILES_REQUIRE_TOKEN", cls.files_require_token),
            rate_limit_per_minute=_env_int("RATE_LIMIT_PER_MINUTE", cls.rate_limit_per_minute),
            max_concurrent_upstream=_env_int(
                "MAX_CONCURRENT_UPSTREAM", cls.max_concurrent_upstream
            ),
            queue_timeout_s=_env_float("QUEUE_TIMEOUT_S", cls.queue_timeout_s),
            relay_retries=_env_int("RELAY_RETRIES", cls.relay_retries),
            normalize_response=_env_bool("NORMALIZE_RESPONSE", cls.normalize_response),
            gateway_validate=_env_bool("GATEWAY_VALIDATE", cls.gateway_validate),
            log_requests=_env_bool("LOG_REQUESTS", cls.log_requests),
            log_path=_env("LOG_PATH", cls.log_path),
        )
        # asset_miss=proxy can borrow the relay origin instead of a second knob.
        if s.asset_miss == "proxy" and not s.asset_upstream:
            s.asset_upstream = s.upstream
        s.validate()
        return s

    def validate(self) -> None:
        if self.response_style not in ("inline", "url", "openai"):
            raise ValueError(f"unknown response style: {self.response_style}")
        if self.variant not in ("captured", "placeholder"):
            raise ValueError(f"unknown variant: {self.variant}")
        if self.asset_miss not in ("not_found", "placeholder", "proxy"):
            raise ValueError(f"unknown asset_miss policy: {self.asset_miss}")
        if self.asset_miss == "proxy" and not self.asset_upstream:
            raise ValueError(
                "asset_miss=proxy requires IMAGE_GATEWAY_ASSET_UPSTREAM or IMAGE_GATEWAY_UPSTREAM"
            )
        if self.mode not in ("mock", "relay"):
            raise ValueError(f"mode must be 'mock' or 'relay', got {self.mode!r}")
        if self.mode == "relay" and not self.upstream:
            raise ValueError("mode=relay requires IMAGE_GATEWAY_UPSTREAM")
        if self.upstream and not self.upstream.startswith(("http://", "https://")):
            raise ValueError(f"upstream must be an absolute http(s) origin: {self.upstream!r}")
        if not self.relay_paths:
            raise ValueError("relay_paths must not be empty when relay is configured")
        if any(not p.startswith("/") for p in self.relay_paths):
            raise ValueError("every relay path must start with '/'")
        if self.relay_timeout_s <= 0:
            raise ValueError("relay_timeout_s must be positive")
        if self.max_concurrent_upstream < 1:
            raise ValueError("max_concurrent_upstream must be at least 1")
        if self.queue_timeout_s < 0:
            raise ValueError("queue_timeout_s must not be negative")
        if self.relay_retries < 0:
            raise ValueError("relay_retries must not be negative")
        if self.rate_limit_per_minute < 0:
            raise ValueError("rate_limit_per_minute must not be negative")
        # Deliberately NOT an error: `gateway_enabled` with no upstream. The
        # gateway still boots and its routes exist; they answer 503 no_upstream
        # until IMAGE_GATEWAY_UPSTREAM is set. Failing here would break the
        # zero-config `uvicorn app.main:app`, which is a promise this module makes.
        if self.files_require_token and not self.access_token:
            raise ValueError("files_require_token requires IMAGE_GATEWAY_ACCESS_TOKEN")
        if self.latency_max_ms < self.latency_min_ms:
            raise ValueError("latency_max_ms < latency_min_ms")
        if not 0.0 <= self.fail_rate <= 1.0:
            raise ValueError("fail_rate must be within [0, 1]")

    def as_dict(self) -> dict:
        """Safe for the unauthenticated /__mock__/state endpoint: secrets redacted."""
        out = {f.name: getattr(self, f.name) for f in fields(self) if f.name != "extra"}
        if out.get("relay_headers"):
            out["relay_headers"] = {name: "***" for name in out["relay_headers"]}
        if out.get("access_token"):
            out["access_token"] = "***"
        # The device id is what the gateway presents *instead of* the client's, so
        # publishing it verbatim would hand back the very thing the gateway holds.
        if out.get("device_id"):
            out["device_id"] = secret_hint(out["device_id"])
        return out

    @property
    def relay_enabled(self) -> bool:
        return bool(self.upstream)

    @property
    def resolved_files_dir(self) -> pathlib.Path:
        if self.files_dir:
            return pathlib.Path(self.files_dir).expanduser().resolve()
        return pathlib.Path(__file__).resolve().parent.parent / "data" / "files"

    @property
    def auth_required(self) -> bool:
        return bool(self.access_token)

    @property
    def gateway_ready(self) -> bool:
        """True when POST /v1/images can actually do its job.

        False is not an error state -- it is what a zero-config boot looks like,
        and the gateway answers 503 no_upstream until an origin is configured.
        """
        return self.gateway_enabled and bool(self.upstream)
