# image-gateway

A local stand-in for a third-party media API, rebuilt from a captured browser
session (`re.txt`). It runs in three modes, in increasing order of realism:

- **`mock`** (default) — answers locally. No upstream calls, no API spend, no rate
  limits. This is what you want for frontend development and tests.
- **`relay`** (中转) — forwards matching requests to the real origin and returns its
  response verbatim. This is what you want when you need the real thing through a
  stable local address.
- **gateway** (中转站) — the wrapped, client-facing flow at `POST /v1/images`: holds
  the credentials, meters the spend, and re-hosts the result so callers get a short
  URL instead of a 2.9 MB base64 blob.

FastAPI + uvicorn. Three runtime dependencies.

---

## Quick start

```bash
cd outputs/image-gateway

# packages live in an isolated venv, never in the system interpreter
PY=/Users/niko/.workbuddy-ai/binaries/python/versions/3.13.12/bin/python3
$PY -m venv .venv && ./.venv/bin/pip install -r requirements.txt

./run.sh                        # mock mode, http://127.0.0.1:4399
```

Then prove it works end to end — this replays the *actual* captured requests,
with only the host swapped:

```bash
python scripts/replay_capture.py
```

```
[1] POST /api/v1/media/ai/image  (replayed from re.txt)
  PASS  200 OK
  PASS  dimensions 1184x864 (real service: 1184x864)
  PASS  C2PA content credentials present
  PASS  POST {} -> 400 {"error":"bad_mode"}  (got 400 {"error":"bad_mode"})
...
all checks passed
```

Open <http://127.0.0.1:4399/> for a self-demoing page: it loads the captured prompt
verbatim from `/__mock__/capture` and fires it at the API. `docs/demo.png` is a
screenshot of that flow working.

To run as a relay instead:

```bash
IMAGE_GATEWAY_MODE=relay IMAGE_GATEWAY_UPSTREAM=https://upstream.example.com ./run.sh
```

---

## Relay mode (中转)

Relay is **off unless you ask for it**, because every relayed generation costs real
money. There are two independent switches:

| Knob | Effect |
|---|---|
| `IMAGE_GATEWAY_MODE=relay` | arm it globally for the paths in `IMAGE_GATEWAY_RELAY_PATHS` |
| `X-Mock-Mode: relay` | arm it for **one request**, even in mock mode |
| `X-Mock-Mode: mock` | force one request to stay local, even in relay mode |

So a mock-mode instance can relay a single call without a restart, and a
relay-mode instance can still be used offline for everything else.

```bash
# is this instance going to spend my money? ask it directly
curl -s localhost:4399/__mock__/relay
```

```json
{"enabled":true,"mode":"relay","upstream":"https://upstream.example.com",
 "relayPaths":["/api/","/assets/"],"injectedHeaders":[],
 "warning":"relay mode is ON -- matching requests are forwarded to the real origin"}
```

### What it forwards, and what it will not

- **Origin comes from config only.** The upstream host is never derived from the
  request, so this cannot be turned into an open proxy.
- **Only `relay_paths` prefixes**, default `/api/` and `/assets/`. Asking
  explicitly (`X-Mock-Mode: relay`) for a path outside the allowlist is a
  `400 path_not_relayable`, not a silent fallback to the mock.
- **`/__mock__/*` never leaves the process.**
- The request method, path, query string and body go through unchanged. Hop-by-hop
  headers and every `X-Mock-*` header are stripped; `Content-Length` is recomputed.
- The response status, body and headers come back verbatim. Only hop-by-hop headers,
  `Content-Length`, `Content-Encoding` (httpx already decoded the body), and
  `Date`/`Server` (the server emits its own) are dropped.
- Every relayed response carries `X-Mock-Relay: <host>` and
  `X-Mock-Upstream-Status: <code>`, so you can always tell real bytes from
  reconstructed ones.
- Upstream failures map to the flat envelope and never leak detail:
  timeout → `504 upstream_timeout`, connection error → `502 upstream_error`.

### Auth

If the real origin needs a token, inject it from the environment — never through
the config API:

```bash
IMAGE_GATEWAY_RELAY_HEADERS='{"Authorization":"Bearer <token>"}' \
IMAGE_GATEWAY_MODE=relay IMAGE_GATEWAY_UPSTREAM=https://upstream.example.com ./run.sh
```

Injected headers override whatever the client sent, so a client cannot spoof them.
`GET /__mock__/state` reports them **redacted** (`{"Authorization":"***"}`), and
`POST /__mock__/config` rejects the field outright. Client `Authorization`/`Cookie`
headers are forwarded by default (that is what a relay is for) — set
`IMAGE_GATEWAY_RELAY_FORWARD_CLIENT_HEADERS=false` to stop that.

### Verified against the real origin

Two zero-cost calls through the relay, on a `relay`-mode instance:

```bash
# the font whose body was never captured: the mock alone can only 404 this
$ curl -s -o /tmp/f.woff2 -w "%{http_code} %{size_download} %{content_type}\n" \
    localhost:4399/assets/Assistant-Regular-00000000.woff2
200 20232 font/woff2          # magic bytes: 774f4632 = wOF2

# a real error envelope, relayed verbatim
$ curl -s -i -X POST localhost:4399/api/v1/media/ai/image -d '{}' | head
HTTP/1.1 400 Bad Request
x-mock-relay: upstream.example.com
x-mock-upstream-status: 400
{"error":"bad_mode"}
```

Neither call can trigger a generation: the first is a static asset, the second is
rejected by the real service before the prompt is ever read.

---

## Gateway mode (中转站)

Relay mode forwards bytes. Gateway mode is the layer above it: a client-facing API
that holds the credentials, meters the spend, and hands back a short URL.

```bash
IMAGE_GATEWAY_UPSTREAM=https://upstream.example.com \
IMAGE_GATEWAY_ACCESS_TOKEN=$(openssl rand -hex 24) \
IMAGE_GATEWAY_RATE_LIMIT_PER_MINUTE=30 \
./run.sh
```

```bash
curl -s -X POST localhost:4399/v1/images \
  -H "X-Relay-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"mode":"image","prompt":"a lighthouse at dusk","aspect":"4:3"}'
```

```json
{
  "id": "7e94f0c1a2b3c4d5e6f708192a3b4c5d",
  "url": "http://127.0.0.1:4399/files/7e94f0c1a2b3c4d5e6f708192a3b4c5d.png",
  "path": "/files/7e94f0c1a2b3c4d5e6f708192a3b4c5d.png",
  "mimeType": "image/png",
  "size": 2938475,
  "sha256": "…",
  "cached": false,
  "createdAt": "2026-09-23T09:51:14.412Z",
  "prompt": "a lighthouse at dusk",
  "aspect": "4:3",
  "width": 1184,
  "height": 864,
  "c2pa": true,
  "upstream": {
    "host": "upstream.example.com",
    "path": "/api/v1/media/ai/image",
    "status": 200,
    "id": "img_5f3a1c",
    "sourceField": "image"
  }
}
```

### What it adds over relay mode

| | `relay` | gateway |
|---|---|---|
| path | the origin's own (`/api/v1/…`) | its own (`/v1/images`) |
| credentials | the client sends them, or they are injected | the gateway holds them; clients never see them |
| device header | passed through | **replaced** with the gateway's |
| result | 2.9 MB inline base64 | re-hosted — you get a short immutable URL |
| caller auth | none | shared token, compared in constant time |
| spend control | none | per-credential rate limit + concurrency cap |
| caching | none | content-addressed; immutable URLs, `ETag`/`304`/`Range` |

