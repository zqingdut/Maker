#!/usr/bin/env python3
"""Generate the controlled-variable image set for the H5 manual.

Every case here is a **real, paid** generation against the configured upstream.
The point is controlled variables: one thing changes per group, so the picture
shows the effect of that thing and nothing else.

    group "aspect"  -- one prompt, five ratios
    group "prompt"  -- one ratio, three prompts
    group "probe"   -- does the origin bind a field we do not know about?

The probe group is the interesting one. Model binding reports only the FIRST bad
field in DTO order, so a field *after* `aspect` cannot be tested for free: if the
name is not bound, the request is simply valid and a generation happens. So each
probe is a real call whose outcome is either

    400 problem+json, errors {"$.<name>": [...]}   -> the origin binds this field
    200                                            -> it does not, and we paid

Either way the answer is recorded. Run with `--dry-run` to print the plan and the
exact call count without spending anything.

    GATEWAY=http://127.0.0.1:4400 RELAY_TOKEN=... python scripts/collect_manual_assets.py
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

import httpx

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "manual"

# --- the controlled variables -------------------------------------------
#: The subject the user asked for. Used for every ratio, so the only variable in
#: the aspect group is the frame.
P_SKATE = (
    "一位快乐的美式女孩踩着滑板，灿烂的笑容，金色长发随风飘动，"
    "加州海滨阳光下的街道，动感抓拍瞬间，鲜艳明快的色彩，电影感构图，高细节"
)
#: Deliberately unlike the skate prompt: a living subject, a still subject, and a
#: graphic one. Same ratio for all three, so the only variable is the prompt.
P_CORGI = "一只戴着红色围巾的柯基犬坐在雪地里，柔和的冬日光线，高细节"
P_POSTER = "现代极简几何海报，三个交叠的圆形，橙色与青色对比，纯色背景"

ASPECTS = ["4:3", "1:1", "16:9", "3:4", "9:16"]

#: Names a client might reasonably expect the origin to accept. Each one is a paid
#: call if it turns out not to be bound.
PROBE_FIELDS = ["model", "seed", "style", "negativePrompt", "image", "width"]

#: The 4:3 skate image was generated before this script existed. Reusing it keeps
#: the aspect group honest (same prompt throughout) and costs one less call. The
#: envelope is copied from its sidecar so the manifest is as complete as a fresh
#: call's would be.
REUSE = {
    "aspect-4x3": {
        "source": "data/files/49ee3bee349bd48ce927ef0e712908a4.png",
        "sidecar": "data/files/49ee3bee349bd48ce927ef0e712908a4.json",
    },
}

#: Cases already run by hand while characterising the `image` field, recorded here
#: rather than re-spent: re-running would cost two more generations to learn what
#: we already know. They are copied into the manifest verbatim and never called.
RECORDED = {
    "image-ref": {
        "group": "image",
        "label": "带参考图",
        "variable": "image",
        "body": {
            "mode": "image",
            "prompt": P_CORGI,
            "aspect": "4:3",
            "image": "data:image/png;base64,<128x128 参考图，见 manifest 说明>",
        },
        "note": "image 传 base64 data URL：被接受，正常出图",
        "status": 200,
        "file": "img/image-ref.png",
        "envelope": {
            "id": "55b01fb395841f2931073fbe453c34a9",
            "mimeType": "image/png",
            "size": 1466843,
            "sha256": "55b01fb395841f2931073fbe453c34a94949960c8bccf20deb3f81719d1cb946",
        },
        "measured": {"bytes": 1466843, "mime": "image/png", "width": 1184, "height": 864, "ratio": 1.3704},
        "observedByHand": True,
    },
    "image-url": {
        "group": "image",
        "label": "参考图给 http URL",
        "variable": "image",
        "body": {
            "mode": "image",
            "prompt": P_CORGI,
            "aspect": "4:3",
            "image": "https://example.com/nope.png",
        },
        "note": "上游不会替你下载链接：502",
        "status": 502,
        "response": {"error": "upstream"},
        "observedByHand": True,
    },
}


def build_cases() -> list[dict]:
    cases: list[dict] = []

    for aspect in ASPECTS:
        case = {
            "id": f"aspect-{aspect.replace(':', 'x')}",
            "group": "aspect",
            "label": aspect,
            "variable": "aspect",
            "body": {"mode": "image", "prompt": P_SKATE, "aspect": aspect},
            "note": "同一提示词，只改比例",
        }
        if case["id"] in REUSE:
            case["reuse"] = REUSE[case["id"]]
        cases.append(case)

    for label, prompt in (("柯基犬", P_CORGI), ("几何海报", P_POSTER)):
        cases.append(
            {
                "id": f"prompt-{len(cases)}",
                "group": "prompt",
                "label": label,
                "variable": "prompt",
                "body": {"mode": "image", "prompt": prompt, "aspect": "4:3"},
                "note": "同一比例 4:3，只改提示词",
            }
        )

    for name in PROBE_FIELDS:
        cases.append(
            {
                "id": f"probe-{name}",
                "group": "probe",
                "label": name,
                "variable": name,
                "body": {"mode": "image", "prompt": P_CORGI, "aspect": "4:3", name: {}},
                "note": "类型故意给错；若被绑定应回 problem+json",
            }
        )

    for case_id, record in RECORDED.items():
        cases.append({"id": case_id, **record})

    return cases


def run(base: str, token: str, cases: list[dict], delay: float) -> list[dict]:
    (OUT / "img").mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    with httpx.Client(timeout=180, trust_env=False) as client:
        for case in cases:
            record = {k: case[k] for k in ("id", "group", "label", "variable", "body", "note")}

            if case.get("observedByHand"):
                # Already paid for once; copying beats re-spending.
                for key in ("status", "file", "envelope", "measured", "response", "observedByHand"):
                    if key in case:
                        record[key] = case[key]
                results.append(record)
                print(f"  keep   {case['id']:<22} <- recorded earlier this session")
                continue

            if case.get("reuse"):
                info = case["reuse"]
                src = ROOT / info["source"]
                data = src.read_bytes()
                dest = OUT / "img" / f"{case['id']}.png"
                dest.write_bytes(data)
                meta = json.loads((ROOT / info["sidecar"]).read_text(encoding="utf-8"))
                record.update(
                    {
                        "status": 200,
                        "reusedFrom": info["source"],
                        "file": f"img/{case['id']}.png",
                        "envelope": {
                            k: meta.get(k)
                            for k in ("id", "mimeType", "size", "sha256", "storedAt",
                                      "width", "height", "c2pa")
                        },
                        "upstream": {
                            "host": meta.get("upstreamHost"),
                            "path": meta.get("upstreamPath"),
                            "status": meta.get("upstreamStatus"),
                            "sourceField": meta.get("sourceField"),
                        },
                        "measured": measure(data),
                    }
                )
                results.append(record)
                print(
                    f"  reuse  {case['id']:<22} <- {info['source']} "
                    f"({record['measured']['width']}x{record['measured']['height']})"
                )
                continue

            started = time.time()
            response = client.post(f"{base}/v1/images", headers=headers, json=case["body"])
            elapsed = round(time.time() - started, 2)
            record["status"] = response.status_code
            record["elapsedSeconds"] = elapsed
            record["contentType"] = response.headers.get("content-type", "").split(";")[0]

            try:
                payload = response.json()
            except ValueError:
                payload = None

            if response.status_code == 200 and isinstance(payload, dict) and payload.get("url"):
                record["envelope"] = {
                    k: payload.get(k)
                    for k in ("id", "url", "path", "mimeType", "size", "sha256",
                              "cached", "createdAt", "width", "height", "c2pa")
                }
                record["upstream"] = payload.get("upstream")
                # The envelope's width/height are what the gateway *reports*; the
                # bytes are the truth. Measure them independently.
                image = client.get(payload["url"])
                dest = OUT / "img" / f"{case['id']}.png"
                dest.write_bytes(image.content)
                record["file"] = f"img/{case['id']}.png"
                record["measured"] = measure(image.content)
                print(
                    f"  200    {case['id']:<22} {record['measured']['width']}x"
                    f"{record['measured']['height']}  {elapsed}s"
                )
            elif response.status_code == 400 and isinstance(payload, dict) and payload.get("errors"):
                record["problemJson"] = payload
                record["bound"] = True
                print(f"  400    {case['id']:<22} BOUND -> {list(payload['errors'])}")
            else:
                record["response"] = payload if payload is not None else response.text[:400]
                record["bound"] = False
                print(f"  {response.status_code}    {case['id']:<22} {str(payload)[:70]}")

            results.append(record)
            time.sleep(delay)

    return results


def measure(data: bytes) -> dict:
    """Real pixel dimensions, read from the bytes rather than trusted."""
    sys.path.insert(0, str(ROOT))
    from app.filestore import image_dimensions, sniff_mime

    try:
        mime = sniff_mime(data, None)
    except Exception:
        mime = None
    size = image_dimensions(data)
    out = {"bytes": len(data), "mime": mime}
    if size:
        out["width"], out["height"] = size
        out["ratio"] = round(size[0] / size[1], 4)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("GATEWAY", "http://127.0.0.1:4400"))
    parser.add_argument("--token", default=os.environ.get("RELAY_TOKEN", "relay-demo-token"))
    parser.add_argument("--delay", type=float, default=1.5, help="pause between calls")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--only",
        help="run one group only (aspect|prompt|probe|image) and merge into the "
        "existing manifest, so re-running one group does not re-spend on the rest",
    )
    args = parser.parse_args()

    cases = build_cases()
    if args.only:
        cases = [c for c in cases if c["group"] == args.only]
        if not cases:
            return f"no cases in group {args.only!r}"

    calls = [c for c in cases if not c.get("reuse") and not c.get("observedByHand")]
    probes = [c for c in calls if c["group"] == "probe"]

    print(f"{len(cases)} cases: {len(calls)} paid calls, {len(cases) - len(calls)} free")
    print(f"  probe group: {len(probes)} of them may each cost a generation\n")

    if args.dry_run:
        for case in cases:
            tag = "PAID " if case in calls else "free "
            print(f"  {tag} {case['id']:<22} {json.dumps(case['body'], ensure_ascii=False)[:96]}")
        return 0

    results = run(args.base, args.token, cases, args.delay)

    manifest_path = OUT / "manifest.json"
    previous: dict = {}
    if args.only and manifest_path.is_file():
        # A partial run must not erase the groups it did not touch.
        previous = {
            c["id"]: c for c in json.loads(manifest_path.read_text(encoding="utf-8"))["cases"]
        }

    merged = {**previous, **{c["id"]: c for c in results}}
    ordered = [merged[c["id"]] for c in build_cases() if c["id"] in merged]

    manifest = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "gateway": args.base,
        "paidCalls": sum(1 for c in ordered if not c.get("reusedFrom") and not c.get("observedByHand")),
        "cases": ordered,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nwrote {manifest_path} ({len(ordered)} cases)")

    bound = [r["label"] for r in results if r.get("bound")]
    print(f"probe fields the origin binds: {bound or 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
