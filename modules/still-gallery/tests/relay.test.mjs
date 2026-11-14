import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { GenerationError } from '../lib/image-gen.mjs';
import {
  RELAY_DEFAULT_BASE_URL,
  RELAY_LOCAL_BASE_URL,
  RELAY_MAX_PROMPT_CHARS,
  RELAY_MODEL_LABEL,
  buildRelayPayload,
  describeRelayFailure,
  generateViaRelay,
  isConnectFailure,
  isRouteMiss,
  normalizeRelayBaseUrl,
  parseRelayResponse,
  resolveRelayEndpoint,
  resolveRelayEndpoints,
  toReferenceDataUrl,
} from '../lib/relay-gen.mjs';

const PASSWORD = 'correct-horse-battery';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 3),
]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

/* ================================================================== *
 * 端点
 * ================================================================== */

test('resolveRelayEndpoint appends /v1/images to a bare base', () => {
  assert.equal(resolveRelayEndpoint('https://api.01ai.fun'), `${RELAY_DEFAULT_BASE_URL}/v1/images`);
  assert.equal(resolveRelayEndpoint('https://api.01ai.fun/'), `${RELAY_DEFAULT_BASE_URL}/v1/images`);
  assert.equal(resolveRelayEndpoint(''), `${RELAY_DEFAULT_BASE_URL}/v1/images`);
});

test('resolveRelayEndpoint keeps a full endpoint and tolerates a /v1 suffix', () => {
  assert.equal(
    resolveRelayEndpoint('https://api.01ai.fun/v1/images'),
    'https://api.01ai.fun/v1/images',
  );
  assert.equal(resolveRelayEndpoint('https://api.01ai.fun/v1'), 'https://api.01ai.fun/v1/images');
  assert.equal(resolveRelayEndpoint('https://gw.example.com/prefix'), 'https://gw.example.com/prefix/v1/images');
});

test('resolveRelayEndpoint refuses plain http off loopback', () => {
  assert.throws(() => resolveRelayEndpoint('http://api.01ai.fun'), /必须使用 https/);
  assert.equal(resolveRelayEndpoint('http://127.0.0.1:4399'), 'http://127.0.0.1:4399/v1/images');
});

test('normalizeRelayBaseUrl strips the endpoint back to a base', () => {
  assert.equal(normalizeRelayBaseUrl('https://api.01ai.fun/v1/images'), 'https://api.01ai.fun');
  assert.equal(normalizeRelayBaseUrl('https://api.01ai.fun'), 'https://api.01ai.fun');
});

test('resolveRelayEndpoints tries the local gateway before the configured base', () => {
  assert.deepEqual(resolveRelayEndpoints('https://api.01ai.fun'), [
    `${RELAY_LOCAL_BASE_URL}/v1/images`,
    'https://api.01ai.fun/v1/images',
  ]);
});

test('the local candidate is the gateway port, not the gallery port', () => {
  // 4399 是本机 image-gateway 的默认端口；4317 是 still-gallery 自己，
  // 打到那里只会在画廊上收到 405，永远够不着网关。
  assert.equal(RELAY_LOCAL_BASE_URL, 'http://127.0.0.1:4399');
});

test('resolveRelayEndpoints collapses a duplicate and honours the off switch', () => {
  // 配置地址本身就是本机地址时，不要对同一台机器发两遍。
  assert.deepEqual(resolveRelayEndpoints(RELAY_LOCAL_BASE_URL), [`${RELAY_LOCAL_BASE_URL}/v1/images`]);
  for (const off of ['off', 'none', '0', '']) {
    assert.deepEqual(
      resolveRelayEndpoints('https://api.01ai.fun', { localBaseUrl: off }),
      ['https://api.01ai.fun/v1/images'],
      `localBaseUrl=${JSON.stringify(off)} 应当关掉本机优先`,
    );
  }
});

test('isConnectFailure only trusts errors raised before the request left', () => {
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4399'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(isConnectFailure(refused), true);
  assert.equal(isConnectFailure(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), false);
  assert.equal(isConnectFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })), false);
  assert.equal(isConnectFailure(Object.assign(new Error('a'), { name: 'AbortError' })), false);
  assert.equal(isConnectFailure(null), false);
});

