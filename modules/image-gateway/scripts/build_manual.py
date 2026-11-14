#!/usr/bin/env python3
"""Render the H5 manual from the collected evidence.

Reads `docs/manual/manifest.json` (written by `collect_manual_assets.py`) and
writes a single self-contained `docs/manual/index.html`.

Self-contained on purpose: the data is embedded rather than fetched, because
`fetch()` against a `file://` page is blocked by CORS and the manual has to work
when someone just double-clicks it. No CDN, no build step, no network.
"""

from __future__ import annotations

import html
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANUAL = ROOT / "docs" / "manual"

# --- the schema findings ------------------------------------------------
# Authored, not derived: these are the conclusions from probing the real service.
# The image evidence lives in manifest.json; this is the prose and the tables.

TOKEN_ANSWER = {
    "ours": "IMAGE_GATEWAY_ACCESS_TOKEN",
    "ours_what": "客户端 → 网关的门禁口令，由网关自己签发和校验。",
    "upstream": "上游设备头（名称见 app/upstream.py）",
    "upstream_what": "网关 → 上游的凭据，由网关持有，客户端永远看不到。",
}

ENDPOINTS = [
    ("POST", "/v1/images", "生成一张图，返回转存后的短 URL", "需要 token"),
    ("GET", "/v1/images", "最近生成记录，倒序", "需要 token"),
    ("GET", "/v1/images/{id}", "单张图的元数据", "需要 token"),
    ("GET", "/files/{name}", "图片字节，内容寻址、可缓存、支持 Range", "默认公开"),
    ("GET", "/v1/config", "公开契约：限流、上限、是否需要 token", "免鉴权"),
    ("GET", "/__mock__/gateway", "控制面：是否 ready、是否处于「开放」状态", "免鉴权"),
]

#: name, type, verdict, evidence
PARAMS = [
    (
        "mode",
        "string",
        "bound",
        "最先校验，且只接受 <code>image</code>。其余值一律 <code>400 bad_mode</code>。"
        "传非字符串则连应用层都到不了，直接是绑定错误。",
    ),
    (
        "prompt",
        "string",
        "bound",
        "非空字符串。空串 / 纯空白 → <code>400 empty_prompt</code>；"
        "非字符串 → 绑定错误。",
    ),
    (
        "aspect",
        "string",
        "bound-unvalidated",
        "<b>会被绑定，但取值完全不校验。</b>"
        "五个比例实测出真实尺寸；<b>未知比例不报错</b>，回落到 4:3 的画幅。",
    ),
    (
        "image",
        "string",
        "bound",
        "<b>真实存在，用于图生图。</b>传 base64 data URL 成功返回 200；"
        "传 http URL 则 <code>502 upstream</code>——上游只认 data URL。",
    ),
    ("model", "—", "ignored", "传了不报错，也不改变结果：上游 DTO 未绑定该字段。"),
    ("seed", "—", "ignored", "同上。图不可复现，换 seed 也没用。"),
    ("style", "—", "ignored", "同上。风格只能靠 prompt 描述。"),
    ("negativePrompt", "—", "ignored", "同上。没有负向提示词通道。"),
    ("width", "—", "ignored", "同上。尺寸只能通过 <code>aspect</code> 控制。"),
]

VERDICT_LABEL = {
    "bound": ("支持", "ok"),
    "bound-unvalidated": ("支持·不校验取值", "warn"),
    "ignored": ("不支持（静默忽略）", "off"),
}

ERROR_FAMILIES = [
    {
        "title": "① 绑定错误 — JSON 类型不对",
        "media": "application/problem+json",
        "note": "ASP.NET 模型绑定先于应用逻辑，"
        "<b>只报告 DTO 顺序里第一个出错的字段</b>，顺序为 "
        "<code>mode</code> → <code>prompt</code> → <code>aspect</code>。",
        "example": '{"mode": {}, "prompt": 123}',
        "response": {
            "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
            "title": "One or more validation errors occurred.",
            "status": 400,
            "errors": {"$.mode": ["The JSON value could not be converted."]},
        },
    },
    {
        "title": "② 语义错误 — 类型对了，值不对",
        "media": "application/json",
        "note": "过了绑定之后才由应用判断，返回扁平信封。",
        "example": '{"mode": "video"}',
        "response": {"error": "bad_mode"},
    },
]

