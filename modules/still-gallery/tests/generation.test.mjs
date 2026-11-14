import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import {
  ARK_DEFAULT_BASE_URL,
  ARK_DEFAULT_MODEL,
  ARK_MODEL_SUGGESTIONS,
  GenerationError,
  apiKeyHint,
  buildGenerationPayload,
  describeUpstreamFailure,
  extractUrlExpiry,
  maxGroupImagesFor,
  modelCapabilities,
  modelCatalog,
  normalizeBaseUrl,
  normalizeMode,
  normalizeReferenceImage,
  normalizeSize,
  parseGenerationResponse,
  resolveGenerationEndpoint,
  sizeSuggestionsFor,
} from '../lib/image-gen.mjs';

const SEEDREAM_40 = 'doubao-seedream-4-0-20260415';
const SEEDREAM_45 = 'doubao-seedream-4-5';
const SEEDREAM_50_LITE = 'doubao-seedream-5-0-lite';
const SEEDREAM_50_PRO = 'doubao-seedream-5-0-pro';
/** Same family as SEEDREAM_50_PRO, but the dated id Ark actually serves. */
const SEEDREAM_50_PRO_DATED = 'doubao-seedream-5-0-pro-260628';
/** 5.0 flash：与 pro 同档但更快更便宜，唯一区别是不支持 fast 提示词优化。 */
const SEEDREAM_50_FLASH = 'doubao-seedream-5-0-flash-260915';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 7),
]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const PASSWORD = 'correct-horse-battery';

/** The shape the real client returns, so the route can be exercised offline. */
function fakeGeneration(overrides = {}) {
  return {
    model: ARK_DEFAULT_MODEL,
    created: 1782203831,
    images: [
      { url: 'https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com/a.png?X-Tos-Expires=1782290231', b64: '', size: '2048x2048', expiresAt: '2026-09-24T03:17:11.000Z' },
    ],
    usage: { generated_images: 1 },
    request: {
      mode: 'text2image',
      model: ARK_DEFAULT_MODEL,
      size: '2K',
      optimizeMode: 'standard',
      group: false,
      watermark: false,
      referenceCount: 0,
      referenceKind: 'none',
      maxImages: 1,
    },
    generatedAt: '2026-09-17T12:00:00.000Z',
    endpoint: `${ARK_DEFAULT_BASE_URL}/images/generations`,
    ...overrides,
  };
}

async function boot(t, { generateImages, env } = {}) {
  const savedEnv = process.env.ARK_API_KEY;
  if (env === undefined) delete process.env.ARK_API_KEY;
  else process.env.ARK_API_KEY = env;

  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-gen-'));
  const calls = [];
  const downloads = [];
  const app = createApp({
    dataDir,
    seedDemo: false,
    downloadImage: async (url) => {
      downloads.push(url);
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
      calls.push({ input, config });
      if (generateImages) return generateImages(input, config, calls.length);
      return fakeGeneration();
    },
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    // Every generation route records a timing sample, and metrics are persisted
    // fire-and-forget — so a write can still be in flight here. Without this
    // drain, `rm` deletes the directory first and the pending rename fails with
    // ENOENT, spraying a scary "指标写入失败" over an otherwise green run.
    // Retries are the belt to flush()'s braces.
    await app.flush();
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (savedEnv === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = savedEnv;
  });
  return { app, base, dataDir, calls, downloads };
}

function makeClient(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(pathname, { method = 'GET', body, headers = {} } = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      if (cookie) init.headers.cookie = cookie;
      if (body !== undefined) {
        if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const response = await fetch(`${base}${pathname}`, init);
      for (const entry of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
        cookie = entry.split(';')[0];
      }
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, payload, headers: response.headers };
    },
  };
}