test('isRouteMiss only treats 404 and 405 as "no gateway here"', () => {
  assert.equal(isRouteMiss(404), true);
  assert.equal(isRouteMiss(405), true);
  for (const status of [400, 401, 403, 429, 500, 502, 503, 504]) {
    assert.equal(isRouteMiss(status), false, `${status} 不能当成没有网关`);
  }
});

/* ================================================================== *
 * 请求体
 * ================================================================== */

test('buildRelayPayload sends only mode / prompt / aspect', () => {
  const { payload, meta } = buildRelayPayload({ prompt: '一只柯基犬', aspect: '16:9' });
  assert.deepEqual(payload, { mode: 'image', prompt: '一只柯基犬', aspect: '16:9' });
  assert.equal(meta.mode, 'text2image');
  assert.equal(meta.model, RELAY_MODEL_LABEL);
  assert.equal(meta.size, '16:9');
  assert.equal(meta.group, false);
  assert.equal(meta.maxImages, 1);
  assert.equal(meta.referenceCount, 0);
});

test('buildRelayPayload omits aspect when empty and never adds the ignored fields', () => {
  const { payload, meta } = buildRelayPayload({
    prompt: 'x',
    // 这些字段网关一律静默忽略，客户端连发都不该发。
    model: 'doubao-seedream-4-0',
    size: '2K',
    optimizeMode: 'fast',
    outputFormat: 'png',
    background: 'transparent',
    webSearch: true,
    seed: 42,
  });
  assert.deepEqual(payload, { mode: 'image', prompt: 'x' });
  for (const key of ['model', 'size', 'seed', 'style', 'negativePrompt', 'width', 'optimize_prompt_options']) {
    assert.equal(key in payload, false, `${key} 不该出现在网关请求体里`);
  }
  assert.equal(meta.aspect, '4:3', '缺省画幅按上游默认的 4:3 记录');
});

test('buildRelayPayload passes unknown aspects through instead of whitelisting', () => {
  // 网关自己不校验 aspect，未知值静默回落 4:3。本地拦下来只会把能成功的请求
  // 变成失败，所以这里必须原样透传。
  const { payload } = buildRelayPayload({ prompt: 'x', aspect: '99:1' });
  assert.equal(payload.aspect, '99:1');
});

test('buildRelayPayload rejects an empty prompt and one over the gateway limit', () => {
  assert.throws(() => buildRelayPayload({ prompt: '   ' }), /提示词不能为空/);
  assert.throws(
    () => buildRelayPayload({ prompt: 'x'.repeat(RELAY_MAX_PROMPT_CHARS + 1) }),
    /上限是 4000 个字符/,
  );
  assert.doesNotThrow(() => buildRelayPayload({ prompt: 'x'.repeat(RELAY_MAX_PROMPT_CHARS) }));
});

test('buildRelayPayload accepts exactly one data-URL reference and nothing else', () => {
  const { payload, meta } = buildRelayPayload({
    prompt: 'x',
    referenceImages: [PNG_DATA_URL],
  });
  assert.equal(payload.image, PNG_DATA_URL);
  assert.equal(meta.mode, 'image2image');
  assert.equal(meta.referenceCount, 1);

  assert.throws(
    () => buildRelayPayload({ prompt: 'x', referenceImages: [PNG_DATA_URL, PNG_DATA_URL] }),
    /只能带 1 张参考图/,
  );
  assert.throws(
    () => buildRelayPayload({ prompt: 'x', referenceImages: ['https://example.com/a.png'] }),
    /必须是 base64 data URL/,
  );
});

/* ================================================================== *
 * 参考图转 data URL
 * ================================================================== */

test('toReferenceDataUrl passes a data URL straight through', async () => {
  assert.equal(await toReferenceDataUrl(PNG_DATA_URL), PNG_DATA_URL);
});

test('toReferenceDataUrl downloads a remote image and encodes it', async () => {
  const seen = [];
  const dataUrl = await toReferenceDataUrl('https://example.com/ref.png', {
    downloadImpl: async (url) => {
      seen.push(url);
      return { buffer: PNG, mime: 'image/png' };
    },
  });
  assert.deepEqual(seen, ['https://example.com/ref.png']);
  assert.equal(dataUrl, PNG_DATA_URL);
});