### Two credentials, pointing in opposite directions

This is the thing people get wrong first, so it is worth stating plainly:

| Direction | Header | Who checks it | What it is |
|---|---|---|---|
| client → gateway | `Authorization: Bearer <IMAGE_GATEWAY_ACCESS_TOKEN>` | **us** | the gateway's own shared secret |
| gateway → origin | `X-Device-Id: web-…` (stand-in name) | **the origin** | the upstream credential, held by the gateway |

`X-Device-Id` is a **stand-in**. The origin's own header name is a wire constant and
lives in exactly one place, `app/upstream.py` — it is not repeated in this document
so that reading the docs does not describe the upstream service. Code that sends the
header imports it; nothing else needs the literal.

**`IMAGE_GATEWAY_ACCESS_TOKEN` has nothing to do with the origin.** It is a token
*we* mint for *our* clients; the origin has never heard of it. The upstream
credential is the device header, and the gateway replaces whatever the client sent
with its own value — that substitution is the entire reason to run a gateway. A
leaked client token costs you a rotation; the upstream credential is never exposed
to begin with.

### What it refuses to leak

- **The gateway's token never goes upstream.** `X-Relay-Token` is dropped outright;
  `Authorization` is dropped only when it is the credential that authenticated *this*
  request — otherwise it is the client's own key for the origin, and forwarding it is
  the point.
- **The device header is replaced, not merged.** Holding that value is the entire
  reason to put a gateway in front of this origin.
- **Images are fetched back only from the configured origin.** An upstream that
  answers with `{"url": "https://evil.example.com/…"}` gets `502
  upstream_bad_image_url`, and the foreign URL is never contacted.
- **Stored bytes must really be an image.** Every format the store supports is
  detectable, so a declared `image/png` whose magic bytes say otherwise is refused
  rather than stored — and `/files/*` is served with `X-Content-Type-Options: nosniff`.
- **Upstream detail never becomes our detail.** Failures surface as the flat
  envelope (`upstream_error`, `upstream_timeout`, `upstream_busy`); the origin's own
  4xx/5xx status *and* its own `error` code pass through untouched, because it is the
  authority on why its call failed.
- **A bare `502 upstream_error` is not an answer.** The body stays flat — that shape
  is the contract — so the *reason* travels in `X-Mock-Error-Note`: `cannot resolve
  the upstream host (DNS)`, `the upstream refused the connection`, `a proxy failed the
  upstream connection (check HTTP_PROXY / RELAY_TRUST_ENV)`, `TLS handshake with the
  upstream failed`. Both pages render it. The note never contains the upstream host:
  the full detail (including the URL) stays in the gateway log.

### Retries: only where retrying is free

A generation is **paid work**. A `ReadTimeout` means the origin may already have
produced and billed for an image we never saw, so retrying it would bill twice. Only
connect-stage failures — where the request provably never left — are ever retried,
and `IMAGE_GATEWAY_RELAY_RETRIES` defaults to `0`. Raise it and a `ConnectError` gets
`1 + N` attempts with exponential backoff; a `ReadTimeout` still gets exactly one.

### `cached` is about storage, not about skipping the call

Every call goes upstream — we cannot know the image before generating it, and the
origin is not deterministic. What is deduplicated is *storage*: the file id is the
sha256 of the bytes, so identical images collapse to one file and the second caller
sees `cached: true`. That is also why a `/files/<id>` URL is immutable and can carry
a one-year `Cache-Control`.

### Is it going to spend my money?

```bash
curl -s localhost:4399/__mock__/gateway
```

```json
{"enabled":true,"ready":true,"upstream":"https://upstream.example.com","authRequired":true,
 "deviceIdHint":"web-…4394","files":{"files":0,"bytes":0,"requireToken":false},
 "rateLimit":{"perMinute":30,"trackedCallers":0},
 "concurrency":{"maxConcurrentUpstream":8,"queueTimeoutSeconds":10.0},
 "warning":null}
```

With no `IMAGE_GATEWAY_ACCESS_TOKEN` set, `warning` says the gateway is **open** and
anyone who can reach the port can spend your quota. That is the default, because a
token you have to invent before the first request is friction — but it is never
silent about it.

### Wiring it to the real API

The minimum that actually reaches the origin:

```bash
IMAGE_GATEWAY_UPSTREAM=https://upstream.example.com \
IMAGE_GATEWAY_ACCESS_TOKEN=$(openssl rand -hex 24) \
IMAGE_GATEWAY_DEVICE_ID=web-<your-own-uuid> \
IMAGE_GATEWAY_GATEWAY_ENABLED=true \
IMAGE_GATEWAY_MODE=mock \
IMAGE_GATEWAY_PYTHON=/path/to/python-with-fastapi \
./run.sh
```

Five things about that block are counter-intuitive enough to be worth spelling out.

**`.env` is not read.** There is no `dotenv` call anywhere in `app/` or `run.sh` — the
file `.env.example` is a *reference*, not a loaded config. Export the variables, or
put them inline on the command line as above. Writing a `.env` and expecting it to
take effect is the single most common reason a configured-looking instance behaves
like a default one.

**`IMAGE_GATEWAY_MODE=mock` is correct here.** `MODE` governs *relay* path forwarding and
nothing else — `app/gateway.py` never reads it. The gateway's readiness test is
`gateway_enabled and upstream`, so a gateway on a `mode=mock` instance reaches the
real origin happily. Setting `MODE=relay` does not enable the gateway and is not
required by it; it additionally opens `/api/` and `/assets/` passthrough, which is a
wider door than you may want.

**`IMAGE_GATEWAY_PYTHON` must point at an interpreter that has FastAPI.** `run.sh` checks
this before exec'ing and prints an actionable message rather than a
`ModuleNotFoundError` traceback, but the default `python3` on a machine with no
project venv will not have it.

**The device id is the upstream credential, and it ships blank.** The device header is
what the gateway presents to the origin *instead of* the client's, which is the whole
point of standing in front of it. The value in the original capture is a real
credential belonging to whoever took that capture, so it is deliberately not
committed — `app/config.py` defaults it to empty and `Settings.as_dict()` redacts it.
Supply your own: open the origin in a browser, copy its device header (name in
`app/upstream.py`, shape `web-<uuid>`), and export it. You never pass it per request.

If you leave it blank the gateway does **not** override the header — the client's own
travels through. That is the honest reading of "override" with nothing to override
with; the alternative, dropping the header and injecting nothing, would send the
origin a request with no device and fail in a much more confusing way.

#### Four reasons a call never leaves the box

| Symptom | Cause | Fix |
|---|---|---|
| `503 {"error":"no_upstream"}` | `IMAGE_GATEWAY_UPSTREAM` empty | set it to `https://upstream.example.com` |
| `404 {"error":"gateway_disabled"}` | `IMAGE_GATEWAY_GATEWAY_ENABLED=false` | set it to `true`, or drop the variable |
| answers in ~1 ms, with a plausible-looking image | you called the origin's own path (`/api/…`) while `IMAGE_GATEWAY_MODE=mock` (the default), so the relay declined to forward and the mock answered | call the gateway's own surface, `POST /v1/images`; or set `IMAGE_GATEWAY_MODE=relay`; or override for one call with `X-Mock-Mode: relay` |
| `502 upstream_error`, and the box has an egress proxy | `IMAGE_GATEWAY_RELAY_TRUST_ENV=true` (default) routes the outbound leg through `HTTP_PROXY`/`HTTPS_PROXY` | set `IMAGE_GATEWAY_RELAY_TRUST_ENV=false` to bypass it |
| `502 upstream_error` with note `cannot resolve the upstream host (DNS)` | `IMAGE_GATEWAY_UPSTREAM` is still the installer's placeholder — `https://upstream.example.com` does not resolve | put the real origin in `deploy/image-gateway.env`, then restart |