async function signIn(base) {
  const client = makeClient(base);
  const setup = await client.request('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(setup.status, 200);
  return client;
}

/* ================================================================== *
 * payload construction
 * ================================================================== */

test('text2image sends one image request and never mentions group mode', () => {
  const { payload, meta } = buildGenerationPayload({
    mode: 'text2image',
    prompt: '一只橘猫在阳光下打哈欠',
    model: ARK_DEFAULT_MODEL,
    size: '2K',
    optimizeMode: 'standard',
  });

  assert.deepEqual(payload, {
    model: ARK_DEFAULT_MODEL,
    prompt: '一只橘猫在阳光下打哈欠',
    response_format: 'url',
    watermark: false,
    size: '2K',
    optimize_prompt_options: { mode: 'standard' },
  });
  assert.equal('sequential_image_generation' in payload, false, 'disabled is the upstream default; omitting keeps Seedream 5.0 pro callable');
  assert.equal('image' in payload, false);
  assert.equal(meta.maxImages, 1);
  assert.equal(meta.referenceKind, 'none');
});

test('text2group enables sequential generation with a default of four images', () => {
  const { payload, meta } = buildGenerationPayload({
    mode: 'text2group',
    prompt: '一只小橘猫的一天',
    model: ARK_DEFAULT_MODEL,
  });
  assert.equal(payload.sequential_image_generation, 'auto');
  assert.deepEqual(payload.sequential_image_generation_options, { max_images: 4 });
  assert.equal(meta.group, true);
  assert.equal(meta.maxImages, 4);
});

test('image2image sends a single reference as a string and several as an array', () => {
  const one = buildGenerationPayload({
    mode: 'image2image',
    prompt: '把主体换成一只狗',
    referenceImages: ['https://example.com/a.png'],
  });
  assert.equal(one.payload.image, 'https://example.com/a.png');
  assert.equal(one.meta.referenceCount, 1);
  assert.equal(one.meta.referenceKind, 'url');

  const many = buildGenerationPayload({
    mode: 'image2image',
    prompt: '融合这两张图的风格',
    referenceImages: ['https://example.com/a.png', 'https://example.com/b.png'],
  });
  assert.deepEqual(many.payload.image, ['https://example.com/a.png', 'https://example.com/b.png']);
  assert.equal(many.meta.referenceCount, 2);

  const mixed = buildGenerationPayload({
    mode: 'image2image',
    prompt: '参考本机图片改写',
    referenceImages: [PNG_DATA_URL],
  });
  assert.equal(mixed.meta.referenceKind, 'base64');
});

test('image2image refuses to run without a reference image', () => {
  assert.throws(
    () => buildGenerationPayload({ mode: 'image2image', prompt: 'x', referenceImages: [] }),
    (error) => error instanceof GenerationError && error.status === 400 && /至少需要一张参考图片/.test(error.message),
  );
});

/* ================================================================== *
 * per-model capabilities (from the 模型能力 section of the official doc)
 * ================================================================== */

test('each Seedream family reports its own limits', () => {
  const pro = modelCapabilities(SEEDREAM_50_PRO);
  assert.equal(pro.maxReferences, 10, 'Seedream 5.0 pro 多图生图 allows 2-10 references');
  assert.equal(pro.supportsGroup, false, 'Seedream 5.0 pro 暂不支持组图生成');
  assert.equal(pro.supportsWebSearch, false);
  assert.equal(pro.supportsLayerDecomposition, true);

  for (const id of [SEEDREAM_40, SEEDREAM_45, SEEDREAM_50_LITE]) {
    const caps = modelCapabilities(id);
    assert.equal(caps.maxReferences, 14, `${id} allows 2-14 references`);
    assert.equal(caps.supportsGroup, true, `${id} supports groups`);
  }
  assert.equal(modelCapabilities(SEEDREAM_50_LITE).supportsWebSearch, true, 'only 5.0 lite supports web search');
  assert.equal(modelCapabilities(SEEDREAM_40).supportsWebSearch, false);

  // Dated ids still resolve to their family, and an unknown model is not blocked.
  assert.equal(modelCapabilities('doubao-seedream-5-0-pro-20260201').maxReferences, 10);
  assert.equal(modelCapabilities('doubao-seedream-4-0-20260415').supportsGroup, true);
  assert.equal(modelCapabilities('some-custom-gateway-model').maxReferences, 14);

  const catalog = modelCatalog();
  // 4.0 / 4.5 / 5.0 lite / 5.0 flash / 5.0 pro / 5.0 pro（260628）
  assert.equal(catalog.length, 6);
  assert.equal(catalog.find((entry) => entry.id === SEEDREAM_50_PRO).supportsGroup, false);
  assert.equal(catalog.find((entry) => entry.id === SEEDREAM_50_PRO).maxReferences, 10);
  assert.ok(catalog.every((entry) => typeof entry.note === 'string' && entry.note.length > 0));
});

test('the dated 5.0 pro id is catalogued and inherits the pro family limits', () => {
  assert.ok(ARK_MODEL_SUGGESTIONS.includes(SEEDREAM_50_PRO_DATED), 'the dated id must be offered');

  const dated = modelCapabilities(SEEDREAM_50_PRO_DATED);
  const plain = modelCapabilities(SEEDREAM_50_PRO);
  assert.deepEqual(dated, plain, 'both 5.0 pro ids must resolve to identical limits');
  assert.equal(dated.maxReferences, 10);
  assert.equal(dated.supportsGroup, false);
  assert.equal(dated.supportsWebSearch, false);

  const entry = modelCatalog().find((item) => item.id === SEEDREAM_50_PRO_DATED);
  assert.ok(entry, 'the dated id must appear in the catalogue');
  assert.equal(entry.maxReferences, 10);
  assert.equal(entry.supportsGroup, false);
  assert.ok(entry.note.length > 0);
});

test('Seedream 5.0 flash mirrors pro except for the fast prompt mode', () => {
  const pro = modelCapabilities(SEEDREAM_50_PRO);
  const flash = modelCapabilities(SEEDREAM_50_FLASH);

  for (const key of ['maxReferences', 'supportsGroup', 'supportsWebSearch', 'supportsLayerDecomposition',
    'supportsTransparentBackground', 'supportsInteractiveEdit']) {
    assert.deepEqual(flash[key], pro[key], `flash 与 pro 的 ${key} 应当一致`);
  }
  assert.deepEqual(flash.sizePresets, pro.sizePresets);
  assert.deepEqual(flash.sizePixels, pro.sizePixels);

  // 手册 1 节：fast 仅 pro；flash 本身就是快的那一档。
  assert.equal(pro.supportsFastMode, true);
  assert.equal(flash.supportsFastMode, false);
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_50_FLASH, optimizeMode: 'fast' }),
    /不支持 fast/,
  );
  // standard 仍然可以。
  assert.equal(
    buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_50_FLASH, optimizeMode: 'standard' })
      .payload.optimize_prompt_options.mode,
    'standard',
  );
  // lite 与 4.5 同样不支持 fast。
  for (const model of [SEEDREAM_50_LITE, SEEDREAM_45]) {
    assert.throws(
      () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model, optimizeMode: 'fast' }),
      /不支持 fast/,
      `${model} 不该接受 fast`,
    );
  }
});

test('Seedream 5.0 pro is held to ten references and no group mode', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`);
  const eleven = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}.png`);

  // Ten references in single-image mode is the documented maximum.
  const ok = buildGenerationPayload({
    mode: 'image2image',
    prompt: '融合这十张图',
    model: SEEDREAM_50_PRO,
    referenceImages: ten,
  });
  assert.equal(ok.meta.referenceCount, 10);
  assert.equal('sequential_image_generation' in ok.payload, false, '5.0 pro rejects the parameter outright');

  assert.throws(
    () =>
      buildGenerationPayload({
        mode: 'image2image',
        prompt: 'x',
        model: SEEDREAM_50_PRO,
        referenceImages: eleven,
      }),
    /参考图片最多 10 张/,
  );

  assert.throws(
    () => buildGenerationPayload({ mode: 'text2group', prompt: 'x', model: SEEDREAM_50_PRO }),
    /不支持组图生成/,
  );
  assert.throws(
    () =>
      buildGenerationPayload({
        mode: 'image2image',
        prompt: 'x',
        model: SEEDREAM_50_PRO,
        group: true,
        referenceImages: ['https://example.com/a.png'],
      }),
    /不支持组图生成/,
  );

  // The same eleven references are fine on a family that allows fourteen.
  assert.equal(
    buildGenerationPayload({
      mode: 'image2image',
      prompt: 'x',
      model: SEEDREAM_40,
      referenceImages: eleven,
    }).meta.referenceCount,
    11,
  );
});