test('toReferenceDataUrl refuses an oversized reference and a missing downloader', async () => {
  await assert.rejects(
    () =>
      toReferenceDataUrl('https://example.com/big.png', {
        downloadImpl: async () => ({ buffer: Buffer.alloc(12 * 1024 * 1024), mime: 'image/png' }),
      }),
    /11MB 上限/,
  );
  await assert.rejects(() => toReferenceDataUrl('https://example.com/a.png'), /没有可用的下载器/);
});

/* ================================================================== *
 * 响应
 * ================================================================== */

test('parseRelayResponse flattens the gateway envelope', () => {
  const parsed = parseRelayResponse({
    id: '49ee3bee349bd48ce927ef0e712908a4',
    url: 'https://api.01ai.fun/files/49ee3bee349bd48ce927ef0e712908a4.png',
    mimeType: 'image/png',
    size: 1854595,
    sha256: 'abc',
    cached: false,
    aspect: '4:3',
    width: 1184,
    height: 864,
  });
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].size, '1184x864', '真实宽高比 aspect 字符串更有用');
  assert.equal(parsed.images[0].expiresAt, null, '内容寻址的 URL 不会过期');
  assert.equal(parsed.model, RELAY_MODEL_LABEL);
  assert.equal(parsed.relay.cached, false);
});

test('parseRelayResponse rebuilds a loopback URL from id + origin', () => {
  const parsed = parseRelayResponse(
    { id: 'deadbeef', url: 'http://127.0.0.1:4399/files/deadbeef.png', width: 1024, height: 1024 },
    { origin: 'https://api.01ai.fun' },
  );
  assert.equal(parsed.images[0].url, 'https://api.01ai.fun/files/deadbeef.png');
});

test('parseRelayResponse rewrites a loopback URL even without an id', () => {
  // 网关经常只给 url 不给 id。旧逻辑要求 id 存在才重写，于是把这个地址原样
  // 交给下载器 —— 那是本机的 4399，端口不在白名单、地址还是保留段，
  // 表现就是「生成成功，但预览 502 / 导入 400」。
  const parsed = parseRelayResponse(
    { url: 'http://127.0.0.1:4399/files/6e236e4318f761c636e33768131fe6a4.png' },
    { origin: 'https://api.01ai.fun' },
  );
  assert.equal(
    parsed.images[0].url,
    'https://api.01ai.fun/files/6e236e4318f761c636e33768131fe6a4.png',
    '没有 id 时按路径重写，扩展名要跟着保留',
  );
});

test('parseRelayResponse keeps a local gateway URL on that gateway origin', () => {
  // 网关本身就部署在本机时，重写后仍然是本机地址——这是对的，下载环节要按
  // 「操作者自己配置的网关」放行，而不是把它改到别的机器上。
  const parsed = parseRelayResponse(
    { id: 'abc', url: 'http://127.0.0.1:4402/files/abc.png' },
    { origin: 'http://127.0.0.1:4402' },
  );
  assert.equal(parsed.images[0].url, 'http://127.0.0.1:4402/files/abc.png');
});

test('parseRelayResponse leaves a public URL untouched', () => {
  const parsed = parseRelayResponse(
    { id: 'abc', url: 'https://cdn.example.com/out/abc.png' },
    { origin: 'https://api.01ai.fun' },
  );
  assert.equal(parsed.images[0].url, 'https://cdn.example.com/out/abc.png');
});

test('parseRelayResponse refuses a body with no usable image', () => {
  assert.throws(() => parseRelayResponse({}), /没有返回可用的图片地址/);
  assert.throws(() => parseRelayResponse(null), /无法解析/);
});

/* ================================================================== *
 * 错误
 * ================================================================== */

test('describeRelayFailure reads both error envelopes', () => {
  assert.match(describeRelayFailure(401, '{"error":"invalid_token"}'), /口令无效或已轮换/);
  assert.match(describeRelayFailure(401, '{"error":"missing_token"}'), /口令缺失或无效/);
  assert.match(describeRelayFailure(400, '{"error":"bad_mode"}'), /只接受 mode=image/);
  assert.match(describeRelayFailure(400, '{"error":"empty_prompt"}'), /提示词不能为空/);
  assert.match(describeRelayFailure(429, '{"error":"rate_limited"}'), /20 次\/分钟/);
  assert.match(describeRelayFailure(502, '{"error":"upstream_error"}'), /参考图/);
  assert.match(describeRelayFailure(502, '{"error":"upstream"}'), /可以重试/);
});

