"""The failure explanations the two pages show.

The gateway's error body is deliberately just `{"error": "<code>"}`: it
reconstructs the origin's envelope, and inventing a `message` key there would
make the mock disagree with the thing it exists to imitate. So the human
explanation lives in the pages, keyed by code.

That leaves one way to get it wrong: the backend grows a code and the pages
never learn to explain it, so the user is shown `upstream_error` and nothing
else. These tests are about that gap, not about the wording.

The two pages are separate static files with no build step -- `test_the_page_is_
self_contained` forbids a shared `<script src>` -- so the table is necessarily
duplicated. Duplication is fine; drift is not.
"""

from __future__ import annotations

import pathlib
import re

from app.main import SPA_FALLBACK
from app.routes.gateway import PLAYGROUND

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"

#: Codes the generate button cannot produce, so the generic fallback may handle
#: them. They belong to the control plane (`/__mock__/config`, `/__mock__/state`),
#: the asset route, a relay directive header, or are `_error_code_for`'s default.
NOT_REACHED_FROM_GENERATE = {
    "bad_config",
    "bad_source",
    "bad_path",
    "bad_mode_directive",
    "path_not_relayable",
    "no_capture",
    "error",
}

#: Codes that reach the pages without going through `ApiError(...)`: the mock's
#: injected-failure status map builds them from a dict, so the scan below cannot
#: see them. `error` is that map's default. Listed so the test does not silently
#: under-report.
FROM_STATUS_MAPS = {"unauthorized", "forbidden", "upstream_unavailable", "error"}


def _codes_the_backend_raises() -> set[str]:
    """Every `ApiError(status, "code")` literal in `app/`.

    Read from the source rather than hardcoded, so adding a new error code fails
    these tests until both pages explain it. The pattern tolerates a call split
    across lines; it would miss a code passed as a variable, which is a limit
    worth knowing rather than a reason to hardcode the list.
    """
    codes: set[str] = set()
    for path in APP.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        codes.update(re.findall(r'ApiError\([^)]*?"([a-z_]+)"', source, re.S))
    return codes | FROM_STATUS_MAPS


def _explained_codes(page: pathlib.Path) -> set[str]:
    """The keys of the page's `FAILURES` table."""
    body = page.read_text(encoding="utf-8")
    start = body.index("FAILURES = {")
    end = body.index("};", start)
    return set(re.findall(r"^\s+([a-z_]+):", body[start:end], re.M))


def test_both_pages_explain_the_same_codes():
    """A code explained on one page and not the other is a bug users meet on
    whichever page they happened to open."""
    assert _explained_codes(PLAYGROUND) == _explained_codes(SPA_FALLBACK)


def test_every_generation_failure_has_an_explanation():
    """The gap this module exists for: a new backend code with no entry."""
    wanted = _codes_the_backend_raises() - NOT_REACHED_FROM_GENERATE

    for page in (PLAYGROUND, SPA_FALLBACK):
        missing = wanted - _explained_codes(page)
        assert not missing, f"{page.name} cannot explain {sorted(missing)}"


def test_the_allowlist_does_not_rot():
    """Every name in the exclusion list must still exist in the backend.

    Otherwise the list quietly grows into a place to hide codes from the test
    above -- which is the failure mode of every allowlist.
    """
    assert NOT_REACHED_FROM_GENERATE <= _codes_the_backend_raises()


def test_the_root_page_does_not_assume_a_failure_is_json():
    """A proxy's 502 page is not JSON, and `await res.json()` would throw on it.

    The catch block would then report a parse error -- `Unexpected token '<'` --
    instead of the actual failure. The body must be read as text first.

    Scoped to `fire()` on purpose: `loadPromptLimit` talks to `/v1/config`, which
    *is* JSON, and parsing it directly there is correct.
    """
    body = SPA_FALLBACK.read_text(encoding="utf-8")
    fire = body[body.index("async function fire()"):body.index("$('go').addEventListener")]

    assert "showFailure" in fire, "the failure path must exist"
    assert "await res.text()" in fire, "read the body before parsing it"
    assert "await res.json()" not in fire


def test_both_pages_report_a_success_that_carried_no_image():
    """A 200 with no usable image is still a failed generation to the person
    waiting, so it must not fall through to an empty stage."""
    for page in (PLAYGROUND, SPA_FALLBACK):
        body = page.read_text(encoding="utf-8")
        assert "no_image_url" in body, f"{page.name} has no empty-success guard"
        assert "image_unreachable" in body, f"{page.name} ignores img.onerror"
        assert "onerror" in body, f"{page.name} lets a broken image say nothing"