ERROR_CODES = [
    ("400", "bad_mode", "mode 不是 image，或缺失", "扁平"),
    ("400", "empty_prompt", "prompt 为空串或纯空白", "扁平"),
    ("400", "problem+json", "mode / prompt / aspect 的 JSON 类型不对", "绑定"),
    ("502", "upstream_error", "image 字段的内容上游用不了", "扁平"),
    ("502", "upstream", "上游图像服务自己失败了（如 aspect 值畸形）", "扁平"),
]

QUICKSTART = """curl -X POST http://127.0.0.1:4399/v1/images \\
  -H "Authorization: Bearer $IMAGE_GATEWAY_ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"mode":"image","prompt":"一只柯基犬","aspect":"16:9"}'"""

QUICKSTART_RESPONSE = """{
  "id": "49ee3bee349bd48ce927ef0e712908a4",
  "url": "http://127.0.0.1:4399/files/49ee3bee349bd48ce927ef0e712908a4.png",
  "mimeType": "image/png",
  "size": 1854595,
  "sha256": "49ee3bee...c29148",
  "cached": false,
  "aspect": "4:3",
  "width": 1184,
  "height": 864,
  "upstream": {"host": "upstream.example.com", "status": 200, "sourceField": "image"},
  "c2pa": true
}"""


def load_manifest() -> dict:
    path = MANUAL / "manifest.json"
    if not path.is_file():
        sys.exit(f"missing {path}; run scripts/collect_manual_assets.py first")
    return json.loads(path.read_text(encoding="utf-8"))


def by_id(manifest: dict) -> dict:
    return {case["id"]: case for case in manifest["cases"]}


def esc(value) -> str:
    return html.escape(str(value))


def body_json(case: dict) -> str:
    """The request body, with the prompt shortened so the card stays readable."""
    body = dict(case["body"])
    prompt = body.get("prompt", "")
    if len(prompt) > 26:
        body["prompt"] = prompt[:26] + "…"
    return json.dumps(body, ensure_ascii=False)


# --- galleries ----------------------------------------------------------
def image_card(case: dict, caption: str | None = None) -> str:
    measured = case.get("measured") or {}
    size = f"{measured.get('width')}×{measured.get('height')}"
    ratio = measured.get("ratio")
    envelope = case.get("envelope") or {}
    return f"""
      <figure class="card">
        <div class="shot"><img src="{esc(case['file'])}" alt="{esc(case['label'])}"></div>
        <figcaption>
          <div class="row"><span class="pill">{esc(size)}</span>
            <span class="muted">比例 {esc(ratio)}</span></div>
          <div class="label">{esc(caption or case['label'])}</div>
          <code class="req">{esc(body_json(case))}</code>
          <div class="muted tiny">{esc(envelope.get('size') or measured.get('bytes'))} bytes
            · sha {esc(str(envelope.get('sha256') or '')[:12])}…</div>
        </figcaption>
      </figure>"""


def group(anchor: str, title: str, held: str, blurb: str, cards: str, columns: int) -> str:
    # The `id` is not decoration: it makes each gallery deep-linkable, and it is
    # how the page is verified (navigate to #aspect rather than scrolling, which
    # a one-shot headless screenshot cannot do).
    return f"""
    <section class="group" id="{anchor}">
      <header>
        <h3>{title}</h3>
        <p class="hold"><b>控制变量：</b>{held}</p>
        <p class="muted">{blurb}</p>
      </header>
      <div class="gallery cols-{columns}">{cards}</div>
    </section>"""


