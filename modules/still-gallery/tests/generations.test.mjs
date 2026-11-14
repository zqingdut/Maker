import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { createGenerationStore, GENERATION_KEEP_MS } from '../lib/generation-store.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 5),
]);
const PASSWORD = 'correct-horse-battery';
const SIGNED = 'https://tos.example.com/gen/one.png?X-Tos-Expires=86400&X-Tos-Signature=abc';

/** Store under a temp dir with a clock the test controls. */
async function bootStore(t, { keepMs = GENERATION_KEEP_MS, max } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-store-'));
  const clock = { now: Date.parse('2026-10-29T08:00:00.000Z') };
  const store = createGenerationStore({
    dir: path.join(dataDir, 'generations'),
    indexFile: path.join(dataDir, 'generations.json'),
    keepMs,
    max,
    now: () => clock.now,
  });
  await store.init();
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { store, clock, dataDir };
}

async function boot(t, { generateImages, downloadImage, generationKeepMs } = {}) {
  const savedEnv = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'sk-test';

  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-gen-api-'));
  const downloads = [];
  const app = createApp({
    dataDir,
    seedDemo: false,
    generationKeepMs,
    downloadImage: async (url) => {
      downloads.push(url);
      if (downloadImage) return downloadImage(url);
      return { buffer: PNG, ext: '.png', mime: 'image/png', sourceUrl: url, finalUrl: url, bytes: PNG.length };
    },
    generateImages:
      generateImages ||
      (async () => ({
        model: 'doubao-seedream-4-0-20260415',
        created: 1790000000,
        images: [{ url: SIGNED, b64: '', size: '2048x2048', expiresAt: null }],
        usage: null,
        request: { mode: 'text2image', size: '2K', group: false, maxImages: 1, referenceCount: 0 },
        generatedAt: new Date().toISOString(),
      })),
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.flush();
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (savedEnv === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = savedEnv;
  });
  return { app, base, dataDir, downloads };
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
      const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const entry of setCookie) cookie = entry.split(';')[0];
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, payload, headers: response.headers };
    },
    /** 二进制响应单独取，图片端点返回的不是 JSON。 */
    async bytes(pathname) {
      const response = await fetch(`${base}${pathname}`, { headers: cookie ? { cookie } : {} });
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
  };
}

async function signIn(base) {
  const client = makeClient(base);
  const res = await client.request('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  return client;
}

/* ------------------------------ store ------------------------------ */

test('记录按时间倒序，超过保留窗口的条目连同文件一起被剪掉', async (t) => {
  const { store, clock, dataDir } = await bootStore(t, { keepMs: 60_000 });

  const first = await store.add({ prompt: '第一张', url: SIGNED, model: 'm1' });
  await store.attach(first.id, { buffer: PNG, ext: '.png', mime: 'image/png' });
  assert.equal((await fsp.readdir(path.join(dataDir, 'generations'))).length, 1);

  clock.now += 30_000;
  const second = await store.add({ prompt: '第二张', url: SIGNED, model: 'm2' });

  const list = await store.list();
  assert.deepEqual(
    list.map((entry) => entry.prompt),
    ['第二张', '第一张'],
    '最新的在前',
  );
  assert.equal(list[0].id, second.id);

  // 跨过第一条的保留窗口：它的文件必须被删掉，不是只从索引里消失。
  clock.now += 31_000;
  const after = await store.list();
  assert.deepEqual(after.map((entry) => entry.prompt), ['第二张']);
  const files = await fsp.readdir(path.join(dataDir, 'generations'));
  assert.deepEqual(files, [], '过期条目的图片文件要一起删除');
});

test('条数上限按时间砍最旧的，不是拒绝新的', async (t) => {
  const { store, clock } = await bootStore(t, { keepMs: GENERATION_KEEP_MS, max: 3 });
  const ids = [];
  for (const label of ['a', 'b', 'c', 'd']) {
    clock.now += 1000;
    ids.push((await store.add({ prompt: label, url: SIGNED })).id);
  }
  const list = await store.list();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((entry) => entry.prompt), ['d', 'c', 'b']);
  assert.equal(await store.get(ids[0]), null, '最旧的一条被挤出去');
});