test('web search is gated to the model that supports it', () => {
  const lite = buildGenerationPayload({
    mode: 'text2image',
    prompt: '今日北京天气海报',
    model: SEEDREAM_50_LITE,
    webSearch: true,
  });
  assert.deepEqual(lite.payload.tools, [{ type: 'web_search' }]);
  assert.equal(lite.meta.webSearch, true);

  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_40, webSearch: true }),
    /不支持联网搜索/,
  );

  // Not requested means not sent.
  assert.equal(
    'tools' in buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_50_LITE }).payload,
    false,
  );
});

test('output format and transparency are sent only when asked for', () => {
  const plain = buildGenerationPayload({ mode: 'text2image', prompt: 'x' });
  assert.equal('output_format' in plain.payload, false, 'jpeg is the upstream default, so omit it');
  assert.equal('background' in plain.payload, false, 'opaque is the upstream default, so omit it');

  const png = buildGenerationPayload({ mode: 'text2image', prompt: 'x', outputFormat: 'PNG' });
  assert.equal(png.payload.output_format, 'png');
  assert.equal(png.meta.outputFormat, 'png');

  // 手册 4.5：透明背景只支持「图生图 + 1 张带透明通道的参考图」。
  const transparent = buildGenerationPayload({
    mode: 'image2image',
    prompt: '贴纸',
    model: SEEDREAM_50_PRO,
    referenceImages: ['https://example.com/sticker.png'],
    outputFormat: 'webp',
    background: 'transparent',
  });
  assert.equal(transparent.payload.background, 'transparent');
  assert.equal(transparent.payload.output_format, 'webp');

  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', outputFormat: 'tiff' }),
    /输出格式只能是/,
  );
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', background: 'black' }),
    /透明通道只能是/,
  );
  assert.throws(
    () =>
      buildGenerationPayload({
        mode: 'image2image',
        prompt: 'x',
        model: SEEDREAM_50_PRO,
        referenceImages: ['https://example.com/a.png'],
        outputFormat: 'jpeg',
        background: 'transparent',
      }),
    /透明背景需要 png 或 webp/,
  );
  // 文生图没有输入图，透明背景无从谈起。
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_50_PRO, background: 'transparent' }),
    /透明背景只支持图生图/,
  );
  // 5.0 lite 不支持透明通道。
  assert.throws(
    () =>
      buildGenerationPayload({
        mode: 'image2image',
        prompt: 'x',
        model: SEEDREAM_50_LITE,
        referenceImages: ['https://example.com/a.png'],
        background: 'transparent',
      }),
    /不支持透明背景/,
  );
});

test('reference images plus generated images never exceed fifteen', () => {  assert.equal(maxGroupImagesFor(0), 15);
  assert.equal(maxGroupImagesFor(1), 14);
  assert.equal(maxGroupImagesFor(3), 12);

  // 0 refs: the full fifteen are available.
  assert.equal(
    buildGenerationPayload({ mode: 'text2group', prompt: 'x', maxImages: 15 }).payload
      .sequential_image_generation_options.max_images,
    15,
  );
  // 1 ref: at most fourteen more.
  assert.equal(
    buildGenerationPayload({
      mode: 'image2image',
      prompt: 'x',
      group: true,
      maxImages: 14,
      referenceImages: ['https://example.com/a.png'],
    }).payload.sequential_image_generation_options.max_images,
    14,
  );
  assert.throws(
    () =>
      buildGenerationPayload({
        mode: 'image2image',
        prompt: 'x',
        group: true,
        maxImages: 15,
        referenceImages: ['https://example.com/a.png'],
      }),
    /最多只能再生成 14 张/,
  );
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2group', prompt: 'x', maxImages: 16 }),
    /最多为 15/,
  );
  assert.throws(() => buildGenerationPayload({ mode: 'text2group', prompt: 'x', maxImages: 0 }), /至少为 1/);
  assert.throws(() => buildGenerationPayload({ mode: 'text2group', prompt: 'x', maxImages: 2.5 }), /必须是整数/);
});