test('describeRelayFailure explains the problem+json binding envelope', () => {
  const body = JSON.stringify({
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    errors: { '$.mode': ['The JSON value could not be converted.'] },
  });
  assert.match(describeRelayFailure(400, body), /\$\.mode 的 JSON 类型不对/);
});

/* ================================================================== *
 * 调用
 * ================================================================== */

test('generateViaRelay posts to /v1/images with a bearer token', async () => {
  const calls = [];
  const result = await generateViaRelay(
    { prompt: '一只柯基犬', aspect: '16:9' },
    {
      token: 'relay-token',
      baseUrl: 'https://api.01ai.fun',
      // 这一条只关心协议形状，不关心地址链，所以关掉本机优先。
      localBaseUrl: 'off',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            id: 'abc',
            url: 'https://api.01ai.fun/files/abc.png',
            mimeType: 'image/png',
            width: 1344,
            height: 768,
            aspect: '16:9',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.01ai.fun/v1/images');
  assert.equal(calls[0].init.headers.authorization, 'Bearer relay-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { mode: 'image', prompt: '一只柯基犬', aspect: '16:9' });
  assert.equal(result.images[0].size, '1344x768');
  assert.equal(result.request.aspect, '16:9');
});

test('generateViaRelay converts remote references before sending', async () => {
  let sent;
  await generateViaRelay(
    { prompt: 'x', referenceImages: ['https://example.com/ref.png'] },
    {
      token: 't',
      localBaseUrl: 'off',
      downloadImpl: async () => ({ buffer: PNG, mime: 'image/png' }),
      fetchImpl: async (url, init) => {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 'a', url: 'https://api.01ai.fun/files/a.png' }), { status: 200 });
      },
    },
  );
  assert.equal(sent.image, PNG_DATA_URL);
});

test('generateViaRelay surfaces the gateway message and needs a token', async () => {
  await assert.rejects(() => generateViaRelay({ prompt: 'x' }, {}), /尚未配置 01ai 网关口令/);

  await assert.rejects(
    () =>
      generateViaRelay(
        { prompt: 'x' },
        {
          token: 't',
          localBaseUrl: 'off',
          fetchImpl: async () => new Response('{"error":"invalid_token"}', { status: 401 }),
        },
      ),
    (error) => error instanceof GenerationError && /口令无效或已轮换/.test(error.message),
  );
});

/* ================================================================== *
 * 本机优先的地址回退
 * ================================================================== */

const LOCAL_IMAGE = {
  id: 'local',
  url: `${RELAY_LOCAL_BASE_URL}/files/local.png`,
  mimeType: 'image/png',
  width: 1184,
  height: 864,
};

const REMOTE_IMAGE = {
  id: 'remote',
  url: 'https://api.01ai.fun/files/remote.png',
  mimeType: 'image/png',
  width: 1184,
  height: 864,
};

function ok(image) {
  return new Response(JSON.stringify(image), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function refused() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4399'), { code: 'ECONNREFUSED' }),
  });
}

/** 按地址分流的假网关：本机一个行为，域名一个行为。 */
function routedGateway({ local, remote }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      return url.startsWith(RELAY_LOCAL_BASE_URL) ? local(url) : remote(url);
    },
  };
}

test('generateViaRelay prefers the local gateway and never touches the domain', async () => {
  const gateway = routedGateway({
    local: () => ok(LOCAL_IMAGE),
    remote: () => assert.fail('本机已经成功，不该再打域名地址'),
  });
  const result = await generateViaRelay(
    { prompt: '一只柯基犬' },
    { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl },
  );

  assert.deepEqual(gateway.calls, [`${RELAY_LOCAL_BASE_URL}/v1/images`]);
  assert.equal(result.endpoint, `${RELAY_LOCAL_BASE_URL}/v1/images`);
  // origin 取自真正成功的那个地址，预览/下载链接才不会指回域名。
  assert.equal(result.images[0].url, `${RELAY_LOCAL_BASE_URL}/files/local.png`);
});

test('generateViaRelay falls back to the domain when the local port is closed', async () => {
  const gateway = routedGateway({
    local: () => {
      throw refused();
    },
    remote: () => ok(REMOTE_IMAGE),
  });
  const result = await generateViaRelay(
    { prompt: '一只柯基犬' },
    { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl },
  );

  assert.deepEqual(gateway.calls, [
    `${RELAY_LOCAL_BASE_URL}/v1/images`,
    'https://api.01ai.fun/v1/images',
  ]);
  assert.equal(result.endpoint, 'https://api.01ai.fun/v1/images');
});

