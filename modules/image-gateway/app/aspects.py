"""Aspect token -> output pixel size.

Five tokens are now **measured**, not guessed. Generating one image per ratio
against the real service (2026-09-24) produced:

    1:1   -> 1024 x 1024   (exactly 1:1)
    4:3   -> 1184 x  864   (ratio 1.3704, *not* 1.3333)
    3:4   ->  864 x 1184
    16:9  -> 1344 x  768   (exactly 16:9)
    9:16  ->  768 x 1344
    99:1  -> 1184 x  864   <- an unrecognised ratio falls back to the 4:3 frame

Two things follow, and both replaced an earlier guess that was wrong:

  * The "hold the long edge at 1184px" rule this module used to derive the other
    tokens is **false** -- 16:9 came back 1344 wide, not 1184. The old derived
    entries for 16:9/9:16 (1184x672 / 672x1184) were simply incorrect.
  * Every measured side is a multiple of **32**, and every measured area sits in
    a narrow 1.02-1.05 MP band. That is a much better basis for guessing a token
    we have not measured, and the guesses below now follow it.

Anything still marked `False` is a guess. Fix this one table when you measure it.
"""

from __future__ import annotations

import re

#: token -> (width, height, verified_against_real_service)
ASPECT_SIZES: dict[str, tuple[int, int, bool]] = {
    # --- measured by generating one image per ratio, 2026-09-24 ---
    "1:1": (1024, 1024, True),
    "4:3": (1184, 864, True),
    "3:4": (864, 1184, True),
    "16:9": (1344, 768, True),
    "9:16": (768, 1344, True),
    # --- not measured; guessed by holding the area near 1.03 MP with both sides
    #     on a multiple of 32, which is the pattern the measured set follows ---
    "3:2": (1248, 832, False),
    "2:3": (832, 1248, False),
    "5:4": (1152, 928, False),
    "4:5": (928, 1152, False),
    "21:9": (1568, 672, False),
    "2:1": (1440, 704, False),
    "1:2": (704, 1440, False),
}

#: What the origin serves for a ratio it does not recognise. Observed: `"99:1"`
#: returned 200 at 1184x864 -- the 4:3 frame, not an error and not a 99:1 image.
FALLBACK_TOKEN = "4:3"

#: Every measured side is a multiple of this. Useful when adding a guess.
SIDE_GRANULARITY = 32

_TOKEN_RE = re.compile(r"^\s*(\d{1,3})\s*[:x/]\s*(\d{1,3})\s*$")
_EXPLICIT_RE = re.compile(r"^\s*(\d{2,4})\s*[xX]\s*(\d{2,4})\s*$")

MAX_SIDE = 4096


class BadAspect(ValueError):
    """Raised for an aspect token the mock does not know how to size."""


def normalise(token: str) -> str:
    """'4x3' / '4/3' / ' 4 : 3 ' -> '4:3' (reduced by gcd)."""
    m = _TOKEN_RE.match(token or "")
    if not m:
        raise BadAspect(f"unparsable aspect token: {token!r}")
    w, h = int(m.group(1)), int(m.group(2))
    if w <= 0 or h <= 0:
        raise BadAspect(f"non-positive aspect: {token!r}")
    from math import gcd

    d = gcd(w, h)
    return f"{w // d}:{h // d}"


def size_for(token: str) -> tuple[int, int]:
    """Resolve an aspect token to (width, height).

    Accepts the ratio tokens above plus an explicit "WIDTHxHEIGHT" escape hatch,
    which is a mock-only extension.
    """
    if not isinstance(token, str) or not token.strip():
        raise BadAspect("empty aspect")

    explicit = _EXPLICIT_RE.match(token)
    if explicit and ":" not in token and "/" not in token:
        w, h = int(explicit.group(1)), int(explicit.group(2))
        if not (16 <= w <= MAX_SIDE and 16 <= h <= MAX_SIDE):
            raise BadAspect(f"explicit size out of range: {w}x{h}")
        return w, h

    key = normalise(token)
    entry = ASPECT_SIZES.get(key)
    if entry is None:
        raise BadAspect(f"unsupported aspect: {key}")
    return entry[0], entry[1]


def is_verified(token: str) -> bool:
    try:
        entry = ASPECT_SIZES.get(normalise(token))
    except BadAspect:
        return False
    return bool(entry and entry[2])


def supported() -> list[dict]:
    return [
        {
            "aspect": token,
            "width": w,
            "height": h,
            "verified": verified,
        }
        for token, (w, h, verified) in ASPECT_SIZES.items()
    ]