test('reference images are limited to fourteen and validated one by one', () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}.png`);
  assert.throws(
    () => buildGenerationPayload({ mode: 'image2image', prompt: 'x', referenceImages: fifteen }),
    /最多 14 张/,
  );

  assert.equal(normalizeReferenceImage('https://example.com/a.png'), 'https://example.com/a.png');
  assert.equal(normalizeReferenceImage(PNG_DATA_URL), PNG_DATA_URL);

  const rejections = [
    ['file:///etc/passwd', /必须使用 http 或 https/],
    ['javascript:alert(1)', /必须使用 http 或 https/],
    ['blob:https://example.com/abc', /必须使用 http 或 https/],
    ['https://user:pass@example.com/a.png', /不允许携带用户名或密码/],
    ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', /不受支持/],
    ['data:image/png;base64,not base64!!', /base64 内容不合法/],
    ['data:image/png;base64,', /内容为空/],
    ['not a url at all', /既不是合法的 URL/],
    ['', /不能为空/],
  ];
  for (const [value, pattern] of rejections) {
    assert.throws(() => normalizeReferenceImage(value), pattern, `expected ${value} to be rejected`);
  }

  const oversized = `data:image/png;base64,${Buffer.alloc(11 * 1024 * 1024).toString('base64')}`;
  assert.throws(() => normalizeReferenceImage(oversized), /超过 10MB 上限/);
});

test('modes, sizes and models are normalised and bounded', () => {
  assert.equal(normalizeMode(undefined), 'text2image');
  assert.equal(normalizeMode('文生组图'), 'text2group');
  assert.equal(normalizeMode('i2i'), 'image2image');
  assert.throws(() => normalizeMode('画画'), /生成模式不正确/);

  assert.equal(normalizeSize('2k'), '2K');
  assert.equal(normalizeSize('2048x2048'), '2048x2048');
  assert.equal(normalizeSize(''), '');
  assert.throws(() => normalizeSize('2:1'), /尺寸格式不正确/);
  assert.throws(() => normalizeSize('256x256'), /不能小于 512/);
  assert.throws(() => normalizeSize('8192x8192'), /不能大于 4096/);

  assert.throws(() => buildGenerationPayload({ mode: 'text2image', prompt: '  ' }), /提示词不能为空/);
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: 'bad model!' }),
    /含有不被允许的字符/,
  );
  // An omitted or blank model silently falls back to the default rather than
  // failing, so clearing the field in the UI is not a hard error.
  assert.equal(buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: '' }).payload.model, ARK_DEFAULT_MODEL);
  assert.equal(buildGenerationPayload({ mode: 'text2image', prompt: 'x' }).payload.model, ARK_DEFAULT_MODEL);
  assert.throws(() => buildGenerationPayload({ mode: 'text2image', prompt: 'x', optimizeMode: 'turbo' }), /standard 或 fast/);
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x'.repeat(8001) }),
    /不能超过 8000/,
  );
});

/* ------------------------------------------------------------------ *
 * `size` is per family
 *
 * Regression: `4K` used to be offered to every model, and Seedream 5.0 pro
 * answers it with `InvalidParameter … The parameter `size` specified in the
 * request are not valid`. The preset ladder genuinely differs by family, so the
 * check has to be model-aware.
 * ------------------------------------------------------------------ */

test('4K is rejected by Seedream 5.0 pro and accepted by the families that support it', () => {
  const pro = modelCapabilities(SEEDREAM_50_PRO_DATED);
  assert.throws(() => normalizeSize('4K', pro), /不支持 4K/);

  // The message has to name the way out, not just the failure.
  assert.throws(() => normalizeSize('4K', pro), /1K \/ 1\.5K \/ 2K/);

  for (const model of [SEEDREAM_40, SEEDREAM_45, SEEDREAM_50_LITE]) {
    assert.equal(normalizeSize('4K', modelCapabilities(model)), '4K', `${model} should accept 4K`);
  }
  // The preset is matched case-insensitively, so lowercase is refused too.
  assert.throws(() => normalizeSize('4k', pro), /不支持 4K/);
});

test('each family accepts only its documented preset ladder', () => {
  const allowed = {
    [SEEDREAM_40]: ['1K', '2K', '4K'],
    [SEEDREAM_45]: ['2K', '4K'],
    [SEEDREAM_50_LITE]: ['2K', '3K', '4K'],
    // 手册 3.1：pro / flash 默认 2K，可选 1K / 1.5K / 2K。
    [SEEDREAM_50_PRO]: ['1K', '1.5K', '2K'],
    [SEEDREAM_50_PRO_DATED]: ['1K', '1.5K', '2K'],
    [SEEDREAM_50_FLASH]: ['1K', '1.5K', '2K'],
  };
  const every = ['1K', '1.5K', '2K', '3K', '4K'];
  for (const [model, ok] of Object.entries(allowed)) {
    const caps = modelCapabilities(model);
    for (const preset of every) {
      if (ok.includes(preset)) assert.equal(normalizeSize(preset, caps), preset, `${model} ${preset}`);
      else assert.throws(() => normalizeSize(preset, caps), /不支持/, `${model} must refuse ${preset}`);
    }
  }
});

test('Seedream 5.0 pro enforces its total-pixel window on explicit sizes', () => {
  const pro = modelCapabilities(SEEDREAM_50_PRO_DATED);
  // Documented window is 1280x720 (921600) … 2048x2048 (4194304).
  assert.equal(normalizeSize('1280x720', pro), '1280x720', 'lower bound is inclusive');
  assert.equal(normalizeSize('2048x2048', pro), '2048x2048', 'upper bound is inclusive');
  assert.equal(normalizeSize('1024x1024', pro), '1024x1024');

  assert.throws(() => normalizeSize('512x512', pro), /总像素/);
  assert.throws(() => normalizeSize('3000x3000', pro), /总像素/);
  assert.throws(() => normalizeSize('4096x4096', pro), /总像素/);

  // Other families are deliberately left alone here — no pixel window is
  // documented for them, and inventing one would block sizes that work.
  const four = modelCapabilities(SEEDREAM_40);
  assert.equal(normalizeSize('4096x4096', four), '4096x4096');
});

test('an aspect ratio outside 1:16–16 is refused', () => {
  const pro = modelCapabilities(SEEDREAM_50_PRO_DATED);
  assert.throws(() => normalizeSize('1024x16384', pro), /不能大于 4096|宽高比/);
  assert.throws(() => normalizeSize('2048x128', pro), /不能小于 512|宽高比/);
});

test('size suggestions never contain a value the model rejects', () => {
  // The invariant that makes the UI safe: every advertised option must survive
  // validation for that same model. If these ever diverge, the console offers a
  // size that the server will refuse.
  for (const model of ARK_MODEL_SUGGESTIONS) {
    const caps = modelCapabilities(model);
    const suggestions = sizeSuggestionsFor(model);
    assert.ok(suggestions.length > 0, `${model} must suggest something`);
    for (const value of suggestions) {
      assert.doesNotThrow(() => normalizeSize(value, caps), `${model} offers unusable size ${value}`);
    }
  }
  assert.ok(!sizeSuggestionsFor(SEEDREAM_50_PRO_DATED).includes('4K'), 'pro must not offer 4K');
  assert.ok(sizeSuggestionsFor(SEEDREAM_40).includes('4K'), '4.0 should still offer 4K');
});

test('the payload builder refuses an unsupported size for the chosen model', () => {
  // End to end through the real entry point, not just normalizeSize.
  assert.throws(
    () => buildGenerationPayload({ mode: 'text2image', prompt: 'x', model: SEEDREAM_50_PRO_DATED, size: '4K' }),
    /不支持 4K/,
  );
  const ok = buildGenerationPayload({
    mode: 'text2image',
    prompt: 'x',
    model: SEEDREAM_50_PRO_DATED,
    size: '2K',
  });
  assert.equal(ok.payload.size, '2K');
  assert.equal(ok.meta.model, SEEDREAM_50_PRO_DATED);
});

test('a size rejection from Ark is explained in terms of the model that was called', () => {
  // The exact body Ark returns for this failure.
  const body = JSON.stringify({
    error: {
      code: 'InvalidParameter',
      message: "The parameter `size` specified in the request are not valid: must be 'WIDTHxHEIGHT' or a supported size preset.",
      param: 'size',
      type: 'BadRequest',
    },
  });
  const message = describeUpstreamFailure(400, body, {
    model: SEEDREAM_50_PRO_DATED,
    capabilities: modelCapabilities(SEEDREAM_50_PRO_DATED),
  });
  assert.match(message, /不接受这个尺寸/);
  assert.match(message, /1K \/ 1\.5K \/ 2K/);
  assert.match(message, /1024x1024/);

  // Without model context the `param: size` signal alone is still enough to be
  // specific; only the preset list is missing, so the hint goes generic.
  const bare = describeUpstreamFailure(400, body);
  assert.match(bare, /不接受这个尺寸/);
  assert.match(bare, /宽x高/);
  assert.doesNotMatch(bare, /1K \/ 2K/, 'no preset list is invented without capabilities');
  // And a non-size 400 must not be dressed up as a size problem.
  const other = JSON.stringify({ error: { code: 'InvalidParameter', param: 'prompt' } });
  assert.match(describeUpstreamFailure(400, other), /拒绝了这次请求/);
});

test('the endpoint accepts a base url or a full url, but never plain http off-host', () => {
  assert.equal(resolveGenerationEndpoint(''), `${ARK_DEFAULT_BASE_URL}/images/generations`);
  assert.equal(resolveGenerationEndpoint('https://ark.cn-beijing.volces.com/api/v3/'), `${ARK_DEFAULT_BASE_URL}/images/generations`);
  assert.equal(
    resolveGenerationEndpoint('https://api.zsdodo.com/images/generations'),
    'https://api.zsdodo.com/images/generations',
  );
  assert.equal(normalizeBaseUrl('https://api.zsdodo.com/images/generations'), 'https://api.zsdodo.com');
  assert.equal(normalizeBaseUrl(`${ARK_DEFAULT_BASE_URL}/`), ARK_DEFAULT_BASE_URL);

  assert.equal(resolveGenerationEndpoint('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/images/generations');
  assert.throws(() => resolveGenerationEndpoint('http://example.com/v1'), /必须使用 https/);
  assert.throws(() => resolveGenerationEndpoint('ftp://example.com/v1'), /必须使用 https/);
  assert.throws(() => resolveGenerationEndpoint('not-a-url'), /不是合法的 URL/);
});

/* ================================================================== *
 * response handling
 * ================================================================== */

test('TOS signed urls expose their own expiry', () => {
  // The shape Ark actually returns: a signing date plus a LIFETIME in seconds.
  // Reading 86400 as epoch seconds put the expiry in 1970, which made every
  // freshly generated image render as "链接已过期，无法再导入".
  assert.equal(
    extractUrlExpiry(
      'https://x.tos-cn-beijing.volces.com/a.png?X-Tos-Date=20260918T073432Z&X-Tos-Expires=86400&X-Tos-Signature=abc',
    ),
    '2026-09-19T07:34:32.000Z',
  );
  // Some endpoints emit an absolute epoch instead, with no signing date.
  assert.equal(
    extractUrlExpiry('https://x.tos-cn-beijing.volces.com/a.png?X-Tos-Expires=1782290231&X-Tos-Signature=abc'),
    new Date(1782290231 * 1000).toISOString(),
  );
  // A lifetime with no anchor cannot be placed on the calendar: report nothing
  // rather than inventing a date.
  assert.equal(extractUrlExpiry('https://x.tos-cn-beijing.volces.com/a.png?X-Tos-Expires=86400'), null);
  assert.equal(extractUrlExpiry('https://x.example.com/a.png'), null);
  assert.equal(extractUrlExpiry('https://x.example.com/a.png?X-Tos-Expires=nope'), null);
  assert.equal(extractUrlExpiry('not a url'), null);
});

test('a response is flattened into urls and inline payloads', () => {
  const parsed = parseGenerationResponse({
    model: ARK_DEFAULT_MODEL,
    created: 1782203831,
    data: [
      { url: 'https://x.tos.example.com/a.png?X-Tos-Expires=1782290231', size: '2048x2048' },
      { b64_json: 'AAAA', size: '1024x1024' },
      { nonsense: true },
    ],
    usage: { generated_images: 2 },
  });
  assert.equal(parsed.images.length, 2);
  assert.equal(parsed.images[0].size, '2048x2048');
  assert.equal(parsed.images[0].expiresAt, new Date(1782290231 * 1000).toISOString());
  assert.equal(parsed.images[1].b64, 'AAAA');
  assert.equal(parsed.images[1].expiresAt, null);
  assert.equal(parsed.usage.generated_images, 2);

  assert.throws(() => parseGenerationResponse({ error: { message: 'quota exceeded' } }), /quota exceeded/);
  assert.throws(() => parseGenerationResponse({ error: 'boom' }), /boom/);
  assert.throws(() => parseGenerationResponse({ data: [] }), /没有返回任何图片/);
  assert.throws(() => parseGenerationResponse(null), /无法解析/);
});

test('upstream failures are described in terms an operator can act on', () => {
  assert.match(describeUpstreamFailure(401, ''), /API Key 无效/);
  assert.match(describeUpstreamFailure(403, ''), /API Key 无效/);
  assert.match(describeUpstreamFailure(404, ''), /模型 ID 不存在/);
  assert.match(describeUpstreamFailure(429, ''), /额度不足/);
  assert.match(describeUpstreamFailure(400, '{"error":"bad size"}'), /拒绝了这次请求/);
  assert.match(describeUpstreamFailure(503, ''), /暂时不可用/);
  assert.match(describeUpstreamFailure(418, ''), /状态码 418/);
  assert.equal(describeUpstreamFailure(500, 'x'.repeat(900)).length < 400, true, 'detail is truncated');
});

test('api keys are only ever shown as a masked hint', () => {
  assert.equal(apiKeyHint(''), '');
  assert.equal(apiKeyHint('short'), 'sh…');
  assert.equal(apiKeyHint('sk-1234567890abcdef'), 'sk-12…cdef');
});

/* ================================================================== *
 * HTTP surface
 * ================================================================== */

test('generation requires a session and a same-origin request', async (t) => {
  const { base } = await boot(t, { env: 'env-key' });

  const anonymous = makeClient(base);
  const blocked = await anonymous.request('/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(blocked.status, 401);

  const configAnon = await anonymous.request('/api/generate/config');
  assert.equal(configAnon.status, 401);

  const client = await signIn(base);
  const crossOrigin = await client.request('/api/generate', {
    method: 'POST',
    body: { prompt: 'x' },
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 403);

  const crossSite = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { baseUrl: 'https://evil.example.com' },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('generation is refused until a key is configured', async (t) => {
  const { base, calls } = await boot(t);
  const client = await signIn(base);

  const config = await client.request('/api/generate/config');
  assert.equal(config.status, 200);
  assert.equal(config.payload.configured, false);
  assert.equal(config.payload.source, null);
  assert.equal(config.payload.envLocked, false);
  assert.equal(config.payload.baseUrl, ARK_DEFAULT_BASE_URL);
  assert.equal(config.payload.defaultModel, ARK_DEFAULT_MODEL);
  assert.ok(config.payload.modelSuggestions.includes(ARK_DEFAULT_MODEL));
  assert.equal(config.payload.modelCatalog.length, 6);
  assert.equal(config.payload.modelCatalog.find((m) => m.id === SEEDREAM_50_PRO).supportsGroup, false);
  assert.ok(config.payload.modelCatalog.some((m) => m.id === SEEDREAM_50_PRO_DATED));
  assert.ok(config.payload.modelCatalog.some((m) => m.id === SEEDREAM_50_FLASH));
  // 能力开关必须一路透到前端，否则置灰逻辑只能靠猜。
  const flash = config.payload.modelCatalog.find((m) => m.id === SEEDREAM_50_FLASH);
  assert.equal(flash.supportsFastMode, false);
  assert.equal(flash.supportsTransparentBackground, true);
  assert.deepEqual(config.payload.outputFormats, ['jpeg', 'png', 'webp']);
  assert.deepEqual(config.payload.backgrounds, ['opaque', 'transparent']);

  const refused = await client.request('/api/generate', { method: 'POST', body: { prompt: '一只猫' } });
  assert.equal(refused.status, 503);
  assert.match(refused.payload.error, /尚未配置/);
  assert.equal(calls.length, 0, 'nothing should reach the upstream client');
});

test('a stored key is used, masked on read, and written to a 600-mode file', async (t) => {
  const { base, dataDir, calls } = await boot(t);
  const client = await signIn(base);

  const saved = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { apiKey: 'sk-abcdefghijklmnop', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: ARK_DEFAULT_MODEL },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.configured, true);
  assert.equal(saved.payload.source, 'file');
  assert.equal(saved.payload.apiKeyHint, 'sk-ab…mnop');

  const raw = await fsp.readFile(path.join(dataDir, 'settings.json'), 'utf8');
  assert.match(raw, /sk-abcdefghijklmnop/, 'the key is persisted for later runs');
  assert.equal(JSON.stringify(saved.payload).includes('sk-abcdefghijklmnop'), false, 'the response never echoes the key');
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(path.join(dataDir, 'settings.json'))).mode & 0o777, 0o600);
  }

  // A fresh app on the same data directory picks the key back up.
  const reopened = createApp({ dataDir, seedDemo: false });
  await reopened.init();
  assert.equal((await reopened.close(), true), true);

  const generated = await client.request('/api/generate', { method: 'POST', body: { prompt: '一只橘猫' } });
  assert.equal(generated.status, 200);
  assert.equal(generated.payload.images.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.apiKey, 'sk-abcdefghijklmnop');
  assert.equal(calls[0].config.baseUrl, ARK_DEFAULT_BASE_URL);

  const cleared = await client.request('/api/generate/config', { method: 'PUT', body: { clearApiKey: true } });
  assert.equal(cleared.payload.configured, false);
  const afterClear = await client.request('/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(afterClear.status, 503);
});

test('an ARK_API_KEY environment variable wins and locks the field', async (t) => {
  const { base, dataDir } = await boot(t, { env: 'sk-env-value-123456' });
  const client = await signIn(base);

  const config = await client.request('/api/generate/config');
  assert.equal(config.payload.configured, true);
  assert.equal(config.payload.source, 'env');
  assert.equal(config.payload.envLocked, true);
  assert.equal(JSON.stringify(config.payload).includes('sk-env-value-123456'), false);

  const refused = await client.request('/api/generate/config', { method: 'PUT', body: { apiKey: 'sk-something-else' } });
  assert.equal(refused.status, 409);
  assert.match(refused.payload.error, /环境变量/);

  const refusedClear = await client.request('/api/generate/config', { method: 'PUT', body: { clearApiKey: true } });
  assert.equal(refusedClear.status, 409);

  const generated = await client.request('/api/generate', { method: 'POST', body: { prompt: '一只猫' } });
  assert.equal(generated.status, 200);

  // Nothing was written, because the environment supplied the credential.
  await assert.rejects(fsp.access(path.join(dataDir, 'settings.json')));
});

test('bad settings are rejected before they are stored', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const badBase = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { baseUrl: 'http://example.com/v1' },
  });
  assert.equal(badBase.status, 400);
  assert.match(badBase.payload.error, /必须使用 https/);

  const badModel = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { defaultModel: 'bad model!' },
  });
  assert.equal(badModel.status, 400);

  const stillEmpty = await client.request('/api/generate/config');
  assert.equal(stillEmpty.payload.configured, false);
  assert.equal(stillEmpty.payload.baseUrl, ARK_DEFAULT_BASE_URL);
});

test('the three modes reach the upstream client with the right input', async (t) => {
  const { base, calls } = await boot(t, { env: 'sk-env' });
  const client = await signIn(base);

  const text2image = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '一只橘猫', size: '2K', optimizeMode: 'standard' },
  });
  assert.equal(text2image.status, 200);
  assert.equal(calls[0].input.mode, 'text2image');
  assert.equal(calls[0].input.model, ARK_DEFAULT_MODEL, 'the configured default model is applied');
  assert.equal(calls[0].input.size, '2K');
  assert.equal(calls[0].input.maxImages, undefined);

  const group = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2group', prompt: '一只小橘猫的一天', maxImages: 6 },
  });
  assert.equal(group.status, 200);
  assert.equal(calls[1].input.mode, 'text2group');
  assert.equal(calls[1].input.maxImages, 6);

  const image2image = await client.request('/api/generate', {
    method: 'POST',
    body: {
      mode: 'image2image',
      prompt: '保持构图，把主体换成一只狗',
      referenceImages: ['https://example.com/cat.jpg'],
    },
  });
  assert.equal(image2image.status, 200);
  assert.deepEqual(calls[2].input.referenceImages, ['https://example.com/cat.jpg']);

  const inline = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'image2image', prompt: '改写', referenceImages: [PNG_DATA_URL] },
  });
  assert.equal(inline.status, 200, 'base64 reference images fit inside the raised body limit');
  assert.equal(calls[3].input.referenceImages[0].startsWith('data:image/png;base64,'), true);
});

test('invalid generation input is rejected without calling upstream', async (t) => {
  const { base, calls } = await boot(t, { env: 'sk-env' });
  const client = await signIn(base);

  const noPrompt = await client.request('/api/generate', { method: 'POST', body: { prompt: '' } });
  assert.equal(noPrompt.status, 400);

  const badMode = await client.request('/api/generate', { method: 'POST', body: { mode: 'draw', prompt: 'x' } });
  assert.equal(badMode.status, 400);

  const badRef = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'image2image', prompt: 'x', referenceImages: ['file:///etc/passwd'] },
  });
  assert.equal(badRef.status, 400);
  assert.match(badRef.payload.error, /必须使用 http 或 https/);

  const tooMany = await client.request('/api/generate', {
    method: 'POST',
    body: {
      mode: 'image2image',
      prompt: 'x',
      referenceImages: Array.from({ length: 15 }, (_, i) => `https://example.com/${i}.png`),
    },
  });
  assert.equal(tooMany.status, 400);

  assert.equal(calls.length, 0);
});