def build_galleries(manifest: dict) -> str:
    case = by_id(manifest)

    aspect_ids = ["aspect-4x3", "aspect-1x1", "aspect-16x9", "aspect-3x4", "aspect-9x16"]
    aspect_cards = "".join(image_card(case[i], caption=i.replace("aspect-", "").replace("x", ":")) for i in aspect_ids)
    aspect = group(
        "aspect",
        "① aspect —— 唯一会改变画幅的参数",
        "提示词完全相同（快乐滑板的美式女孩），只改 aspect。",
        "五张图的画面内容一致，差别只在取景：宽画幅装下更多环境，竖画幅把人放大。"
        "注意 4:3 实际是 1184×864，比例 1.3704 而不是 1.3333——上游会为了凑整把边长对齐到 32 的倍数。",
        aspect_cards,
        5,
    )

    prompt_ids = ["aspect-4x3", "prompt-5", "prompt-6"]
    prompt_cards = "".join(
        image_card(case[i], caption=lbl)
        for i, lbl in zip(prompt_ids, ["滑板女孩（原提示词）", "柯基犬", "极简几何海报"])
    )
    prompt_group = group(
        "prompt",
        "② prompt —— 内容变量",
        "aspect 固定为 4:3，只改 prompt。",
        "三张图尺寸完全一致，画面内容完全不同。这就是提示词的唯一作用：决定画什么，不决定画多大。",
        prompt_cards,
        3,
    )

    ref_ids = ["prompt-5", "image-ref"]
    ref_cards = "".join(
        image_card(case[i], caption=lbl)
        for i, lbl in zip(ref_ids, ["不带参考图", "带参考图（image = base64 data URL）"])
    )
    ref = group(
        "image",
        "③ image —— 图生图（参考图）",
        "prompt 与 aspect 完全相同，只在第二次请求里多了 image 字段。",
        "这个字段在抓包里从来没出现过，是探测出来的：传 base64 data URL 会被接受并正常出图，"
        "传 http URL 则被上游拒绝（502）——也就是说 <b>参考图必须以 data URL 内联</b>，"
        "上游不会替你去下载一个链接。"
        "<br><b>但请注意这个结论的边界：</b>这里证明的是「字段被接受且不破坏出图」，"
        "<b>不等于</b>「参考图真的影响了成图」。本次用的参考图是一张 128×128 的程序生成占位图，"
        "两张结果的差异主要来自生成本身的随机性。要证明影响强度，得拿一张真实照片做 A/B——"
        "那是另一次付费实验，本文没有做。",
        ref_cards,
        2,
    )

    return aspect + prompt_group + ref


