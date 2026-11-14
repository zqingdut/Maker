/**
 * Bulk library operations: POST /api/images/batch.
 *
 * The route-ordering test is the important one here — `/api/images/:id` is a
 * catch-all pattern, so a naive registration order turns "batch" into an id and
 * every bulk request answers 405.
 */
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

const PASSWORD = 'correct-horse-battery';

async function boot(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-batch-'));
  const app = createApp({
    dataDir,
    seedDemo: false,
    downloadImage: async (url) => ({
      buffer: PNG,
      ext: '.png',
      mime: 'image/png',
      sourceUrl: url,
      finalUrl: url,
      bytes: PNG.length,
    }),
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${address.port}`, dataDir };
}

function makeClient(base) {
  let cookie = '';
  return {
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
      return { status: response.status, payload };
    },
  };
}

/** Authenticate and import `count` images, returning their ids in insert order. */
async function seed(client, count, tags = []) {
  await client.request('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const created = await client.request('/api/images', {
      method: 'POST',
      body: {
        url: `https://cdn.example.com/art/${index}.png`,
        title: `作品 ${index}`,
        prompt: `prompt number ${index}`,
        tags,
      },
    });
    assert.equal(created.status, 201);
    ids.push(created.payload.image.id);
  }
  return ids;
}

test('batch route is registered ahead of the /:id pattern', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  await seed(client, 1);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'nope', ids: ['x'] },
  });
  // 405 would mean the id route swallowed "batch" and rejected the method.
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /不支持的批量操作/);
});

test('batch operations require authentication and same-origin', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 2);

  const anonymous = makeClient(base);
  const unauthenticated = await anonymous.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids },
  });
  assert.equal(unauthenticated.status, 401);

  const crossOrigin = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids },
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 403);
});

test('batch delete removes records and their bitmaps', async (t) => {
  const { base, dataDir } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 4);

  const before = (await fsp.readdir(path.join(dataDir, 'uploads'))).length;
  assert.equal(before, 4);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids: [ids[0], ids[2]] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.affected, 2);
  assert.equal(res.payload.images.length, 2);

  const remaining = (await fsp.readdir(path.join(dataDir, 'uploads'))).length;
  assert.equal(remaining, 2, 'deleted bitmaps must be unlinked');

  const left = (await client.request('/api/images')).payload.images.map((image) => image.id);
  assert.deepEqual(left.sort(), [ids[1], ids[3]].sort());
});

test('batch tag merges without duplicating, and matches case-insensitively', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 3, ['风景', 'Film']);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'tag', ids, tags: ['film', '胶片'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.affected, 3);
  assert.equal(res.payload.truncated, 0);

  for (const image of res.payload.images) {
    // 'Film' must not be duplicated by 'film'.
    assert.deepEqual(image.tags, ['风景', 'Film', '胶片']);
  }
});

test('batch tag reports how many records hit the 12-tag ceiling', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const twelve = Array.from({ length: 12 }, (_, index) => `标签${index}`);
  const ids = await seed(client, 2, twelve);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'tag', ids, tags: ['溢出'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.affected, 2);
  assert.equal(res.payload.truncated, 2, 'both records were already at the ceiling');

  for (const image of res.payload.images) {
    assert.equal(image.tags.length, 12);
    assert.ok(!image.tags.includes('溢出'));
  }
});

test('batch tag accepts a comma-separated string, like the single-image API', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 1);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'tag', ids, tags: '甲, 乙' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.images[0].tags, ['甲', '乙']);
});

test('batch rejects empty selections, oversized selections and unknown ids', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 2);

  const empty = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids: [] },
  });
  assert.equal(empty.status, 400);
  assert.match(empty.payload.error, /至少选择一张/);

  const oversized = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) },
  });
  assert.equal(oversized.status, 400);
  assert.match(oversized.payload.error, /单次最多处理 200 张/);

  const missing = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'delete', ids: ['does-not-exist'] },
  });
  assert.equal(missing.status, 404);
  assert.match(missing.payload.error, /都不存在/);

  // Nothing was actually removed by any of the rejections.
  assert.equal((await client.request('/api/images')).payload.images.length, 2);
  assert.ok(ids.length === 2);
});

test('batch tag requires at least one usable tag', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 1);

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'tag', ids, tags: ['   ', ''] },
  });
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /至少提供一个要添加的标签/);
});

test('a rejected batch leaves the store unchanged', async (t) => {
  const { base, dataDir } = await boot(t);
  const client = makeClient(base);
  const ids = await seed(client, 3);

  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'images.json'), 'utf8'));
  const before = JSON.stringify(onDisk());

  const res = await client.request('/api/images/batch', {
    method: 'POST',
    body: { action: 'tag', ids, tags: ['x'.repeat(33)] },
  });
  assert.equal(res.status, 400);

  assert.equal(JSON.stringify(onDisk()), before);
  assert.equal((await fsp.readdir(path.join(dataDir, 'uploads'))).length, 3);
});
