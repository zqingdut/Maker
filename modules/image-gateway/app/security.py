"""Gateway access control: a shared token, and a per-caller rate limit.

An open relay is worse than no relay: anyone who can reach the port can spend the
upstream quota that the gateway's credentials unlock. So the token is checked
with a constant-time comparison, and the limiter keys on the credential (falling
back to the peer address) rather than on the request path.
"""

from __future__ import annotations

import hmac
import threading
import time
from collections import deque

from .validation import ApiError

TOKEN_HEADER = "x-relay-token"
BEARER_PREFIX = "bearer "


def presented_token(headers) -> str | None:
    """Accept `Authorization: Bearer <t>` or `X-Relay-Token: <t>`."""
    direct = headers.get(TOKEN_HEADER)
    if direct:
        return direct.strip()
    authorization = headers.get("authorization")
    if authorization and authorization.lower().startswith(BEARER_PREFIX):
        return authorization[len(BEARER_PREFIX) :].strip()
    return None


def caller_key(request, settings) -> str:
    """Identify the caller for rate limiting: credential first, then address."""
    token = presented_token(request.headers)
    if token:
        # Do not store the token itself in the limiter's keys.
        import hashlib

        return "tok:" + hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]
    client = request.client
    return "ip:" + (client.host if client else "unknown")


def require_token(request, settings) -> None:
    if not settings.auth_required:
        return
    presented = presented_token(request.headers)
    if not presented:
        raise ApiError(401, "missing_token", "send Authorization: Bearer <token>")
    # compare_digest: never let response timing narrow down the token.
    if not hmac.compare_digest(presented, settings.access_token):
        raise ApiError(401, "invalid_token")


class RateLimiter:
    """Sliding-window limiter, in-process.

    Deliberately not distributed: this is a single-process gateway. Behind more
    than one worker the effective limit multiplies, which is documented rather
    than hidden behind a fake global counter.
    """

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.per_minute > 0

    def check(self, key: str, now: float | None = None) -> int:
        """Return the Retry-After seconds if the caller is over budget, else 0."""
        if not self.enabled:
            return 0
        now = time.monotonic() if now is None else now
        window_start = now - 60.0

        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= window_start:
                hits.popleft()

            if len(hits) >= self.per_minute:
                return max(1, int(hits[0] + 60.0 - now) + 1)

            hits.append(now)
            # Keep the key space bounded even under many distinct callers.
            if len(self._hits) > 10_000:
                for stale in [k for k, v in self._hits.items() if not v][:1000]:
                    self._hits.pop(stale, None)
            return 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "perMinute": self.per_minute,
                "trackedCallers": len(self._hits),
            }
