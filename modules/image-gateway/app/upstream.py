"""The origin's request contract.

Three things about an upstream call are dictated by the origin rather than by
us: the path it is served on, the header carrying the device credential, and
the shape of that credential. They live here so the rest of the code -- and the
documentation -- can say "the device header" without repeating the literal in
forty places.

Everything else about the origin comes from the environment and has **no
default**: this project ships knowing *how* to talk to an origin, not *which*
one.
"""

from __future__ import annotations

#: Where the origin serves image generation.
GENERATE_PATH = "/api/v1/media/ai/image"

#: The header the origin authenticates a device with. Client-facing code never
#: needs this name; the gateway substitutes the value under this key itself.
DEVICE_HEADER = "X-Mago-Device"

#: Lower-case form, for comparing against `request.headers` keys.
DEVICE_HEADER_LOWER = DEVICE_HEADER.lower()
