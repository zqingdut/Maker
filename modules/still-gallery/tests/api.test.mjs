import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 3),
]);

/** Boot an isolated server with a stubbed downloader (no network access). */
async function boot(t, { downloadImage } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-'));
  const app = createApp({
    dataDir,
    seedDemo: false,
    downloadImage:
      downloadImage ||
      (async (url) => ({
        buffer: PNG,
        ext: '.png',
        mime: 'image/png',
        sourceUrl: url,
        finalUrl: url,
        bytes: PNG.length,
      })),
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { app, base, dataDir };
}

function makeClient(base) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    setCookie(value) {
      cookie = value;
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
      for (const entry of setCookie) {
        cookie = entry.split(';')[0];
      }
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json')
        ? await response.json()
        : await response.text();
      return { status: response.status, payload, headers: response.headers };
    },
  };
}

const sample = {
  url: 'https://cdn.example.com/art/render-01.png',
  title: '测试作品',
  prompt: 'a calm harbour at dusk, soft haze, 35mm film',
  negativePrompt: 'blurry, watermark',
  model: 'Flux.1 dev',
  tags: ['风景', '胶片'],
  aspectRatio: '4:3',
  seed: '42',
  steps: '30',
  guidance: '3.5',
};

test('writes are rejected until the administrator account exists', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);

  const status = await client.request('/api/auth/status');
  assert.equal(status.status, 200);
  assert.equal(status.payload.configured, false);
  assert.equal(status.payload.authenticated, false);

  const blocked = await client.request('/api/images', { method: 'POST', body: sample });
  assert.equal(blocked.status, 401);
  assert.match(blocked.payload.error, /登录/);

  const list = await client.request('/api/images');
  assert.equal(list.status, 200);
  assert.deepEqual(list.payload.images, []);
});

test('setup enforces password rules and only runs once', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);

  const tooShort = await client.request('/api/auth/setup', { method: 'POST', body: { password: 'short' } });
  assert.equal(tooShort.status, 400);

  const ok = await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });
  assert.equal(ok.status, 200);
  assert.ok(client.cookie.startsWith('sg_session='), 'a session cookie should be issued');

  const again = await client.request('/api/auth/setup', { method: 'POST', body: { password: 'another-password-1' } });
  assert.equal(again.status, 409);

  const status = await client.request('/api/auth/status');
  assert.equal(status.payload.configured, true);
  assert.equal(status.payload.authenticated, true);
});