test('upstream failures surface as readable errors, never as a key leak', async (t) => {
  const { base } = await boot(t, {
    env: 'sk-secret-key-value',
    generateImages: async () => {
      throw new GenerationError('API Key 无效或没有该模型的权限（HTTP 401）', 502);
    },
  });
  const client = await signIn(base);

  const response = await client.request('/api/generate', { method: 'POST', body: { prompt: 'x' } });
  assert.equal(response.status, 502);
  assert.match(response.payload.error, /API Key 无效/);
  assert.equal(JSON.stringify(response.payload).includes('sk-secret-key-value'), false);
});

test('a group response returns every image, each importable on its own', async (t) => {
  const { base } = await boot(t, {
    env: 'sk-env',
    generateImages: async () =>
      fakeGeneration({
        images: [
          { url: 'https://tos.example.com/1.png?X-Tos-Expires=1782290231', b64: '', size: '2048x2048', expiresAt: '2026-09-24T03:17:11.000Z' },
          { url: 'https://tos.example.com/2.png?X-Tos-Expires=1782290231', b64: '', size: '2048x2048', expiresAt: '2026-09-24T03:17:11.000Z' },
          { url: 'https://tos.example.com/3.png', b64: '', size: '2048x2048', expiresAt: null },
        ],
        request: { mode: 'text2group', model: ARK_DEFAULT_MODEL, size: '2K', group: true, referenceCount: 0, maxImages: 3 },
      }),
  });
  const client = await signIn(base);

  const generated = await client.request('/api/generate', { method: 'POST', body: { mode: 'text2group', prompt: '三张分镜', maxImages: 3 } });
  assert.equal(generated.status, 200);
  assert.deepEqual(generated.payload.images.map((image) => image.index), [1, 2, 3]);
  assert.equal(generated.payload.images[0].expiresAt, '2026-09-24T03:17:11.000Z');
  assert.equal(generated.payload.images[2].expiresAt, null);
  assert.equal(generated.payload.request.group, true);

  const imported = await client.request('/api/images', {
    method: 'POST',
    body: {
      url: generated.payload.images[0].url,
      title: '三张分镜（1）',
      prompt: '三张分镜',
      model: ARK_DEFAULT_MODEL,
      tags: 'AI 生成, 分镜',
      provenance: {
        source: 'AI 生成',
        mode: 'text2group',
        model: ARK_DEFAULT_MODEL,
        size: '2048x2048',
        generatedAt: generated.payload.generatedAt,
        groupIndex: 1,
        groupTotal: 3,
        referenceCount: 0,
        urlExpiresAt: generated.payload.images[0].expiresAt,
      },
    },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.image.provenance.source, 'AI 生成');
  assert.equal(imported.payload.image.provenance.groupIndex, 1);
  assert.equal(imported.payload.image.provenance.groupTotal, 3);
  assert.deepEqual(imported.payload.image.tags, ['AI 生成', '分镜']);

  // Provenance survives the round trip through storage and sanitisation.
  const list = await client.request('/api/images');
  assert.equal(list.payload.images[0].provenance.mode, 'text2group');
  assert.equal(list.payload.images[0].provenance.groupIndex, 1);
  assert.equal(list.payload.images[0].provenance.model, ARK_DEFAULT_MODEL);

  const exported = await client.request('/api/export');
  assert.equal(exported.payload.images[0].provenance.source, 'AI 生成');
});

test('a generated image is previewed through the app, not the signed url', async (t) => {
  const SIGNED =
    'https://tos.example.com/only.png?X-Tos-Date=20260918T073432Z&X-Tos-Expires=86400&X-Tos-Signature=abc';
  const { base, downloads } = await boot(t, {
    env: 'sk-env',
    generateImages: async () =>
      fakeGeneration({
        images: [{ url: SIGNED, b64: '', size: '2048x2048', expiresAt: '2026-09-19T07:34:32.000Z' }],
      }),
  });
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '预览一张' },
  });
  assert.equal(generated.status, 200);
  const [image] = generated.payload.images;

  // The raw signed url is still handed over: "复制地址" and the importer use it.
  assert.equal(image.url, SIGNED);
  // The browser gets an opaque same-origin handle instead, so the preview does
  // not depend on it reaching Ark over the public internet.
  assert.match(image.previewUrl, /^\/api\/generate\/preview\/[0-9a-f-]{36}$/);
  assert.equal(downloads.length, 0, 'nothing is fetched until someone previews');

  // The handle is not a public asset.
  const anon = await fetch(`${base}${image.previewUrl}`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${base}${image.previewUrl}`, { headers: { cookie: client.cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.deepEqual(downloads, [SIGNED]);

  // Second view comes from memory, which is what keeps the preview alive after
  // the signed url itself has expired.
  const again = await fetch(`${base}${image.previewUrl}`, { headers: { cookie: client.cookie } });
  assert.equal(again.status, 200);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), PNG);
  assert.deepEqual(downloads, [SIGNED], 'the bitmap is cached, not re-downloaded');

  // A token this process never minted must not become a fetch-anything endpoint.
  const unknown = await fetch(`${base}/api/generate/preview/00000000-0000-4000-8000-000000000000`, {
    headers: { cookie: client.cookie },
  });
  assert.equal(unknown.status, 404);
});

test('an inline-only result gets no preview handle', async (t) => {
  const { base } = await boot(t, {
    env: 'sk-env',
    generateImages: async () =>
      fakeGeneration({
        images: [{ url: '', b64: 'AAAA', size: '1024x1024', expiresAt: null }],
      }),
  });
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '内联返回' },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.payload.images[0].previewUrl, '');
  assert.equal(generated.payload.images[0].b64, true);
});

test('provenance is whitelisted, so a client cannot store an arbitrary blob', async (t) => {
  const { base } = await boot(t, { env: 'sk-env' });
  const client = await signIn(base);

  const rejected = await client.request('/api/images', {
    method: 'POST',
    body: {
      url: 'https://cdn.example.com/a.png',
      title: 't',
      prompt: 'p',
      provenance: 'just a string',
    },
  });
  assert.equal(rejected.status, 400);

  const trimmed = await client.request('/api/images', {
    method: 'POST',
    body: {
      url: 'https://cdn.example.com/b.png',
      title: 't',
      prompt: 'p',
      provenance: { source: 'AI 生成', injected: 'x'.repeat(50), latencySeconds: '3.5' },
    },
  });
  assert.equal(trimmed.status, 201);
  assert.equal(trimmed.payload.image.provenance.source, 'AI 生成');
  assert.equal(trimmed.payload.image.provenance.injected, undefined, 'unknown keys are dropped');
  assert.equal(trimmed.payload.image.provenance.latencySeconds, 3.5);
});

test('generation is rate limited, because every call costs money upstream', async (t) => {
  const { base } = await boot(t, { env: 'sk-env' });
  const client = await signIn(base);

  let last = 0;
  for (let i = 0; i < 21; i += 1) {
    const response = await client.request('/api/generate', { method: 'POST', body: { prompt: `第 ${i} 张` } });
    last = response.status;
  }
  assert.equal(last, 429, 'the 21st call inside the window is refused');

  const config = await client.request('/api/generate/config');
  assert.equal(config.status, 200, 'reading the config is not rate limited by the generation bucket');
});

test('the admin console exposes the generation panel and its controls', async (t) => {
  const { base } = await boot(t);

  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.status, 200);
  const html = await admin.text();
  for (const id of [
    'genForm',
    'genTabs',
    'genPrompt',
    'genModel',
    'genSize',
    'genMaxImages',
    'genRefList',
    'genRefFile',
    'genResults',
    'genGrid',
    'genConfigForm',
    'genApiKey',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} should exist`);
  }
  assert.match(html, /data-mode="text2image"/);
  assert.match(html, /data-mode="text2group"/);
  assert.match(html, /data-mode="image2image"/);

  const csp = admin.headers.get('content-security-policy') || '';
  assert.match(csp, /img-src 'self' data: blob:/, 'local reference previews need blob:');

  const script = await fetch(`${base}/admin.js`);
  assert.equal(script.status, 200);
});
