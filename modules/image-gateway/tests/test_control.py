"""Mock control plane (/__mock__/*). None of this exists in the real service."""

from __future__ import annotations

from app.upstream import DEVICE_HEADER, GENERATE_PATH

ENDPOINT = GENERATE_PATH


def test_healthz(client):
    response = client.get("/__mock__/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["capturedImagePresent"] is True


def test_state_exposes_settings_counters_and_the_capture(client):
    client.post(ENDPOINT, json={"mode": "image", "prompt": "p", "aspect": "4:3"})
    state = client.get("/__mock__/state").json()

    assert state["counters"]["generated"] == 1
    assert state["settings"]["response_style"] == "inline"
    assert state["capturedImage"]["width"] == 1184
    assert state["capturedImage"]["c2pa"] is True
    assert any(a["aspect"] == "4:3" and a["verified"] for a in state["supportedAspects"])
    assert "reconstructed" in state["responseEnvelope"]


def test_config_can_be_patched_at_runtime(client):
    patched = client.post("/__mock__/config", json={"fail_rate": 1.0, "fail_status": 503}).json()

    assert patched["applied"] == {"fail_rate": 1.0, "fail_status": 503}

    response = client.post(ENDPOINT, json={"mode": "image", "prompt": "p", "aspect": "4:3"})

    assert response.status_code == 503
    assert response.json()["error"] == "upstream_unavailable"


def test_config_rejects_unknown_fields(client):
    response = client.post("/__mock__/config", json={"nonsense": True})

    assert response.status_code == 400


def test_config_validation_is_enforced(client):
    response = client.post("/__mock__/config", json={"fail_rate": 5})

    assert response.status_code == 400


def test_reset_clears_counters(client):
    client.post(ENDPOINT, json={"mode": "image", "prompt": "p", "aspect": "4:3"})
    assert client.get("/__mock__/state").json()["counters"]

    assert client.post("/__mock__/reset").json() == {"reset": True}
    assert client.get("/__mock__/state").json()["counters"] == {}


def test_capture_endpoint_returns_the_parsed_dump(client):
    capture = client.get("/__mock__/capture").json()

    assert len(capture["captures"]) == 3
    assert capture["captures"][0]["url"] == "https://upstream.example.com/api/v1/media/ai/image"
    assert capture["probe"]["server"] == "Kestrel"
    observed = {o["request"]: o["status"] for o in capture["probe"]["observations"]}
    assert observed["POST /api/v1/media/ai/image  body={}"] == 400


def test_request_log_records_what_the_client_sent(client, captured_body, device_headers):
    client.post(ENDPOINT, json=captured_body, headers=device_headers)

    body = client.get("/__mock__/requests").json()

    assert body["source"] == "memory"
    assert body["fileLoggingEnabled"] is False
    assert len(body["records"]) == 1

    record = body["records"][0]
    assert record["kind"] == "ai-image"
    assert record["method"] == "POST"
    assert record["status"] == 200
    assert record["device"] == device_headers[DEVICE_HEADER]
    assert record["prompt"] == captured_body["prompt"]
    assert record["promptChars"] == len(captured_body["prompt"])
    assert record["durationMs"] >= 0


def test_request_log_works_with_file_logging_off(client):
    """The control plane must not depend on a writable log file."""
    client.get("/__mock__/healthz")

    assert len(client.get("/__mock__/requests").json()["records"]) == 1


def test_file_source_reports_an_empty_log_when_the_file_is_missing(make_settings):
    """source=file tails the JSONL; a missing file is empty, not an error."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    settings = make_settings(log_path="/nonexistent/image-gateway/requests.jsonl")
    with TestClient(create_app(settings)) as client:
        body = client.get("/__mock__/requests", params={"source": "file"}).json()

    assert body["source"] == "file"
    assert body["records"] == []
    assert body["path"].endswith("requests.jsonl")


def test_unknown_log_source_is_rejected(client):
    response = client.get("/__mock__/requests", params={"source": "sqlite"})

    assert response.status_code == 400
    assert response.json()["error"] == "bad_source"


def test_request_log_captures_the_spa_fallback(client):
    client.get("/some/deep/link")

    record = client.get("/__mock__/requests").json()["records"][0]

    assert record["spaFallback"] is True
    assert record["status"] == 200


def test_rejected_calls_are_still_logged_with_the_kind(client):
    """A bad_mode rejection must be greppable in the log, not just an anonymous 400."""
    client.post(ENDPOINT, json={}, headers={"Content-Type": "application/json"})

    record = client.get("/__mock__/requests").json()["records"][0]

    assert record["kind"] == "ai-image"
    assert record["status"] == 400
    assert "mode" not in record  # never got far enough to know one


def test_openapi_is_namespaced_under_mock(client):
    assert client.get("/__mock__/openapi.json").status_code == 200