Every 502 carries its reason in `X-Mock-Error-Note`; read that before guessing. The
gateway also logs a warning at boot when a proxy variable is in its environment, so
the fourth row shows up in `journalctl` before it ever shows up as a failed call.

The third row is the quiet one. Mock and relay both answer locally with a
well-formed 200, so a misrouted call *looks* like success — it just never cost
anything, which you will only notice when the image does not change. The `relayed`
and `upstreamHost` fields in `GET /__mock__/requests` are the discriminator: a
genuine round trip carries a host, a local answer does not.

One more, which is neither of the above because the request *does* leave the box:
**an unset `IMAGE_GATEWAY_DEVICE_ID`.** The call goes out, the origin answers with an
auth-shaped failure, and the gateway relays it verbatim — so you see the origin's
error rather than a local one. A fresh clone hits this, because the credential is
deliberately not committed. The `deviceIdHint` field in `GET /__mock__/gateway` tells
you whether one is configured at all.

#### Proving the outbound leg for free

`POST {}` is rejected by the real service before it reads a prompt, so it exercises
DNS, TLS, proxy, headers, device injection and error passthrough at no cost — **but
only once local validation is out of the way.** With the default
`IMAGE_GATEWAY_GATEWAY_VALIDATE=true`, `POST {}` is refused by `_validate` in about a
millisecond and never leaves the process:

```bash
$ curl -s -i -X POST localhost:4399/v1/images -H "X-Relay-Token: $T" \
    -H 'content-type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
x-mock-error-note: supported modes: image     # <- ours, nothing was called
```

That is a useful result, but it is *not* evidence of connectivity, and treating it as
such is how you end up convinced the wiring is fine when it is not. Turn the local
check off first, then repeat:

```bash
$ curl -s -X POST localhost:4399/__mock__/config -d '{"gateway_validate": false}'
applied: {'gateway_validate': False}

$ curl -s -i -X POST localhost:4399/v1/images -H "X-Relay-Token: $T" \
    -H 'content-type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
x-mock-error-note: relayed from upstream       # <- real round trip
{"error":"bad_mode"}                           #    the origin's own envelope
```

Only the second call proves anything, and the `x-mock-error-note` header plus the
`upstreamHost` in the request log are how you tell them apart.

### Verified against the real origin

Free calls only. A `POST {}` is rejected by the real service before it ever reads a
prompt, so it exercises the entire outbound leg — DNS, TLS, proxy, headers, device
injection, error passthrough — without spending anything. Note the
`gateway_validate` flip in the transcript below: it is load-bearing, not decorative.

```bash
$ curl -s localhost:4399/v1/config            # unauthenticated
{"ready": true, "upstream": null, "authRequired": true, "rateLimitPerMinute": 3}
$ curl -s -H "X-Relay-Token: $T" localhost:4399/v1/config
upstream = https://upstream.example.com              # revealed only to a caller with a token

$ curl -s -i -X POST localhost:4399/v1/images -H "X-Relay-Token: $T" \
    -H 'content-type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
x-mock-error-note: supported modes: image     # <- *our* rejection, no call made
{"error":"bad_mode"}

$ curl -s -X POST localhost:4399/__mock__/config -d '{"gateway_validate": false}'
applied: {'gateway_validate': False}          # now let the origin judge

$ curl -s -i -X POST localhost:4399/v1/images -H "X-Relay-Token: $T" \
    -H 'content-type: application/json' -d '{}'
HTTP/1.1 400 Bad Request
x-mock-error-note: relayed from upstream       # <- real round trip to upstream.example.com
{"error":"bad_mode"}                           #    the origin's own envelope

$ curl -s -i -X POST localhost:4399/v1/images ...   # fourth call, budget is 3/min
HTTP/1.1 429 Too Many Requests
retry-after: 54
{"error":"rate_limited"}
```

And the request log is what makes it verifiable rather than merely plausible — the
three real calls are marked, the two local rejections are not:

```
status=401 relayed=None upstreamStatus=None host=None
status=400 relayed=None upstreamStatus=None host=None     # rejected locally
status=400 relayed=True upstreamStatus=400 host=upstream.example.com
status=400 relayed=True upstreamStatus=400 host=upstream.example.com
status=400 relayed=True upstreamStatus=400 host=upstream.example.com
status=429 relayed=None upstreamStatus=None host=None
```

### A real generation, start to finish

