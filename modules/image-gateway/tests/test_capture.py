"""The extraction step itself: re.txt -> spec.json + a real sample image.

These tests fail loudly if the parsed capture is ever regenerated differently,
which is the point -- everything else in the mock is anchored to it.
"""

from __future__ import annotations

import hashlib
import json
import struct

import pytest

from app.aspects import (
    ASPECT_SIZES,
    SIDE_GRANULARITY,
    BadAspect,
    normalise,
    size_for,
)
from app.images import captured_metadata
from app.png import encode_png, placeholder_png
from conftest import CAPTURED_PNG, SPEC_JSON


# --- the captured image -------------------------------------------------
def test_captured_png_is_present_and_well_formed():
    assert CAPTURED_PNG.exists(), "run: python scripts/extract_capture.py"
    data = CAPTURED_PNG.read_bytes()

    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (1184, 864)


def test_captured_png_carries_c2pa_credentials():
    data = CAPTURED_PNG.read_bytes()
    assert b"caBX" in data[:16384]
    assert b"Google Media Processing Services" in data


def test_captured_metadata_helper():
    meta = captured_metadata()

    assert meta["width"] == 1184
    assert meta["height"] == 864
    assert meta["c2pa"] is True
    assert meta["bytes"] == CAPTURED_PNG.stat().st_size


# --- the parsed spec ----------------------------------------------------
def test_spec_has_three_captures():
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    assert [c["id"] for c in spec["captures"]] == ["ai-image", "inlined-png", "asset-font"]


def test_spec_first_capture_is_the_generation_call():
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    capture = spec["captures"][0]

    assert capture["method"] == "POST"
    assert capture["path"] == "/api/v1/media/ai/image"
    assert capture["body"]["mode"] == "image"
    assert capture["body"]["aspect"] == "4:3"
    assert len(capture["body"]["prompt"]) == 288
    assert capture["headers"]["X-Device-Id"].startswith("web-")
    assert capture["headers"]["Content-Type"] == "application/json"


def test_spec_records_that_the_inlined_png_url_was_destroyed():
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    entry = spec["captures"][1]

    assert entry["url"] is None
    assert "cannot be recovered" in entry["note"]
    assert entry["png"]["hasC2PA"] is True


def test_spec_png_bytes_match_the_extracted_file():
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    assert spec["captures"][1]["png"]["sha256"] == hashlib.sha256(CAPTURED_PNG.read_bytes()).hexdigest()


def test_spec_records_the_live_probe():
    spec = json.loads(SPEC_JSON.read_text(encoding="utf-8"))
    assert spec["probe"]["server"] == "Kestrel"
    assert len(spec["probe"]["observations"]) == 4


# --- aspect table -------------------------------------------------------
def test_the_verified_aspect_entries_are_the_measured_ones():
    """Five ratios were measured by generating one image each, 2026-09-24.

    The old table derived every other token from 4:3 by holding the long edge at
    1184px. That rule was wrong -- 16:9 came back 1344 wide -- so this test pins
    the measured values and the *count* of them, to stop a derived guess from
    silently re-acquiring the `verified` flag.
    """
    measured = {
        "1:1": (1024, 1024),
        "4:3": (1184, 864),
        "3:4": (864, 1184),
        "16:9": (1344, 768),
        "9:16": (768, 1344),
    }
    for token, size in measured.items():
        assert ASPECT_SIZES[token][:2] == size, token
        assert ASPECT_SIZES[token][2] is True, token

    assert sum(1 for entry in ASPECT_SIZES.values() if entry[2]) == len(measured)


def test_every_measured_side_is_a_multiple_of_thirty_two():
    """The pattern the guesses follow, and the one the old rule violated."""
    for token, (width, height, verified) in ASPECT_SIZES.items():
        if not verified:
            continue
        assert width % SIDE_GRANULARITY == 0, token
        assert height % SIDE_GRANULARITY == 0, token


@pytest.mark.parametrize(
    "token,expected",
    [("4:3", "4:3"), ("4x3", "4:3"), ("4/3", "4:3"), (" 8 : 6 ", "4:3"), ("16:9", "16:9")],
)
def test_normalise(token, expected):
    assert normalise(token) == expected


@pytest.mark.parametrize("token", ["", "wide", "4:3:2", "0:3", "-4:3"])
def test_normalise_rejects_junk(token):
    with pytest.raises(BadAspect):
        normalise(token)


def test_explicit_size_escape_hatch():
    assert size_for("1400x700") == (1400, 700)


def test_explicit_size_is_bounded():
    with pytest.raises(BadAspect):
        size_for("99999x700")


# --- the PNG encoder ----------------------------------------------------
def test_encode_png_round_trip():
    rows = [bytes([255, 0, 0]) * 4, bytes([0, 0, 255]) * 4]
    data = encode_png(4, 2, rows)

    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", data[16:24]) == (4, 2)


def test_encode_png_validates_input():
    with pytest.raises(ValueError):
        encode_png(4, 2, [b"\x00" * 12])  # only one row
    with pytest.raises(ValueError):
        encode_png(4, 1, [b"\x00" * 9])  # wrong row length


def test_placeholder_is_deterministic_and_seed_sensitive():
    a = placeholder_png("seed-a", 64, 48)
    b = placeholder_png("seed-a", 64, 48)
    c = placeholder_png("seed-b", 64, 48)

    assert a == b
    assert a != c
    assert struct.unpack(">II", a[16:24]) == (64, 48)
    assert len(a) < 20_000  # compresses well; catches an accidental pixel-data blowup