test('索引损坏时按空处理，不影响服务启动', async (t) => {
  const { store, dataDir } = await bootStore(t);
  await fsp.writeFile(path.join(dataDir, 'generations.json'), '{ 这不是 JSON', 'utf8');
  const reopened = createGenerationStore({
    dir: path.join(dataDir, 'generations'),
    indexFile: path.join(dataDir, 'generations.json'),
  });
  await reopened.init();
  assert.deepEqual(await reopened.list(), []);
  const added = await reopened.add({ prompt: '还能继续用', url: SIGNED });
  assert.ok(added.id);
});

/* ------------------------------- API ------------------------------- */

test('生成成功后可以在 24 小时记录里看到，且不外泄上游签名地址', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '雪地里的橘猫' },
  });
  assert.equal(generated.status, 200);
  const recordId = generated.payload.images[0].recordId;
  assert.match(recordId, /^[0-9a-f-]{36}$/, '生成结果要带回记录 id');

  const listed = await client.request('/api/generations');
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.entries.length, 1);
  const [entry] = listed.payload.entries;
  assert.equal(entry.id, recordId);
  assert.equal(entry.prompt, '雪地里的橘猫');
  assert.equal(entry.model, 'doubao-seedream-4-0-20260415');
  assert.equal(entry.size, '2048x2048');
  assert.equal(entry.stored, false, '生成时不下载，所以还没落盘');
  assert.equal(entry.fileUrl, `/api/generations/${recordId}/file`);
  assert.ok(!JSON.stringify(entry).includes('X-Tos-Signature'), '签名地址不能出现在列表里');
  assert.equal(listed.payload.keepHours, 24);
});

test('原图第一次查看才回源并落盘，之后直接读磁盘', async (t) => {
  const { base, downloads } = await boot(t);
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '按需下载' },
  });
  const { recordId } = generated.payload.images[0];
  assert.equal(downloads.length, 0, '生成阶段不下载');

  const first = await client.bytes(`/api/generations/${recordId}/file`);
  assert.equal(first.status, 200);
  assert.equal(first.type, 'image/png');
  assert.deepEqual(first.body, PNG);
  assert.deepEqual(downloads, [SIGNED]);

  const second = await client.bytes(`/api/generations/${recordId}/file`);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, PNG);
  assert.deepEqual(downloads, [SIGNED], '落盘之后不再回源');

  const listed = await client.request('/api/generations');
  assert.equal(listed.payload.entries[0].stored, true);
  assert.equal(listed.payload.entries[0].bytes, PNG.length);
});

test('从记录导入会写进图库、继承提示词，并标记已导入', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '黄昏的海港，柔和雾气' },
  });
  const { recordId } = generated.payload.images[0];

  const imported = await client.request(`/api/generations/${recordId}/import`, {
    method: 'POST',
    body: { tags: '风景, 胶片' },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.image.prompt, '黄昏的海港，柔和雾气');
  assert.equal(imported.payload.image.title, '黄昏的海港，柔和雾气');
  assert.deepEqual(imported.payload.image.tags, ['风景', '胶片']);
  assert.equal(imported.payload.image.provenance.source, 'AI 生成');
  assert.match(imported.payload.image.imageUrl, /^\/uploads\/[0-9a-f-]+\.png$/);

  const listed = await client.request('/api/generations');
  assert.equal(listed.payload.entries[0].importedId, imported.payload.image.id);

  const library = await client.request('/api/images');
  assert.equal(library.payload.images.length, 1);

  const again = await client.request(`/api/generations/${recordId}/import`, { method: 'POST', body: {} });
  assert.equal(again.status, 409, '同一张图不能重复入库');
});