Everything above is free. This is the one call that is not — the first paid call this
project has ever made, and the only way to learn what a successful response actually
looks like. Prompt: *一位快乐的美式女孩踩着滑板* ("a cheerful American girl on a
skateboard").

```bash
$ IMAGE_GATEWAY_PORT=4400 IMAGE_GATEWAY_UPSTREAM=https://upstream.example.com \
  IMAGE_GATEWAY_ACCESS_TOKEN=$T IMAGE_GATEWAY_RATE_LIMIT_PER_MINUTE=6 ./run.sh

$ curl -s -i -X POST localhost:4400/v1/images -H "Authorization: Bearer $T" \
    -H 'content-type: application/json' \
    -d '{"mode":"image","prompt":"一位快乐的美式女孩踩着滑板，…","aspect":"4:3"}'

HTTP/1.1 200 OK
location: http://127.0.0.1:4400/files/49ee3bee349bd48ce927ef0e712908a4.png
x-relay-id: 49ee3bee349bd48ce927ef0e712908a4
x-relay-cache: miss
x-relay-upstream: upstream.example.com
x-relay-upstream-status: 200
```
```json
{"id":"49ee3bee349bd48ce927ef0e712908a4",
 "url":"http://127.0.0.1:4400/files/49ee3bee349bd48ce927ef0e712908a4.png",
 "mimeType":"image/png","size":1854595,
 "sha256":"49ee3bee349bd48ce927ef0e712908a43fdc60fa003f98f128d4c342acc29148",
 "cached":false,"createdAt":"2026-09-24T03:48:02.083Z",
 "prompt":"一位快乐的美式女孩踩着滑板，…","aspect":"4:3",
 "upstream":{"host":"upstream.example.com","path":"/api/v1/media/ai/image",
             "status":200,"id":null,"sourceField":"image"},
 "c2pa":true}
```

9.8 s wall clock. The re-hosted bytes are the origin's, unmodified:

```
$ curl -s -o girl.png localhost:4400/files/49ee3bee…png
$ shasum -a 256 girl.png
49ee3bee349bd48ce927ef0e712908a43fdc60fa003f98f128d4c342acc29148   # == the envelope's sha256
$ file girl.png
PNG image data, 1184 x 864, 8-bit/color RGB, non-interlaced          # the verified 4:3 size
```

The free read-back checks all behave on the real file:

| Request | Result |
| --- | --- |
| `If-None-Match: "49ee3bee…"` | `304 Not Modified` |
| `HEAD /files/…` | `200`, with `etag` + `content-length: 1854595` |
| `Range: bytes=0-31` | `206`, `content-range: bytes 0-31/1854595` |
| `/files/..%2F..%2F..%2Fetc%2Fpasswd` | `404` (not a 200 page of HTML) |
| `GET /v1/images?limit=3` | the generation, newest first |

The image itself is at `docs/relay-girl-skateboard.png`.

**Re-confirmed later, through the gateway's own front door.** Two more paid calls,
both issued the way `/playground` issues them (`X-Relay-Token`, `mode: "image"`):

| Prompt | aspect | Result | Wall clock | Bytes | Pixels |
|---|---|---|---|---|---|
| a happy American girl skateboarding on a sunny boardwalk, golden hour, cinematic | `4:3` | 200, `cached: false` | 10.9 s | 1,711,949 | **1184×864** |
| a lone lighthouse on a cliff at dusk, long exposure, dramatic clouds | `16:9` | 200, `cached: false` | 9.2 s | 1,464,653 | **1344×768** |

Both carried `c2pa: true` and `upstream.sourceField: "image"`. The second is the
interesting one: **1344×768 is the measured 16:9 size, produced end-to-end through
the gateway**, which confirms the aspect table survives the whole path and not just
a direct call to the origin. Both sha256s matched the downloaded bytes.

**Three things this settled.** All three were previously guesses:

1. **The image arrives inline in a field named `image`** — `sourceField: "image"`, a
   `data:image/png;base64,…` URL. `INLINE_FIELDS` already preferred `image` first, so
   the extraction needed no change; it is now a verified fact rather than a ranking.
2. **A successful response carries no `id`, no `width` and no `height`.** Only the
   image. `upstream.id` is `null` in the envelope above, and the dimensions were
   missing until the fix below.
3. **The `c2pa` flag is real on a genuine generation** — the origin embeds a C2PA
   credential (`caBX` chunk), as it did in the original capture.

Because of (2), `app/filestore.py` grew `image_dimensions()`: the gateway holds the
bytes either way, so it reads width/height out of the header instead of shipping an
envelope with blanks in it. PNG/JPEG/GIF/WebP, no new dependency, `None` on anything
it cannot parse — and upstream values still win when the origin does send them.

### Developing without spending

A *successful* call is the one thing that cannot be tested for free against the real
service. So there is a stand-in origin, and a script that drives the whole pipeline
through it:

```bash
python scripts/fake_origin.py 5001 &
IMAGE_GATEWAY_UPSTREAM=http://127.0.0.1:5001 IMAGE_GATEWAY_ACCESS_TOKEN=demo ./run.sh &
python scripts/demo_gateway.py http://127.0.0.1:4399 demo
```

```
[1] generate -> short URL
  PASS  response carries a short URL
  PASS  no base64 blob in the response  (551 bytes)
[2] the short URL serves the image
  PASS  bytes are non-trivial  (2160538 bytes)
  PASS  If-None-Match -> 304
  PASS  Range -> 206  (8 bytes)
[3] dedup is about storage, not about skipping the call
  PASS  same bytes collapse to one id
  PASS  the second caller is told
[4] every shape an image can arrive in
  PASS  url      -> 200  (fetched back from the origin)
  PASS  openai   -> 200  (b64_json)
  PASS  binary   -> 200  (raw body)
  PASS  queued   -> 502  (no image -> upstream_no_image)
  PASS  foreign  -> 502  (off-origin URL -> upstream_bad_image_url)
  PASS  error    -> 400  (origin's own error, passed through)
[8] why this exists
  the image itself is 2,160,538 bytes
  inline -- what the origin sends -- is ~2,880,717 bytes of base64,
  in every single response body
  what the client actually got: 551 bytes, image one GET away
  5228x less to carry around

31 passed, 0 failed
```

`fake_origin.py` answers the real path with the real captured PNG and lets you pick
the response shape per request (`X-Fake-Shape: inline|url|openai|binary|queued|error|foreign`),
so every branch of the extraction code is reachable without a network round trip.
`X-Fake-Salt` changes the bytes, which is what keeps a repeat run from deduping into
the previous one's file.

---

## What the capture actually contained

`re.txt` is a browser "Copy all as cURL" dump of three entries:

| # | Request | Status |
|---|---|---|
| 1 | `POST https://<origin>/api/v1/media/ai/image` — `{"mode":"image","prompt":"现代铅笔插画，意大利阿马尔菲海岸…","aspect":"4:3"}`, header `X-Device-Id: web-00000000-…` | the endpoint this mock exists for |
| 2 | `curl 'data:image/png;base64,iVBOR…'` — a 2.88 MB data URL | the generated image; the exporter overwrote the request URL with the body, so its real target is **unrecoverable** |
| 3 | `GET https://<origin>/assets/Assistant-Regular-00000000.woff2` | request only — no response body was captured |

Three things in that dump are **redacted**, because each of them would say *which*
service this came from: the host, the real name of the device header, and the build
hashes inside asset filenames. The host comes from `IMAGE_GATEWAY_UPSTREAM`; the
header name is the one wire constant in `app/upstream.py`. Nothing else in the tree
repeats them.

**There were no responses in the dump.** So the mock's success payload is a
reconstruction. What *is* grounded in evidence is listed below, and the
reconstruction is confined to `app/responses.py` — a one-file change if the real
contract turns out to differ.

### Observed live (probed, no generation triggered)

Four probes were made against the real host. None of them could trigger an image
generation: `OPTIONS` has no body, `POST {}` is rejected before the prompt is ever
read, and the other two are GETs of non-routes.

| Probe | Result | What it tells us |
|---|---|---|
| `OPTIONS /api/v1/media/ai/image` | `204`, no body, no CORS headers | same-origin app; preflights are trivial |
| `POST /api/v1/media/ai/image` `{}` | `400 {"error":"bad_mode"}` | the error envelope is **flat snake_case, no wrapper** — and `mode` is validated *first* |
| `POST /api/v1/__nope__` | `405`, `Allow: GET, HEAD`, empty body | non-route POSTs are rejected by the static-file handler |
| `GET /api/v1/__nope__` | `200 text/html` | **SPA fallback**: unmatched GETs return `index.html`, not 404 |

The `Server: Kestrel` header on every response identifies the real backend as
ASP.NET Core.

### Observed in the capture

- The real service answered `aspect: "4:3"` with a **1184×864** PNG — ratio
  **1.3704**, not 1.3333. The mock reproduces those exact dimensions, and when a
  request asks for something else it reports both `width`/`height` (what you got)
  and `requestedWidth`/`requestedHeight` (what you asked for), so a client can
  never be quietly misled.
- That PNG carries a `caBX` C2PA manifest from *Google Media Processing Services*.
- The client received the image as a **base64 data URL**, which is why `inline`
  is the default response style.
- The prompt is 288 characters; the device header shape is `web-<uuid>`.

Everything verified by a test lives in `tests/test_capture.py`, which fails loudly
if the capture is ever re-extracted differently.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/media/ai/image` | the captured endpoint |
| `POST` | `/api/v1/media/upload` | mock extension — data-URL upload **(inferred)** |
| `GET` | `/assets/generated/<id>.png` | bytes for `url`-style responses |
| `GET` | `/assets/uploaded/<id>.bin` | bytes for uploaded data URLs |
| `GET` | `/assets/<path>` | static files; the captured font was never recorded |
| `POST` | `/v1/images` | **gateway** — the wrapped flow (auth → upstream → re-host) |
| `GET` | `/v1/images` | **gateway** — recent generations, newest first |
| `GET` | `/v1/images/<id>` | **gateway** — metadata for one stored image |
| `GET`/`HEAD` | `/files/<name>` | **gateway** — the bytes; immutable, `ETag`, `Range` |
| `GET` | `/v1/config` | **gateway** — the public contract, no secrets |
| `GET` | `/playground` | **gateway** — the prompt form (see *The prompt playground*) |
| `GET` | `/manual/…` | **gateway** — the H5 manual, served from `docs/manual/` |
| `GET` | `/__mock__/state` | settings, counters, capture summary |
| `GET` | `/__mock__/relay` | relay status — answers "will this spend money?" |
| `GET` | `/__mock__/gateway` | gateway status, storage stats, open-gateway warning |
| `POST` | `/__mock__/config` | retune a running mock (incl. `mode`, `upstream`) |
| `POST` | `/__mock__/reset` | clear counters and stored items |
| `GET` | `/__mock__/capture` | the parsed dump, as JSON |
| `GET` | `/__mock__/requests` | recent requests (`?source=memory\|file`) |
| `GET` | `/__mock__/docs` | OpenAPI UI |
| `GET` | `/__mock__/healthz` | liveness |
| `GET` | anything else | `200 text/html` (SPA fallback) |
| *other* | anything else | `405`, `Allow: GET, HEAD`, empty body |

Everything under `/__mock__` is mock-only and namespaced so it can never collide
with a real endpoint. Everything under `/v1`, `/files`, `/playground` and
`/manual` belongs to the gateway and is **never** forwarded by the raw relay —
those paths do not exist on the origin, so relaying them would replace the
gateway's own answer with the origin's SPA fallback. The list lives in one place,
`relay.py::GATEWAY_PREFIXES`; add new pages there or they will be relayable.

### Request body

```json
{ "mode": "image", "prompt": "…", "aspect": "4:3" }
```

Unknown fields are **echoed back** in `echoedFields` rather than dropped — usually
how you discover a field a client depends on.

`aspect` accepts `4:3`, `4x3`, `4/3` (normalised), plus an explicit `1400x700`
escape hatch. Blank means unset, not invalid.

### Validation order and error codes

**There are two error families, and they are not interchangeable.** Probed live on
2026-09-24: a wrong JSON *type* never reaches the application at all. ASP.NET's model
binding rejects it first and answers with an RFC 9110 `ValidationProblemDetails`
document — a different media type and a different body shape:

```jsonc
// {"mode": {}, "prompt": 123}  ->  application/problem+json
{"type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
 "title": "One or more validation errors occurred.",
 "status": 400,
 "errors": {"$.mode": ["The JSON value could not be converted."]}}
```

Only values that bind successfully are judged by the application, which answers flat:

```jsonc
// {"mode": "video"}   ->  application/json
{"error": "bad_mode"}
```

Model binding **stops at the first offending property in DTO order**, which is
`mode`, then `prompt`, then `aspect`. So `{"mode": {}, "prompt": 123}` reports
`$.mode` and nothing else. The mock reproduces that, because a client walking its
way out of an error must see the same first error the real service would give it.

The mock's own order is `body size → JSON → binding → mode → prompt → aspect → device`.

| Status | `error` | Trigger | Source |
|---|---|---|---|
| 400 | `bad_mode` | missing or unsupported `mode` (a *string*) | **observed** |
| 400 | `empty_prompt` | missing, blank or empty `prompt` | **observed** |
| 400 | *(problem+json)* | non-string `mode` / `prompt` / `aspect` | **observed** |
| 502 | `upstream` | upstream image service failed (e.g. a malformed ratio) | **observed** |
| 400 | `bad_body` | unparsable JSON, or a non-object body | inferred |
| 400 | `prompt_too_long` | only when `IMAGE_GATEWAY_PROMPT_OVERFLOW=reject` | inferred |
| 401 | `missing_device` / `bad_device` | only when `IMAGE_GATEWAY_REQUIRE_DEVICE=true` | inferred |
| 413 | `payload_too_large` | over `IMAGE_GATEWAY_MAX_BODY_BYTES` | inferred |
| 429 / 500 / 502 / 503 / 504 | `rate_limited` / `internal_error` / `upstream_error` / … | failure injection | mock-only |
| 404 | `asset_not_captured` | an asset whose response body was never recorded | mock-only |
| 500 | `internal_error` | unhandled — logged server-side, never leaked to the caller | mock-only |

Two corrections landed here, both from live probing:

* **`bad_prompt` does not exist.** The real code is `empty_prompt`. The mock used to
  emit `bad_prompt`; that was a guess, and it was wrong.
* **There is no `bad_aspect`.** An unknown but well-formed ratio is *accepted*:
  `"99:1"` returned 200 at the default 1184x864 frame. A non-string `aspect` is a
  binding failure instead. See "What the API actually accepts" below.

### What a person sees when a generation fails

The error **body** is deliberately only `{"error": "<code>"}` — it reconstructs the
origin's envelope, and adding a `message` key there would make the mock disagree
with the thing it exists to imitate. So the explanation lives in the two pages,
not in the API:

| Where | What it shows |
|---|---|
| `#fail` (root page) / `#errorBox` (playground) | status, code, what happened, what to change |
| status line | `HTTP 502 · origin HTTP 500` — the origin's own status when the failure came from it |
| raw body | always kept, so the reconstructed envelope stays inspectable |
| 429 only | the `Retry-After` seconds, because "wait" without a number is not advice |

Two failure modes that are easy to miss because they never produce an error status:

* **200 with no usable image URL** → treated as a failure (`no_image_url`), not an
  empty stage.
* **200 whose bytes never arrive** (`img.onerror`: the file was moved out of `data/`,
  or the asset route 404s) → `image_unreachable`, instead of a broken-image icon and
  silence.

The code → explanation tables are duplicated across the two pages, because the
pages are self-contained by design (no build step, no second `<script src>`).
`tests/test_error_explanations.py` holds them to each other and to the backend: a
new `ApiError(...)` in `app/` fails the suite until both pages learn to explain it.

### The prompt budget

**4000 characters**, `IMAGE_GATEWAY_MAX_PROMPT_CHARS`. Counted in *characters*, not
bytes: 4000 CJK characters are about 12 KB of UTF-8, so a byte limit would cut a
Chinese prompt at roughly a third of the advertised length. `0` means no limit.

Going over the budget **does not fail the request**. The prompt is cut to the limit
and generation proceeds, because a caller who pasted too much text wants an image,
not a validation lecture. The cut is reported rather than hidden:

| Surface | Signal |
|---|---|
| `POST /v1/images` response body | `"promptTruncated": true` (absent when nothing was cut) |
| any response | `X-Prompt-Truncated: true` |
| `GET /__mock__/requests` | `promptTruncated` on the log record |
| `GET /v1/config` | `limits.maxPromptChars` and `limits.promptOverflow` |
| both browser pages | live counter under the prompt box, turns red past the limit |

The counter is worth calling out because it is the only signal a person sees *before*
the image comes back. Both `/` and `/playground` read `limits.maxPromptChars` from
`/v1/config` rather than hardcoding 4000 — otherwise changing the env var would make
the page confidently display the wrong number. `0` renders as "no limit" instead of
a nonsensical `288 / 0`.

Truncation happens **before** the rate limiter and before the upstream call, so you
are never billed for text the origin would have rejected, and the stored metadata
records the prompt that actually produced the image.

Set `IMAGE_GATEWAY_PROMPT_OVERFLOW=reject` to restore the hard failure
(`400 {"error":"prompt_too_long"}`) — useful when shipping an image built from half a
prompt would be worse than an error.

`IMAGE_GATEWAY_GATEWAY_VALIDATE=false` bypasses all of this: the body is forwarded
verbatim and the origin becomes the only judge, as it does for every other field.

---

## What the API actually accepts

Probed against the real origin on 2026-09-24. The request DTO binds **four** fields
and silently ignores everything else.

| Field | Type | Verdict | Evidence |
|---|---|---|---|
| `mode` | string | bound, checked first | only `image`; anything else `400 bad_mode` |
| `prompt` | string | bound | empty/blank → `400 empty_prompt` |
| `aspect` | string | bound, **value never validated** | 5 ratios measured; unknown ratio falls back to 4:3 |
| `image` | string | bound | **image-to-image.** base64 data URL works; an http URL → `502` |
| `model`, `seed`, `style`, `negativePrompt`, `width` | — | **ignored** | one paid generation each; the DTO does not bind them |

How the "ignored" rows were established, since it is not obvious: model binding
reports only the *first* bad field in DTO order, so any candidate that sorts after
`aspect` cannot be tested for free — if the name is not bound, the request is simply
valid and a generation happens. Each of those five therefore cost one real
generation, and all five returned 200 with an unchanged image. `image` behaved
differently (`400 upstream_error` on `{}`), which is what marked it as real.

### `image` is image-to-image, and it wants a data URL

Discovered by probing, not from the capture — `re.txt` never contained it.

```
image: "data:image/png;base64,…"   ->  200, a normal generation
image: "https://example.com/x.png" ->  502 {"error":"upstream"}
```

The origin does not fetch a URL for you, so a reference image has to be inlined.
**What this does *not* prove:** that the reference meaningfully conditions the
output. The reference used here was a 128x128 procedurally generated placeholder,
and the two results differ mainly through generation randomness. Establishing the
*strength* of the conditioning needs an A/B with a real photograph.

### Measured output sizes

One paid generation per ratio:

| `aspect` | Output | Ratio |
|---|---|---|
| `1:1` | 1024x1024 | 1.0000 |
| `4:3` | 1184x864 | 1.3704 |
| `3:4` | 864x1184 | 0.7297 |
| `16:9` | 1344x768 | 1.7500 |
| `9:16` | 768x1344 | 0.5714 |
| *anything else* | 1184x864 | falls back to the 4:3 frame |

This killed the rule `app/aspects.py` used to derive the unmeasured tokens. It held
the long edge at 1184 px, which would have given `16:9 -> 1184x672`. The real answer
is **1344x768**. Every measured side is a multiple of **32** and every measured area
sits in a 1.02–1.05 MP band; the remaining guesses now follow that instead.

---

## The H5 manual

`docs/manual/index.html` — a self-contained walkthrough for anyone who has to *use*
this API, with the parameter findings above and controlled-variable image galleries
that show what each parameter actually does.

Open it directly (`file://` works — the data is embedded, nothing is fetched). Each
gallery changes exactly one variable:

| Gallery | Held constant | Varied |
|---|---|---|
| `#aspect` | the prompt | the frame: 4:3, 1:1, 16:9, 3:4, 9:16 |
| `#prompt` | `aspect: 4:3` | the subject: skateboarder, corgi, geometric poster |
| `#image` | prompt + aspect | presence of a reference image |

The anchors are not decoration: they make each gallery shareable, and they are how
the page is verified (a one-shot headless screenshot can navigate to `#aspect` but
cannot scroll).

```bash
python scripts/collect_manual_assets.py --dry-run   # print the plan and the cost
python scripts/collect_manual_assets.py             # 12 real generations
python scripts/build_manual.py                      # render the HTML from the manifest
```

`manifest.json` next to the HTML is the evidence: every request body, response
envelope, measured pixel size and sha256. Cases whose result was already observed
are recorded rather than re-spent, and `--only <group>` re-runs one group while
merging the rest, so a partial run never re-buys the whole set.

The manual is served at `/manual/`, so the page above is a click away rather than
something you have to open from disk.

---

## The prompt playground

`GET /playground` serves `assets/playground/index.html` — a self-contained form
for generating real images without writing curl. Same origin as the gateway, no
external dependencies, no build step.

It gives you: the prompt, the five measured frames (plus a free-form one), an
optional reference image for image-to-image, and a result card carrying the
image, its pixel size, the wall-clock time, the sha256 and whether the origin
stamped C2PA.

**It generates for real, every time you press the button.** That is the point of
the page and it is stated on the page. Two things make that safe to say:

- the gateway has no mock branch on `/v1/images` — `app/gateway.py::generate()`
  always calls `settings.upstream`. `IMAGE_GATEWAY_MODE` governs the *relay* paths
  (`/api/…`, `/assets/…`) and is not consulted here at all;
- every response carries `cached` and the upstream status, so a re-used image is
  labelled as such rather than passed off as a new one.

The token field is the **gateway's** shared secret (`X-Relay-Token`), stored in
`localStorage['image-gateway-token']` on your machine and sent with each request. It
is not the upstream's credential — the gateway holds that one and never hands it
to a browser. The page says so, because this is the single most confusing thing
about running a gateway.

`/playground` and `/manual/` are both in `GATEWAY_PREFIXES`, so the relay will
never forward them. That constant is the one place that lists the paths this
service owns; a new page that is not added to it will be reachable by
`X-Mock-Mode: relay`, which is exactly the inconsistency the tests now pin.

---

## Driving the mock

### Per-request overrides

All optional, all mock-only, all headers:

| Header | Effect |
|---|---|
| `X-Mock-Delay: 1500` | force a latency in ms (default: random 700–2200) |
| `X-Mock-Fail: 429` | force this status; `off` disables injection |
| `X-Mock-Style: url` | `inline` \| `url` \| `openai` |
| `X-Mock-Variant: placeholder` | `captured` \| `placeholder` |
| `X-Mock-Seed: abc123` | pin the deterministic seed |
| `X-Request-Id: trace-1` | echoed back as `requestId` |

### Response styles

- **`inline`** (default) — image bytes as a `data:` URL. Matches what the captured
  client actually received. ~2.9 MB per response.
- **`url`** — `{"url": "http://127.0.0.1:4399/assets/generated/img_….png"}`. Much
  lighter, easier to eyeball, and the mock serves the bytes itself.
- **`openai`** — OpenAI images-compatible `{"created":…,"data":[{"b64_json":…}]}`,
  for drop-in clients.

### Variants

- **`captured`** (default) — returns the real 1184×864 PNG from `re.txt`,
  C2PA manifest included. Byte-for-byte what the real service produced.
- **`placeholder`** — synthesises a deterministic identicon at the size mapped
  from the requested aspect, so you can exercise every ratio. Same prompt and
  size always produce identical bytes, which is what makes determinism testable.

### Simulating the bad days

```bash
# 10% of calls fail with 502, everything else gets 3–5s of latency
IMAGE_GATEWAY_FAIL_RATE=0.1 IMAGE_GATEWAY_FAIL_STATUS=502 \
IMAGE_GATEWAY_LATENCY_MIN_MS=3000 IMAGE_GATEWAY_LATENCY_MAX_MS=5000 ./run.sh

# or retune a running instance
curl -s -X POST localhost:4399/__mock__/config \
  -H 'content-type: application/json' -d '{"fail_rate":0.25,"response_style":"url"}'
```

`IMAGE_GATEWAY_DETERMINISTIC=true` (the default) makes the same prompt and aspect
always produce the same `id` and the same bytes — handy for idempotency tests.
Set it to `false` to get a fresh id per call.

### Inspecting what your client sent

Every request is kept in an in-process ring buffer (last 500) and readable via
`/__mock__/requests`. With `IMAGE_GATEWAY_LOG_REQUESTS=true` (the default) it is also
appended to `capture/requests.jsonl`, rotated at 32 MB:

```json
{"ts":"2026-09-23T08:23:26.4Z","method":"POST","path":"/api/v1/media/ai/image",
 "status":200,"durationMs":356.2,"kind":"ai-image","mode":"image","aspect":"4:3",
 "promptChars":288,"prompt":"现代铅笔插画…","device":"web-00000000-…"}
```

```bash
curl -s 'localhost:4399/__mock__/requests?limit=5'            # in-memory (default)
curl -s 'localhost:4399/__mock__/requests?source=file'        # tail the JSONL
```

The buffer is what the control plane reads, so "what did my client send?" keeps
working even with file logging off or the file unwritable — which is also why the
test suite needs no writable directory. Rejected calls are tagged too, so "which
prompt got `bad_mode`?" is a `grep` away.

---

## Configuration

Every variable has a working default; an empty file is a valid config. See
`.env.example` for the annotated list.

> **Nothing here is read from a `.env` file.** Export these, or pass them inline.
> For the smallest set that reaches the real origin, and the four ways a call can
> silently fail to, see [Wiring it to the real API](#wiring-it-to-the-real-api).

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_GATEWAY_PORT` | `4399` | listen port |
| `IMAGE_GATEWAY_MODE` | `mock` | `mock` \| `relay` — see Relay mode above |
| `IMAGE_GATEWAY_UPSTREAM` | — | real origin, e.g. `https://upstream.example.com` |
| `IMAGE_GATEWAY_RELAY_PATHS` | `/api/,/assets/` | path prefixes that may be forwarded |
| `IMAGE_GATEWAY_RELAY_TIMEOUT_S` | `60` | outbound timeout |
| `IMAGE_GATEWAY_RELAY_HEADERS` | — | JSON headers injected upstream (auth) |
| `IMAGE_GATEWAY_RELAY_TRUST_ENV` | `true` | honour `HTTP_PROXY` for the outbound leg |
| `IMAGE_GATEWAY_CORS` | `*` | **deviation** — see below |
| `IMAGE_GATEWAY_MODES` | `image` | allowed `mode` values |
| `IMAGE_GATEWAY_RESPONSE_STYLE` | `inline` | `inline` \| `url` \| `openai` |
| `IMAGE_GATEWAY_VARIANT` | `captured` | `captured` \| `placeholder` |
| `IMAGE_GATEWAY_LATENCY_MIN_MS` / `_MAX_MS` | `700` / `2200` | simulated latency |
| `IMAGE_GATEWAY_FAIL_RATE` | `0.0` | fraction of calls that fail |
| `IMAGE_GATEWAY_ASSET_MISS` | `not_found` | `not_found` \| `placeholder` \| `proxy` |
| `IMAGE_GATEWAY_ASSET_UPSTREAM` | — | upstream for `asset_miss=proxy` |
| `IMAGE_GATEWAY_LOG_REQUESTS` | `true` | append requests to the JSONL file (the in-memory buffer is always on) |
| `IMAGE_GATEWAY_GATEWAY_ENABLED` | `true` | serve `/v1/*` and `/files/*` |
| `IMAGE_GATEWAY_ACCESS_TOKEN` | — | **set this.** Empty means the gateway is open to anyone |
| `IMAGE_GATEWAY_DEVICE_ID` | — | **set this to reach the origin.** Empty means no override |
| `IMAGE_GATEWAY_OVERRIDE_DEVICE` | `true` | replace the client's `X-Device-Id` (only when `_DEVICE_ID` is set) |
| `IMAGE_GATEWAY_FILES_DIR` | `data/files` | where re-hosted images live (gitignored) |
| `IMAGE_GATEWAY_FILES_REQUIRE_TOKEN` | `false` | gate `/files/*` too; off so `<img src>` works |
| `IMAGE_GATEWAY_RATE_LIMIT_PER_MINUTE` | `0` | per credential; `0` disables |
| `IMAGE_GATEWAY_MAX_CONCURRENT_UPSTREAM` | `8` | simultaneous upstream calls |
| `IMAGE_GATEWAY_QUEUE_TIMEOUT_S` | `10` | how long a caller waits before `503 upstream_busy` |
| `IMAGE_GATEWAY_RELAY_RETRIES` | `0` | connect-stage retries only — see the retry policy above |
| `IMAGE_GATEWAY_NORMALIZE_RESPONSE` | `true` | `false` hands back the origin's payload untouched |
| `IMAGE_GATEWAY_GATEWAY_VALIDATE` | `true` | `false` forwards everything, letting the origin judge |

**`IMAGE_GATEWAY_DEVICE_ID` ships blank on purpose.** `X-Device-Id` is the credential
the gateway presents to the origin *instead of* the client's — `Settings.as_dict()`
redacts it for exactly that reason — so the value from the original capture is not
committed. It belongs to whoever took that capture. Take your own: open
`upstream.example.com` in a browser, copy the `X-Device-Id` request header, and export
it. The shape is `web-<uuid>`.

With it unset the gateway does not override the header at all — it passes the
client's own through. That is deliberate: "override" with nothing to override with
would otherwise mean "delete", and silently sending the origin a request with no
device at all fails in a far more confusing way than a missing credential does.

### Deliberate deviations from the real service

Each is a usability call, and each is reversible:

1. **CORS is on by default.** The real service returns no CORS headers at all
   (its app is same-origin), but a dev mock is usually called from
   `localhost:5173`. Set `IMAGE_GATEWAY_CORS=` to reproduce the real behaviour.
   Consequence: an `OPTIONS` preflight returns `200` with headers instead of the
   real `204` with none.
2. **Unmatched GET returns a mock landing page**, not a copy of the real
   `index.html`. Status, content type and `Cache-Control: no-cache` match.
3. **The missing font is a 404 by default**, because its response body was never
   captured. `IMAGE_GATEWAY_ASSET_MISS=placeholder` returns an empty `200` so a page
   under test does not break; `proxy` streams the real bytes from
   `IMAGE_GATEWAY_ASSET_UPSTREAM`.
4. **`/__mock__/*` and `/assets/generated/*` are new.** Namespaced so they cannot
   shadow anything real.

---

## Tests

```bash
python -m pytest              # 257 tests
```

| File | Tests | Covers |
|---|---|---|
| `test_capture.py` | 25 | the extraction step: PNG dimensions, C2PA, the parsed spec, the measured aspect table, PNG encoder |
| `test_config.py` | 29 | `IMAGE_GATEWAY_*` parsing, including `IMAGE_GATEWAY_CORS=` meaning "off" and the relay knobs |
| `test_control.py` | 14 | the control plane and the request log |
| `test_errors.py` | 38 | both error families, binding order, validation order, failure injection, device header, no-leak on 500 |
| `test_gateway.py` | 83 | the 中转站: auth, rate limiting, the concurrency gate, re-hosting, dedup, SSRF, upstream passthrough, conditional GETs, header-sniffed dimensions |
| `test_image_endpoint.py` | 15 | the happy path in all three styles, determinism, latency override |
| `test_relay.py` | 28 | relay: forwarding fidelity, header hygiene, the path allowlist, upstream failures, secret redaction |
| `test_routing.py` | 19 | SPA fallback, 405, OPTIONS, CORS, assets, path traversal |
| `test_upload.py` | 6 | data-URL uploads and their round trip |

No test touches the network. The relay and gateway suites inject an
`httpx.MockTransport` as the outbound leg, so they assert exactly what *would* have
been sent upstream — which is how the credential-leak tests work — and can make it
fail on demand. None of them can spend money.

`tests/test_errors.py::test_empty_body_matches_the_observed_real_response` pins the
one error response that was observed live.

### On the filesystem

The gateway tests are the only ones that write real files, because storing what it
fetches is the thing under test — a fake store would not be testing it. They use the
`work_dir` fixture, which derives a stable path from the test id inside
`.pytest-work/` and **never deletes anything**:

- pytest's own `tmp_path` is unusable here — creating anything under the system temp
  directory is refused in this sandbox;
- deleting is gated behind an interactive approval, so a self-cleaning fixture does
  not fail loudly, it silently leaks directories.

Because the directory is reused between runs, tests that care how much is stored
assert a **delta** (`before + 1`) rather than an absolute count, and each run salts
the fake origin's image bytes so `cached` stays meaningful. Everything else in the
suite still writes nothing at all.

**If pytest hangs with no output**, a third-party plugin's autoload is stalling
(seen under heavy machine load). Skip it:

```bash
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python -m pytest
```

---

## Layout

```
app/
  main.py          app factory: relay gate, middleware, error envelope, SPA fallback, 405
  relay.py         relay (中转) mode: allowlist, header hygiene, upstream failures
  gateway.py       中转站 core: upstream call, concurrency gate, image extraction, re-hosting
  security.py      the gateway's shared token + sliding-window rate limiter
  filestore.py     content-addressed image store (sha256 id, atomic writes, ETag)
  urls.py          absolute-URL construction, shared by the mock and the gateway
  config.py        Settings dataclass, IMAGE_GATEWAY_* env, validation
  validation.py    ordered request validation + ApiError
  responses.py     the reconstructed payloads (all three styles)
  aspects.py       aspect token -> pixel size, with provenance per entry
  images.py        captured PNG vs synthesised placeholder
  png.py           minimal stdlib PNG encoder (no Pillow)
  store.py         in-memory items + append-only JSONL request log
  routes/          media.py, assets.py, control.py, gateway.py
assets/
  captured-generated.png       the real 1184x864 image, extracted from re.txt
  web/index.html               SPA fallback / self-demo page
  playground/index.html        the prompt form, served at GET /playground
capture/
  spec.json                    the parsed dump (generated)
  requests.jsonl               runtime request log (gitignored)
data/
  files/                       re-hosted images (gitignored runtime state)
docs/
  demo.png                     screenshot of the demo page working
  relay-girl-skateboard.png    the first real (paid) generation
  manual/
    index.html                 the H5 manual (self-contained, opens from file://)
    manifest.json              the evidence behind it: every request, response, size, sha256
    img/                       the controlled-variable image set
scripts/
  extract_capture.py           re.txt -> spec.json + captured-generated.png
  replay_capture.py            end-to-end replay against a running mock
  fake_origin.py               a free stand-in for upstream.example.com, all response shapes
  demo_gateway.py              drive the whole gateway pipeline and check it
  collect_manual_assets.py     the paid controlled-variable generation run (--dry-run first)
  build_manual.py              render the H5 manual from the manifest
tests/
```

### Regenerating from a new capture

```bash
python scripts/extract_capture.py /path/to/new-re.txt
python -m pytest
```

The extractor is tolerant of the exporter's quirks — it handles the trailing `;`
after `--data-raw`, and the malformed `-H 'Referer;'` it emits.

---

## Known gaps

- **The *mock* success payload is still a reconstruction** — but no longer a blind
  one. A real generation is now on record (see "A real generation, start to finish"),
  and it confirms the important half: the image arrives inline in a field named
  `image` as a data URL, with no `id` and no dimensions alongside it. What remains
  inferred is only the *decorative* part of `app/responses.py` — the exact set of
  sibling fields (`aspect`, `mode`, …) the origin wraps around it. In `relay` and
  gateway mode this gap does not exist: you get the real bytes.
- **The relay is verified for a static asset, a validation error and a successful
  generation.** The first two are free by construction; the third is a real paid call
  made on 2026-09-24 and recorded above. It is not re-runnable for free — see
  `IMAGE_GATEWAY_RELAY_RETRIES`, which is 0 by default precisely because a retried
  generation can bill twice.
- **`POST /api/v1/media/upload` is a guess.** The capture proves a 2.88 MB data
  URL was sent somewhere, but not where.
- **Five aspect ratios have a verified output size** (`1:1`, `4:3`, `3:4`, `16:9`,
  `9:16` — measured, see "Measured output sizes"). The rest of `app/aspects.py` is
  still guessed, but no longer by a rule that was *disproved*: the guesses now follow
  the observed pattern (both sides a multiple of 32, area near 1.03 MP). One table,
  one place to fix.
- **`image` is proven to be *accepted*, not proven to *matter*.** The reference image
  used was a procedurally generated placeholder, so the A/B does not establish how
  strongly it conditions the output. That needs a second paid experiment with a real
  photograph.
- **The `image` field's accepted encodings are only partly mapped.** A base64 data
  URL works and an http URL does not; whether a bare base64 blob (no `data:` prefix)
  also works was not tested.
- **`mode` is limited to `image`** in mock mode, which is all that was ever
  observed. `IMAGE_GATEWAY_MODES=image,video` if you need more — nothing else in the
  code assumes a single mode. (Relay mode does not validate `mode` locally at all;
  it hands the body to the real origin, which is the authority.)
- **The captured font's bytes are missing from the capture** and cannot be
  recovered from a request-only dump — `relay` mode or `IMAGE_GATEWAY_ASSET_MISS=proxy`
  fetches them for real.
- **The gateway's first real generation is done, and its shape is recorded.** The
  envelope is complete (`width`/`height` are read off the image header when the origin
  omits them), the re-hosted bytes are byte-identical to the origin's, and the
  read-back path — conditional GET, HEAD, Range — was exercised on the real file. What
  is *not* covered is a second real generation: every paid shape other than the one
  inline-`image` case is still only exercised through `fake_origin.py`.
- **The gateway's rate limiter is per process.** Behind more than one worker the
  effective limit multiplies by the worker count. Deliberately not papered over with
  a fake global counter; use a shared store if you need a real one.
- **There is no delete or retention endpoint.** `FileStore.delete()` exists and is
  unit-tested, but nothing calls it: exposing a destructive route on a
  token-optional service is not a decision to make on the user's behalf. Stored
  images are gitignored runtime state; clear `IMAGE_GATEWAY_FILES_DIR` to reclaim the
  space.
- **The gateway's local validation is deliberately narrower than the origin's.**
  `mode` (observed) and `prompt` (inferred) are checked before spending a call;
  `aspect` is not, because our size table is a local guess and rejecting on it would
  turn a working request into a fake failure. `IMAGE_GATEWAY_GATEWAY_VALIDATE=false`
  forwards everything.