test('generateViaRelay falls back when the local address has no gateway route', async () => {
  // 本机 4399 被别的服务占住时，它对未知路径的 POST 回 404 / 405。
  for (const status of [404, 405]) {
    const gateway = routedGateway({
      local: () => new Response('{"error":"不支持的请求方法"}', { status }),
      remote: () => ok(REMOTE_IMAGE),
    });
    const result = await generateViaRelay(
      { prompt: 'x' },
      { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl },
    );
    assert.equal(gateway.calls.length, 2, `HTTP ${status} 应当触发回退`);
    assert.equal(result.endpoint, 'https://api.01ai.fun/v1/images');
  }
});

test('generateViaRelay never retries after the gateway actually answered', async () => {
  // 500 说明网关收到了请求并可能已经出图计费，换地址重发就是再花一次钱。
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    const gateway = routedGateway({
      local: () => new Response('{"error":"upstream"}', { status }),
      remote: () => assert.fail(`HTTP ${status} 不该回退到域名地址`),
    });
    await assert.rejects(
      () => generateViaRelay({ prompt: 'x' }, { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl }),
      (error) => error instanceof GenerationError,
    );
    assert.equal(gateway.calls.length, 1, `HTTP ${status} 只该打一次`);
  }
});

test('generateViaRelay does not retry a timeout on the local address', async () => {
  const gateway = routedGateway({
    local: () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    },
    remote: () => assert.fail('超时不能换地址重发'),
  });
  await assert.rejects(
    () => generateViaRelay({ prompt: 'x' }, { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl }),
    (error) => error instanceof GenerationError && error.status === 504,
  );
  assert.equal(gateway.calls.length, 1);
});

test('generateViaRelay reports every address it tried when all of them fail', async () => {
  const gateway = routedGateway({
    local: () => {
      throw refused();
    },
    remote: () => {
      throw refused();
    },
  });
  await assert.rejects(
    () => generateViaRelay({ prompt: 'x' }, { token: 't', baseUrl: 'https://api.01ai.fun', fetchImpl: gateway.fetchImpl }),
    (error) =>
      error instanceof GenerationError &&
      /已依次尝试/.test(error.message) &&
      error.message.includes(RELAY_LOCAL_BASE_URL) &&
      error.message.includes('api.01ai.fun'),
  );
  assert.equal(gateway.calls.length, 2);
});

test('generateViaRelay honours localBaseUrl=off', async () => {
  const gateway = routedGateway({
    local: () => assert.fail('本机优先已关闭，不该打本机地址'),
    remote: () => ok(REMOTE_IMAGE),
  });
  const result = await generateViaRelay(
    { prompt: 'x' },
    { token: 't', baseUrl: 'https://api.01ai.fun', localBaseUrl: 'off', fetchImpl: gateway.fetchImpl },
  );
  assert.deepEqual(gateway.calls, ['https://api.01ai.fun/v1/images']);
  assert.equal(result.endpoint, 'https://api.01ai.fun/v1/images');
});

/* ================================================================== *
 * 服务端分发
 * ================================================================== */