# --- page ---------------------------------------------------------------
def build(manifest: dict) -> str:
    fresh = [c for c in manifest["cases"] if not c.get("reusedFrom")]
    probe_cards = "".join(
        f"""
      <tr>
        <td><code>{esc(p[0])}</code></td>
        <td class="muted">{esc(p[1])}</td>
        <td><span class="badge {VERDICT_LABEL[p[2]][1]}">{VERDICT_LABEL[p[2]][0]}</span></td>
        <td>{p[3]}</td>
      </tr>"""
        for p in PARAMS
    )

    endpoints = "".join(
        f"""
      <tr>
        <td><span class="method {m.lower()}">{m}</span></td>
        <td><code>{esc(path)}</code></td>
        <td>{esc(desc)}</td>
        <td class="muted">{esc(auth)}</td>
      </tr>"""
        for m, path, desc, auth in ENDPOINTS
    )

    families = "".join(
        f"""
      <div class="family">
        <h4>{f['title']} <span class="media">{esc(f['media'])}</span></h4>
        <p>{f['note']}</p>
        <div class="req-res">
          <pre class="req">{esc(f['example'])}</pre>
          <pre class="res">{esc(json.dumps(f['response'], ensure_ascii=False, indent=2))}</pre>
        </div>
      </div>"""
        for f in ERROR_FAMILIES
    )

    codes = "".join(
        f"""
      <tr><td><code>{esc(code)}</code></td><td><code>{esc(err)}</code></td>
      <td>{esc(meaning)}</td><td class="muted">{esc(kind)}</td></tr>"""
        for code, err, meaning, kind in ERROR_CODES
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>生图 API 说明书 · image relay</title>
<style>
  :root {{
    --bg: #f4f6f8; --panel: #ffffff; --ink: #16202b; --muted: #64748b;
    --line: #e2e8f0; --accent: #2563eb; --ok: #0f766e; --warn: #b45309;
    --off: #64748b; --code-bg: #f1f5f9;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.7 -apple-system, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
  }}
  .wrap {{ max-width: 1120px; margin: 0 auto; padding: 40px 24px 96px; }}
  header.top {{ margin-bottom: 32px; }}
  h1 {{ font-size: 30px; margin: 0 0 8px; letter-spacing: -0.4px; }}
  h2 {{
    font-size: 21px; margin: 56px 0 16px; padding-bottom: 10px;
    border-bottom: 2px solid var(--line);
  }}
  h3 {{ font-size: 17px; margin: 0 0 6px; }}
  h4 {{ font-size: 15px; margin: 0 0 8px; }}
  p {{ margin: 8px 0; }}
  .muted {{ color: var(--muted); }}
  .tiny {{ font-size: 12.5px; }}
  .lede {{ font-size: 16px; color: #334155; max-width: 76ch; }}
  code {{
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px; background: var(--code-bg); padding: 1px 5px; border-radius: 4px;
  }}
  pre {{
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px; background: var(--code-bg); border: 1px solid var(--line);
    border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 8px 0;
    line-height: 1.55; white-space: pre-wrap; word-break: break-all;
  }}
  .panel {{
    background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
    padding: 20px 22px; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }}
  table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
  th, td {{ text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }}
  th {{ font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }}
  tr:last-child td {{ border-bottom: none; }}
  .badge {{
    display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 9px;
    border-radius: 999px; white-space: nowrap;
  }}
  .badge.ok {{ background: #ccfbf1; color: var(--ok); }}
  .badge.warn {{ background: #fef3c7; color: var(--warn); }}
  .badge.off {{ background: #e2e8f0; color: var(--off); }}
  .method {{
    display: inline-block; font-family: ui-monospace, monospace; font-size: 11.5px;
    font-weight: 700; padding: 2px 7px; border-radius: 5px;
  }}
  .method.post {{ background: #dbeafe; color: #1d4ed8; }}
  .method.get {{ background: #dcfce7; color: #15803d; }}
  .two-col {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }}
  @media (max-width: 760px) {{ .two-col {{ grid-template-columns: 1fr; }} }}
  .key {{ font-size: 12.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }}
  .group {{ margin: 28px 0 40px; }}
  .hold {{ font-size: 14px; color: #334155; }}
  .gallery {{ display: grid; gap: 16px; margin-top: 16px; }}
  .gallery.cols-5 {{ grid-template-columns: repeat(5, 1fr); }}
  .gallery.cols-3 {{ grid-template-columns: repeat(3, 1fr); }}
  .gallery.cols-2 {{ grid-template-columns: repeat(2, 1fr); }}
  @media (max-width: 980px) {{
    .gallery.cols-5 {{ grid-template-columns: repeat(2, 1fr); }}
  }}
  @media (max-width: 620px) {{
    .gallery.cols-5, .gallery.cols-3, .gallery.cols-2 {{ grid-template-columns: 1fr; }}
  }}
  .card {{
    margin: 0; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; overflow: hidden; display: flex; flex-direction: column;
  }}
  .shot {{
    background: repeating-conic-gradient(#eef2f6 0% 25%, #ffffff 0% 50%) 50% / 16px 16px;
    height: 210px; display: flex; align-items: center; justify-content: center;
    border-bottom: 1px solid var(--line);
  }}
  .shot img {{ max-width: 100%; max-height: 100%; display: block; }}
  .card figcaption {{ padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }}
  .row {{ display: flex; align-items: center; gap: 8px; }}
  .pill {{
    font-family: ui-monospace, monospace; font-size: 12px; background: #eef2ff;
    color: #3730a3; padding: 1px 8px; border-radius: 999px; font-weight: 600;
  }}
  .label {{ font-weight: 600; font-size: 14px; }}
  .req {{ font-size: 11.5px; display: block; }}
  .family {{ margin: 18px 0; }}
  .media {{
    font-family: ui-monospace, monospace; font-size: 11.5px; font-weight: 500;
    color: var(--muted); background: var(--code-bg); padding: 1px 7px; border-radius: 4px;
  }}
  .req-res {{ display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px; }}
  @media (max-width: 760px) {{ .req-res {{ grid-template-columns: 1fr; }} }}
  .req-res .req {{ background: #fff7ed; border-color: #fed7aa; }}
  .req-res .res {{ background: #f0fdfa; border-color: #99f6e4; }}
  .callout {{
    border-left: 4px solid var(--accent); background: #eff6ff; border-radius: 0 10px 10px 0;
    padding: 14px 18px; margin: 16px 0;
  }}
  .callout.warn {{ border-color: var(--warn); background: #fffbeb; }}
  footer {{ margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--line); }}
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    <h1>生图 API 说明书</h1>
    <p class="lede">
      这是 <code>image-gateway</code> 的 <b>中转站（gateway）</b>：客户端只拿一个网关口令，
      网关自己带上游凭据去调上游生图接口，把出图<b>转存</b>成内容寻址的短 URL 再返回。
      本文所有参数结论都来自对真实上游的实测（{esc(manifest['generatedAt'])}，共 {manifest['paidCalls']} 次真实生成）。
    </p>
  </header>

  <div class="callout">
    <p class="key">先回答你的问题</p>
    <p>
      <b><code>{TOKEN_ANSWER['ours']}</code> 不是上游的 token，是我们自己网关的门禁口令。</b>
      它跟上游没有任何关系，是我们签发给客户端用的。
    </p>
    <p>这个系统里有<b>两层凭据，方向相反</b>：</p>
    <table>
      <tr><th>层</th><th>头</th><th>谁校验</th></tr>
      <tr>
        <td>客户端 → 网关</td>
        <td><code>Authorization: Bearer &lt;{esc(TOKEN_ANSWER['ours'])}&gt;</code></td>
        <td>我们的网关。不设就是<b>开放代理</b>，谁都能花你的上游额度。</td>
      </tr>
      <tr>
        <td>网关 → 上游</td>
        <td><code>上游设备头: web-…</code></td>
        <td>上游。由网关持有，并且会<b>替换</b>客户端传来的同名字段，客户端永远看不到。</td>
      </tr>
    </table>
    <p class="muted tiny">
      所以网关存在的意义就是：把「上游凭据」这件事从客户端手里拿走。
      客户端的 token 泄了，你换一个就行，上游凭据不受影响。
    </p>
  </div>

  <h2>快速开始</h2>
  <div class="two-col">
    <div>
      <p class="key">请求</p>
      <pre>{esc(QUICKSTART)}</pre>
    </div>
    <div>
      <p class="key">响应（200）</p>
      <pre>{esc(QUICKSTART_RESPONSE)}</pre>
    </div>
  </div>
  <p class="muted tiny">
    响应里没有内联 base64——那张图有 1.8 MB，内联的话每次都要搬 1.8 MB。
    这里给的是 <code>/files/&lt;sha256 前 32 位&gt;.png</code>：内容寻址，所以 URL 不可变，
    可以放心挂一年 <code>Cache-Control: immutable</code>。
  </p>

  <h2>API 一览</h2>
  <div class="panel">
    <table>
      <tr><th>方法</th><th>路径</th><th>作用</th><th>鉴权</th></tr>
      {endpoints}
    </table>
  </div>

  <h2>生图参数</h2>
  <div class="panel">
    <table>
      <tr><th>参数</th><th>类型</th><th>结论</th><th>依据</th></tr>
      {probe_cards}
    </table>
  </div>

  <div class="callout warn">
    <p><b>只有四个参数是真的：<code>mode</code>、<code>prompt</code>、<code>aspect</code>、<code>image</code>。</b></p>
    <p>
      其余常见名字（<code>model</code>、<code>seed</code>、<code>style</code>、<code>negativePrompt</code>、<code>width</code>）
      都<b>被静默忽略</b>：不报错、也不起作用。这五个是各花了一次真实生成验证的——
      上游的 DTO 根本没绑定它们，所以传什么都不影响结果。
    </p>
    <p class="muted tiny">
      注意 <code>aspect</code> 的「不校验」是实测结论，不是偷懒：传 <code>"99:1"</code> 上游照样返回 200，
      画幅回落到 4:3。所以网关<b>刻意不校验 aspect</b>——本地校验一旦比上游严格，
      就会把本来能成功的请求判成失败。
    </p>
  </div>

  <h2>对照图：不同参数长什么样</h2>
  <p class="muted">每组只改一个变量，其余全部锁死。所有图片都是真实生成、原样转存，未经处理。</p>
  {build_galleries(manifest)}

  <h2>错误码</h2>
  <p class="muted">实测发现上游有<b>两套完全不同的错误格式</b>，客户端必须都能解析。</p>
  <div class="panel">{families}</div>

  <div class="panel" style="margin-top:18px">
    <table>
      <tr><th>HTTP</th><th>error / 形态</th><th>含义</th><th>格式</th></tr>
      {codes}
    </table>
  </div>

  <footer class="muted tiny">
    <p>
      证据文件：<code>docs/manual/manifest.json</code>（每次调用的请求、响应、实测尺寸与 sha256）。
      复现：<code>python scripts/collect_manual_assets.py</code>（会真实花钱，先加 <code>--dry-run</code> 看计划）。
      上游主机与设备头名称已脱敏，实际值见 <code>app/upstream.py</code> 与本机 <code>deploy/*.env</code>。生成时间 {esc(manifest['generatedAt'])}。
    </p>
  </footer>
</div>
</body>
</html>
"""


def main() -> int:
    manifest = load_manifest()
    MANUAL.mkdir(parents=True, exist_ok=True)
    out = MANUAL / "index.html"
    out.write_text(build(manifest), encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