test('import downloads the image, stores it and links the prompt metadata', async (t) => {
  const { base, dataDir } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });

  const created = await client.request('/api/images', { method: 'POST', body: sample });
  assert.equal(created.status, 201);

  const image = created.payload.image;
  assert.match(image.imageUrl, /^\/uploads\/[0-9a-f-]+\.png$/);
  assert.equal(image.sourceUrl, sample.url);
  assert.equal(image.prompt, sample.prompt);
  assert.equal(image.negativePrompt, sample.negativePrompt);
  assert.deepEqual(image.tags, ['风景', '胶片']);
  assert.equal(image.demo, false);

  const onDisk = path.join(dataDir, 'uploads', path.basename(image.imageUrl));
  assert.equal(fs.existsSync(onDisk), true, 'the downloaded file should exist in uploads/');
  assert.equal((await fsp.readFile(onDisk)).equals(PNG), true);

  const list = await client.request('/api/images');
  assert.equal(list.payload.images.length, 1);
  assert.equal(list.payload.images[0].id, image.id);

  const served = await fetch(`${base}${image.imageUrl}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
});

test('metadata can be edited but the image url is immutable', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });
  const created = await client.request('/api/images', { method: 'POST', body: sample });
  const id = created.payload.image.id;

  // Echoing the original identifiers back is allowed, so a client can PATCH a
  // record it just fetched without stripping fields.
  const patched = await client.request(`/api/images/${id}`, {
    method: 'PATCH',
    body: { ...sample, title: '改过的标题', prompt: 'new prompt', tags: 'a, b, a' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.payload.image.title, '改过的标题');
  assert.equal(patched.payload.image.prompt, 'new prompt');
  assert.deepEqual(patched.payload.image.tags, ['a', 'b'], 'tags are trimmed and de-duplicated');
  assert.equal(patched.payload.image.imageUrl, created.payload.image.imageUrl);

  const urlChange = await client.request(`/api/images/${id}`, {
    method: 'PATCH',
    body: { ...sample, url: 'https://evil.example.com/x.png' },
  });
  assert.equal(urlChange.status, 400);

  const idChange = await client.request(`/api/images/${id}`, {
    method: 'PATCH',
    body: { ...sample, id: 'someone-elses-id' },
  });
  assert.equal(idChange.status, 400);

  const missing = await client.request('/api/images/does-not-exist', { method: 'PATCH', body: sample });
  assert.equal(missing.status, 404);
});

test('delete removes both the record and the stored file', async (t) => {
  const { base, dataDir } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });
  const created = await client.request('/api/images', { method: 'POST', body: sample });
  const image = created.payload.image;
  const onDisk = path.join(dataDir, 'uploads', path.basename(image.imageUrl));

  const removed = await client.request(`/api/images/${image.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(onDisk), false);

  const list = await client.request('/api/images');
  assert.deepEqual(list.payload.images, []);

  const again = await client.request(`/api/images/${image.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('export includes prompts together with image urls', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });
  await client.request('/api/images', { method: 'POST', body: sample });

  const exported = await client.request('/api/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.payload.version, 1);
  assert.equal(exported.payload.images.length, 1);
  assert.equal(exported.payload.images[0].sourceUrl, sample.url);
  assert.equal(exported.payload.images[0].prompt, sample.prompt);
});

test('login, logout and session enforcement', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });
  await client.request('/api/auth/logout', { method: 'POST' });

  const afterLogout = await client.request('/api/images', { method: 'POST', body: sample });
  assert.equal(afterLogout.status, 401);

  const wrong = await client.request('/api/auth/login', { method: 'POST', body: { password: 'not-the-password' } });
  assert.equal(wrong.status, 401);

  const right = await client.request('/api/auth/login', { method: 'POST', body: { password: 'correct-horse-battery' } });
  assert.equal(right.status, 200);

  const allowed = await client.request('/api/images', { method: 'POST', body: sample });
  assert.equal(allowed.status, 201);
});

test('cross-site mutations are refused even with a valid session', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });

  const crossOrigin = await client.request('/api/images', {
    method: 'POST',
    body: sample,
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 403);

  const crossSite = await client.request('/api/images', {
    method: 'POST',
    body: sample,
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});

test('input validation rejects malformed imports', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });

  const noTitle = await client.request('/api/images', { method: 'POST', body: { ...sample, title: '  ' } });
  assert.equal(noTitle.status, 400);

  const noPrompt = await client.request('/api/images', { method: 'POST', body: { ...sample, prompt: '' } });
  assert.equal(noPrompt.status, 400);

  const noUrl = await client.request('/api/images', { method: 'POST', body: { ...sample, url: '' } });
  assert.equal(noUrl.status, 400);

  const manyTags = await client.request('/api/images', {
    method: 'POST',
    body: { ...sample, tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`) },
  });
  assert.equal(manyTags.status, 400);

  const wrongType = await client.request('/api/images', {
    method: 'POST',
    body: JSON.stringify(sample),
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(wrongType.status, 415);

  const huge = await client.request('/api/images', {
    method: 'POST',
    body: JSON.stringify({ ...sample, prompt: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(huge.status, 413);

  const badJson = await client.request('/api/images', {
    method: 'POST',
    body: '{oops',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(badJson.status, 400);
});

test('a rejected download leaves no partial record behind', async (t) => {
  const { base, dataDir } = await boot(t, {
    downloadImage: async () => {
      const { DownloadError } = await import('../lib/downloader.mjs');
      throw new DownloadError('该地址指向内网或保留地址，已被拒绝');
    },
  });
  const client = makeClient(base);
  await client.request('/api/auth/setup', { method: 'POST', body: { password: 'correct-horse-battery' } });

  const response = await client.request('/api/images', { method: 'POST', body: sample });
  assert.equal(response.status, 400);

  const list = await client.request('/api/images');
  assert.deepEqual(list.payload.images, []);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'uploads')), []);
});

test('static routes serve the gallery and block path traversal', async (t) => {
  const { base } = await boot(t);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /Still Gallery/);

  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /管理后台/);

  const csp = admin.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);

  const traversal = await fetch(`${base}/uploads/%2e%2e%2f%2e%2e%2fserver.mjs`);
  assert.equal(traversal.status === 404 || traversal.status === 400, true);

  const publicTraversal = await fetch(`${base}/..%2f..%2fserver.mjs`);
  assert.equal(publicTraversal.status === 404 || publicTraversal.status === 400, true);

  const missing = await fetch(`${base}/nope.css`);
  assert.equal(missing.status, 404);

  const unknownApi = await fetch(`${base}/api/whatever`);
  assert.equal(unknownApi.status, 404);
});