async function bootRelay(t, { generateRelay } = {}) {
  const savedEnv = {
    ARK_API_KEY: process.env.ARK_API_KEY,
    IMAGE_RELAY_TOKEN: process.env.IMAGE_RELAY_TOKEN,
    IMAGE_RELAY_BASE: process.env.IMAGE_RELAY_BASE,
  };
  delete process.env.ARK_API_KEY;
  delete process.env.IMAGE_RELAY_TOKEN;
  delete process.env.IMAGE_RELAY_BASE;

  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-relay-'));
  const arkCalls = [];
  const relayCalls = [];
  const downloadCalls = [];
  const app = createApp({
    dataDir,
    seedDemo: false,
    downloadImage: async (url, options = {}) => {
      downloadCalls.push({ url, options });
      return {
        buffer: PNG,
        ext: '.png',
        mime: 'image/png',
        sourceUrl: url,
        finalUrl: url,
        bytes: PNG.length,
      };
    },
    generateImages: async (input, config) => {
      arkCalls.push({ input, config });
      throw new Error('方舟不该被调用');
    },
    generateRelay: async (input, config) => {
      relayCalls.push({ input, config });
      if (generateRelay) return generateRelay(input, config);
      return {
        model: RELAY_MODEL_LABEL,
        created: null,
        images: [{ url: 'https://api.01ai.fun/files/abc.png', b64: '', size: '1344x768', expiresAt: null }],
        usage: null,
        request: {
          mode: 'text2image',
          model: RELAY_MODEL_LABEL,
          size: '16:9',
          group: false,
          maxImages: 1,
          referenceCount: 0,
        },
        generatedAt: '2026-10-28T00:00:00.000Z',
        endpoint: 'https://api.01ai.fun/v1/images',
      };
    },
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.flush();
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const client = makeClient(base);
  const setup = await client.request('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(setup.status, 200);
  return { app, base, client, arkCalls, relayCalls, downloadCalls };
}

function makeClient(base) {
  let cookie = '';
  return {
    async request(pathname, { method = 'GET', body } = {}) {
      const init = { method, headers: {}, redirect: 'manual' };
      if (cookie) init.headers.cookie = cookie;
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${base}${pathname}`, init);
      for (const entry of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
        cookie = entry.split(';')[0];
      }
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, payload };
    },
  };
}

test('switching provider is persisted and reported by the config route', async (t) => {
  const { client } = await bootRelay(t);

  const initial = await client.request('/api/generate/config');
  assert.equal(initial.payload.provider, 'ark');
  assert.equal(initial.payload.relay.configured, false);

  const switched = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { provider: 'relay', relayToken: 'relay-token' },
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.payload.provider, 'relay');
  assert.equal(switched.payload.relay.configured, true);
  assert.equal(switched.payload.relay.tokenHint.includes('relay-token'), false, '口令不能回传原文');

  const bad = await client.request('/api/generate/config', { method: 'PUT', body: { provider: 'nope' } });
  assert.equal(bad.status, 400);
});

test('a relay generation goes to the relay client, never to Ark', async (t) => {
  const { client, arkCalls, relayCalls } = await bootRelay(t);
  await client.request('/api/generate/config', { method: 'PUT', body: { provider: 'relay', relayToken: 't' } });

  const response = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '一只柯基犬', aspect: '16:9', model: 'should-be-ignored' },
  });

  assert.equal(response.status, 200);
  assert.equal(relayCalls.length, 1);
  assert.equal(arkCalls.length, 0);
  assert.equal(relayCalls[0].config.token, 't');
  assert.equal(response.payload.model, RELAY_MODEL_LABEL);
  assert.equal(response.payload.images[0].size, '1344x768');
  assert.match(response.payload.images[0].previewUrl, /^\/api\/generate\/preview\//);
});

test('a loopback image URL from the gateway is fetched through its own origin', async (t) => {
  // 复现「网关生图成功，但预览 502 / 导入 400」：网关把 `127.0.0.1:4402`
  // 这种「它自己那台机器」的地址原样返回，端口又不在白名单里。修复前预览
  // 会在发请求之前就被拒掉（1ms 的 502）。
  const { client, downloadCalls } = await bootRelay(t, {
    generateRelay: async () => ({
      model: RELAY_MODEL_LABEL,
      created: null,
      images: [{ url: 'http://127.0.0.1:4402/files/abc.png', b64: '', size: '1024x1024', expiresAt: null }],
      usage: null,
      origin: 'http://127.0.0.1:4402',
      request: {
        mode: 'text2image',
        model: RELAY_MODEL_LABEL,
        size: '1:1',
        group: false,
        maxImages: 1,
        referenceCount: 0,
      },
      generatedAt: '2026-10-30T00:00:00.000Z',
      endpoint: 'http://127.0.0.1:4402/v1/images',
    }),
  });
  await client.request('/api/generate/config', {
    method: 'PUT',
    body: { provider: 'relay', relayToken: 't' },
  });

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '一只柯基犬', aspect: '1:1' },
  });
  assert.equal(generated.status, 200);
  const image = generated.payload.images[0];
  assert.equal(image.url, 'http://127.0.0.1:4402/files/abc.png');

  downloadCalls.length = 0;
  const preview = await client.request(image.previewUrl);
  assert.equal(preview.status, 200, '预览要能取到图，而不是 502');
  assert.equal(downloadCalls.length, 1);
  assert.deepEqual(
    downloadCalls[0].options.trustedOrigins,
    ['http://127.0.0.1:4402'],
    '下载时必须把「回了话的那个源站」放进白名单',
  );

  // 导入走「生成记录」：原图地址留在服务端，不必经浏览器回传（回传会被
  // /api/images 的 SSRF 规则拒掉，那正是 400 的来源）。
  const imported = await client.request(`/api/generations/${image.recordId}/import`, {
    method: 'POST',
    body: { tags: 'repro' },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.image.prompt, '一只柯基犬');
});

test('没有 sourceOrigin 的老记录，用配置里的网关源站兜底', async (t) => {
  // `sourceOrigin` 是随「网关回传本机地址」那次修复才写进索引的。之前登记的记录没有
  // 这个字段，取原图时 `127.0.0.1:4399` 会被当成攻击拒掉（端口不在白名单）——生成
  // 成功、图也在，就是导不进来。配置里声明的网关源站是运维自己写的，可以据此放行。
  const { client, downloadCalls } = await bootRelay(t, {
    generateRelay: async () => ({
      model: RELAY_MODEL_LABEL,
      created: null,
      images: [
        { url: 'http://127.0.0.1:4399/files/old.png', b64: '', size: '1024x1024', expiresAt: null },
      ],
      usage: null,
      request: {
        mode: 'text2image',
        model: RELAY_MODEL_LABEL,
        size: '1:1',
        group: false,
        maxImages: 1,
        referenceCount: 0,
      },
      generatedAt: '2026-10-30T00:00:00.000Z',
      // 故意不返回 origin：这就是修复前登记下来的记录长什么样。
    }),
  });
  await client.request('/api/generate/config', {
    method: 'PUT',
    body: { provider: 'relay', relayToken: 't' },
  });

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '老记录', aspect: '1:1' },
  });
  assert.equal(generated.status, 200);
  const image = generated.payload.images[0];
  assert.equal(image.url, 'http://127.0.0.1:4399/files/old.png');

  // 不碰预览：预览会把字节留在缓存里，那样就测不到回源这条路了。
  downloadCalls.length = 0;
  const imported = await client.request(`/api/generations/${image.recordId}/import`, {
    method: 'POST',
    body: {},
  });
  assert.equal(imported.status, 201, '配置里的网关源站应当被放行');
  assert.equal(downloadCalls.length, 1);
  assert.ok(
    downloadCalls[0].options.trustedOrigins.includes('http://127.0.0.1:4399'),
    '配置里的本机网关源站要在白名单里',
  );
});

test('relay mode refuses group mode and more than one reference image', async (t) => {
  const { client, relayCalls } = await bootRelay(t);
  await client.request('/api/generate/config', { method: 'PUT', body: { provider: 'relay', relayToken: 't' } });

  const group = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2group', prompt: 'x' },
  });
  assert.equal(group.status, 400);
  assert.match(group.payload.error, /不支持组图/);

  const noRef = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'image2image', prompt: 'x' },
  });
  assert.equal(noRef.status, 400);
  assert.match(noRef.payload.error, /至少需要一张参考图片/);

  const twoRefs = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'image2image', prompt: 'x', referenceImages: [PNG_DATA_URL, PNG_DATA_URL] },
  });
  assert.equal(twoRefs.status, 400);
  assert.match(twoRefs.payload.error, /只能带 1 张参考图/);

  assert.equal(relayCalls.length, 0, '被拒的请求不能真的发出去');
});

test('relay mode without a token refuses to generate', async (t) => {
  const { client, relayCalls } = await bootRelay(t);
  await client.request('/api/generate/config', { method: 'PUT', body: { provider: 'relay' } });

  const response = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: 'x' },
  });
  assert.equal(response.status, 503);
  assert.match(response.payload.error, /网关口令/);
  assert.equal(relayCalls.length, 0);
});

test('IMAGE_RELAY_TOKEN env var locks the token field', async (t) => {
  const { client } = await bootRelay(t);
  process.env.IMAGE_RELAY_TOKEN = 'env-token';
  t.after(() => {
    delete process.env.IMAGE_RELAY_TOKEN;
  });

  const config = await client.request('/api/generate/config');
  assert.equal(config.payload.relay.configured, true);
  assert.equal(config.payload.relay.envLocked, true);

  const rejected = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { relayToken: 'from-ui' },
  });
  assert.equal(rejected.status, 409);
});