test('内联（base64）结果直接落盘，可以查看也可以导入', async (t) => {
  const { base, downloads } = await boot(t, {
    generateImages: async () => ({
      model: 'doubao-seedream-5-0-pro',
      created: 1790000000,
      images: [{ url: '', b64: PNG.toString('base64'), size: '1024x1024', expiresAt: null }],
      usage: null,
      request: { mode: 'text2image', size: '1K', group: false, maxImages: 1, referenceCount: 0 },
      generatedAt: new Date().toISOString(),
    }),
  });
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '内联返回' },
  });
  assert.equal(generated.status, 200);
  const { recordId } = generated.payload.images[0];

  const listed = await client.request('/api/generations');
  assert.equal(listed.payload.entries[0].stored, true, 'base64 结果在生成时就落盘');
  assert.equal(listed.payload.entries[0].inline, true);

  const file = await client.bytes(`/api/generations/${recordId}/file`);
  assert.equal(file.status, 200);
  assert.deepEqual(file.body, PNG);
  assert.deepEqual(downloads, [], '内联结果不需要回源');

  const imported = await client.request(`/api/generations/${recordId}/import`, { method: 'POST', body: {} });
  assert.equal(imported.status, 201);
});

test('预览已经取过的图，导入时不再回源', async (t) => {
  // 预览和导入都要那张原图。预览已经把字节下载进进程了，导入再要一次就是第二次
  // 网络依赖——网关前面挂着反代、`/files/` 没跟着转发时，第二次会失败，表现成
  // 「看得见图，导不进来」。这里让第二次下载必然失败来证明它压根没发生。
  let attempts = 0;
  const { base, downloads } = await boot(t, {
    downloadImage: async (url) => {
      attempts += 1;
      if (attempts > 1) throw new Error('第二次回源不该发生');
      return { buffer: PNG, ext: '.png', mime: 'image/png', sourceUrl: url, finalUrl: url, bytes: PNG.length };
    },
  });
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '预览过的图' },
  });
  const image = generated.payload.images[0];
  assert.equal(downloads.length, 0, '生成阶段不下载');

  const preview = await client.bytes(image.previewUrl);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body, PNG);
  assert.equal(downloads.length, 1);

  const imported = await client.request(`/api/generations/${image.recordId}/import`, {
    method: 'POST',
    body: {},
  });
  assert.equal(imported.status, 201);
  assert.equal(downloads.length, 1, '导入复用预览缓存，不再回源');
  assert.equal(attempts, 1);

  // 缓存里的字节同样要落盘，之后再取不该再回源。
  const file = await client.bytes(`/api/generations/${image.recordId}/file`);
  assert.equal(file.status, 200);
  assert.deepEqual(file.body, PNG);
  assert.equal(downloads.length, 1);
});

test('删除单条与清空都真的删文件', async (t) => {
  const { base, dataDir } = await boot(t);
  const client = await signIn(base);

  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '删掉我' },
  });
  const { recordId } = generated.payload.images[0];
  await client.bytes(`/api/generations/${recordId}/file`);

  const removed = await client.request(`/api/generations/${recordId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'generations')), []);

  const gone = await client.bytes(`/api/generations/${recordId}/file`);
  assert.equal(gone.status, 404);

  await client.request('/api/generate', { method: 'POST', body: { mode: 'text2image', prompt: '再生成一张' } });
  const cleared = await client.request('/api/generations', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.removed, 1);
  const empty = await client.request('/api/generations');
  assert.deepEqual(empty.payload.entries, []);
});

test('记录接口一律要求登录', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);
  const generated = await client.request('/api/generate', {
    method: 'POST',
    body: { mode: 'text2image', prompt: '鉴权' },
  });
  const { recordId } = generated.payload.images[0];

  const anon = makeClient(base);
  assert.equal((await anon.request('/api/generations')).status, 401);
  assert.equal((await anon.request(`/api/generations/${recordId}/file`)).status, 401);
  assert.equal((await anon.request(`/api/generations/${recordId}/import`, { method: 'POST', body: {} })).status, 401);
  assert.equal((await anon.request(`/api/generations/${recordId}`, { method: 'DELETE' })).status, 401);
});
