/**
 * 后台剪贴板：存储层 + HTTP 接口。
 *
 * 这个功能最容易被写坏的地方不是渲染，是**淘汰**——先进先出意味着有数据会被
 * 主动丢弃，而丢错了（丢新的、丢一半、留下指向空文件的记录）在界面上看不出来，
 * 要等用户回头找东西才发现。所以这里的用例大多围着「谁被丢、丢干净没有」转。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { CLIPBOARD_MAX_IMAGES, createClipboardStore } from '../lib/clipboard-store.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 7),
]);
const PASSWORD = 'correct-horse-battery';

async function tempStore(t, options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-clip-'));
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  const store = createClipboardStore({
    dir: path.join(dataDir, 'clipboard'),
    indexFile: path.join(dataDir, 'clipboard.json'),
    ...options,
  });
  await store.init();
  return { store, dataDir };
}

/* ------------------------------- 存储层 ------------------------------- */

test('存储层：新增、检索、改名、删除，图片文件跟着走', async (t) => {
  const { store, dataDir } = await tempStore(t);

  const one = await store.add({ text: '# 标题\n\n第一段', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  await store.add({ text: '纯文字的一条' });

  assert.equal(one.item.chars, 9);
  assert.equal(one.item.images.length, 1);
  assert.equal(one.item.images[0].bytes, PNG.length);

  // 新的在前。
  const all = await store.list();
  assert.equal(all.total, 2);
  assert.equal(all.items[0].text, '纯文字的一条');

  // 关键词检索，不区分大小写。
  assert.equal((await store.list({ q: '标题' })).total, 1);
  assert.equal((await store.list({ q: '不存在的词' })).total, 0);

  const files = await fsp.readdir(path.join(dataDir, 'clipboard'));
  assert.equal(files.length, 1);
  assert.deepEqual(await fsp.readFile(path.join(dataDir, 'clipboard', files[0])), PNG);

  const patched = await store.patch(one.item.id, { text: '改过的内容' });
  assert.equal(patched.text, '改过的内容');
  assert.equal(patched.images.length, 1, '改文字不动图片');

  await store.remove(one.item.id);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'clipboard')), [], '删除记录要连带删掉图片');
  assert.equal((await store.list()).total, 1);
});

test('存储层：满了按先进先出挤掉最旧的，文件一起删', async (t) => {
  const { store, dataDir } = await tempStore(t, { maxItems: 3 });

  for (const label of ['一', '二', '三']) {
    await store.add({ text: label, images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  }
  const overflow = await store.add({ text: '四', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });

  assert.equal(overflow.evicted, 1, '超出上限要报告挤掉了几条');
  const list = await store.list();
  assert.equal(list.total, 3);
  assert.deepEqual(
    list.items.map((item) => item.text),
    ['四', '三', '二'],
    '最新的在最前，最旧的一条被挤掉',
  );
  // 只留 3 个文件：被挤掉那条的图必须删掉，否则磁盘会一直涨。
  assert.equal((await fsp.readdir(path.join(dataDir, 'clipboard'))).length, 3);
});

test('存储层：字节上限同样按先进先出挤，但永远留住刚写进来的那条', async (t) => {
  const { store } = await tempStore(t, { maxBytes: PNG.length * 2 });

  await store.add({ text: '一', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  await store.add({ text: '二', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  const third = await store.add({ text: '三', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });

  assert.equal(third.evicted, 1);
  assert.equal((await store.list()).total, 2);
  assert.equal(third.item.text, '三', '刚存进来的这条不能被自己挤掉');
});

test('存储层：和最新一条完全相同时不新增，只更新时间', async (t) => {
  const { store } = await tempStore(t);
  const first = await store.add({ text: '同一段话' });
  const again = await store.add({ text: '同一段话' });

  assert.equal(again.deduped, true);
  assert.equal(again.item.id, first.item.id);
  assert.equal((await store.list()).total, 1);
});

test('存储层：只有图片没有文字也是一条合法记录', async (t) => {
  const { store } = await tempStore(t);
  const { item } = await store.add({ text: '   ', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  assert.equal(item.text, '');
  assert.equal(item.images.length, 1);
  assert.equal((await store.list()).total, 1);
});

test('存储层：空内容与超量图片都被拒，且不留下任何文件', async (t) => {
  const { store, dataDir } = await tempStore(t);
  await assert.rejects(() => store.add({ text: '   ' }), /内容不能为空/);
  await assert.rejects(
    () =>
      store.add({
        text: 'x',
        images: Array.from({ length: CLIPBOARD_MAX_IMAGES + 1 }, () => ({ buffer: PNG, ext: '.png' })),
      }),
    /最多带 8 张/,
  );
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'clipboard')), []);
});

test('存储层：索引损坏时按空处理，不会把服务带崩', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-clip-bad-'));
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(dataDir, 'clipboard.json'), '{ not json');
  const store = createClipboardStore({
    dir: path.join(dataDir, 'clipboard'),
    indexFile: path.join(dataDir, 'clipboard.json'),
  });
  await store.init();
  assert.equal((await store.list()).total, 0);
  // 坏索引不该妨碍继续写入。
  await store.add({ text: '还能用' });
  assert.equal((await store.list()).total, 1);
});

test('存储层：图片文件被外部删掉时，索引里的那条只保留文字', async (t) => {
  const { store, dataDir } = await tempStore(t);
  await store.add({ text: '带图的一条', images: [{ buffer: PNG, ext: '.png', mime: 'image/png' }] });
  await fsp.rm(path.join(dataDir, 'clipboard'), { recursive: true, force: true });

  // 重新建一个 store 走一遍 init（内存里那份还记着图）。
  const again = createClipboardStore({
    dir: path.join(dataDir, 'clipboard'),
    indexFile: path.join(dataDir, 'clipboard.json'),
  });
  await again.init();
  const list = await again.list();
  assert.equal(list.total, 1);
  assert.equal(list.items[0].text, '带图的一条');
  assert.equal(list.items[0].images.length, 0, '文件没了就不该再给出一个必然 404 的地址');
});

/* -------------------------------- API -------------------------------- */

async function boot(t, options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-clip-api-'));
  const app = createApp({ dataDir, seedDemo: false, ...options });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.flush();
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { app, base, dataDir };
}

function makeClient(base) {
  let cookie = '';
  return {
    async request(pathname, { method = 'GET', body, headers = {} } = {}) {
      const init = { method, headers: { ...headers }, redirect: 'manual' };
      if (cookie) init.headers.cookie = cookie;
      if (body !== undefined) {
        if (Buffer.isBuffer(body)) init.body = body;
        else if (typeof body === 'string') {
          if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
          init.body = body;
        } else {
          if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
      }
      const response = await fetch(`${base}${pathname}`, init);
      for (const entry of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
        cookie = entry.split(';')[0];
      }
      const type = response.headers.get('content-type') || '';
      const payload = type.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, payload, headers: response.headers };
    },
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

function multipart(fields, files, boundary = '----stillgalleryclip') {
  const chunks = [];
  for (const [name, value] of Object.entries(fields || {})) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(client, files, fields) {
  const { body, contentType } = multipart(fields, files);
  return client.request('/api/clipboard/upload', {
    method: 'POST',
    body,
    headers: { 'content-type': contentType },
  });
}

test('剪贴板的所有接口都必须登录', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);

  assert.equal((await client.request('/api/clipboard')).status, 401);
  assert.equal((await client.request('/api/clipboard', { method: 'POST', body: { text: 'x' } })).status, 401);
  assert.equal((await upload(client, [{ filename: 'a.png', data: PNG }])).status, 401);
  assert.equal((await client.request('/api/clipboard/anything/file/0')).status, 401);
  assert.equal((await client.request('/api/clipboard', { method: 'DELETE' })).status, 401);
});

test('存一条文字后能在列表里看到，也能按关键词搜到', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const created = await client.request('/api/clipboard', {
    method: 'POST',
    body: { text: '## 一段 Markdown\n\n- 第一项\n- 第二项' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.deduped, false);
  assert.equal(created.payload.item.chars, 27);
  assert.equal(created.payload.item.images.length, 0);

  const listed = await client.request('/api/clipboard');
  assert.equal(listed.payload.total, 1);
  assert.equal(listed.payload.items[0].id, created.payload.item.id);
  assert.equal(listed.payload.stats.count, 1);
  assert.equal(listed.payload.stats.maxItems, 100);

  const searched = await client.request('/api/clipboard?q=' + encodeURIComponent('第一项'));
  assert.equal(searched.payload.total, 1);
  assert.equal((await client.request('/api/clipboard?q=nothing')).payload.total, 0);
});

test('存一条图文后图片能原样取回，落盘在 data/clipboard', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [{ filename: '截图.png', data: PNG }], { text: '看这张图' });
  assert.equal(res.status, 201);
  const item = res.payload.item;
  assert.equal(item.text, '看这张图');
  assert.equal(item.source, 'upload');
  assert.equal(item.images.length, 1);
  assert.equal(item.images[0].mime, 'image/png');

  const file = await client.bytes(item.images[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(file.body, PNG);

  assert.equal((await fsp.readdir(path.join(app.dataDir, 'clipboard'))).length, 1);
  // 私有就是私有：公开图库里不该出现它。
  assert.equal((await client.request('/api/images')).payload.images.length, 0);
});

test('不是图片的字节被整条拒掉，不落盘', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [{ filename: 'fake.png', data: Buffer.from('#!/bin/sh\nrm -rf /\n') }], {
    text: '夹带私货',
  });
  assert.equal(res.status, 415);
  assert.match(res.payload.error, /不是可识别的图片/);
  assert.deepEqual(await fsp.readdir(path.join(app.dataDir, 'clipboard')).catch(() => []), []);
  assert.equal((await client.request('/api/clipboard')).payload.total, 0);
});

test('一次带太多图片被拒，边界值本身可以通过', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const tooMany = Array.from({ length: CLIPBOARD_MAX_IMAGES + 1 }, (_, index) => ({
    filename: `${index}.png`,
    data: PNG,
  }));
  const rejected = await upload(client, tooMany, { text: '九张' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.payload.error, /最多带 8 张/);

  const allowed = await upload(
    client,
    tooMany.slice(0, CLIPBOARD_MAX_IMAGES),
    { text: '八张' },
  );
  assert.equal(allowed.status, 201);
  assert.equal(allowed.payload.item.images.length, CLIPBOARD_MAX_IMAGES);
});

test('文字可以改，改完是空的会被拒（有图时则允许）', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const textOnly = await client.request('/api/clipboard', { method: 'POST', body: { text: '原始' } });
  const id = textOnly.payload.item.id;

  const patched = await client.request(`/api/clipboard/${id}`, { method: 'PATCH', body: { text: '改后' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.payload.item.text, '改后');

  const empty = await client.request(`/api/clipboard/${id}`, { method: 'PATCH', body: { text: '  ' } });
  assert.equal(empty.status, 400);
  assert.match(empty.payload.error, /内容不能为空/);

  const withImage = await upload(client, [{ filename: 'a.png', data: PNG }], { text: '图' });
  const cleared = await client.request(`/api/clipboard/${withImage.payload.item.id}`, {
    method: 'PATCH',
    body: { text: '' },
  });
  assert.equal(cleared.status, 200, '还有图片时允许把文字清空');
  assert.equal(cleared.payload.item.text, '');
});

test('删除单条、清空全部，文件一起清掉', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const a = await upload(client, [{ filename: 'a.png', data: PNG }], { text: 'A' });
  const b = await upload(client, [{ filename: 'b.png', data: PNG }], { text: 'B' });
  assert.equal((await fsp.readdir(path.join(app.dataDir, 'clipboard'))).length, 2);

  const removed = await client.request(`/api/clipboard/${a.payload.item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(removed.payload.stats.count, 1);

  const cleared = await client.request('/api/clipboard', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.removed, 1);
  assert.equal((await client.request('/api/clipboard')).payload.total, 0);
  assert.deepEqual(await fsp.readdir(path.join(app.dataDir, 'clipboard')), []);
});

test('第 101 条进来时最早的一条被挤掉，响应里报出条数', async (t) => {
  const { base } = await boot(t, { clipboardMaxItems: 3 });
  const client = await signIn(base);

  for (const label of ['一', '二', '三']) {
    await client.request('/api/clipboard', { method: 'POST', body: { text: label } });
  }
  const fourth = await client.request('/api/clipboard', { method: 'POST', body: { text: '四' } });
  assert.equal(fourth.status, 201);
  assert.equal(fourth.payload.evicted, 1);

  const list = await client.request('/api/clipboard');
  assert.deepEqual(
    list.payload.items.map((item) => item.text),
    ['四', '三', '二'],
  );
});

test('不存在的记录：改 / 删 / 取图都是 404，不是 500', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  assert.equal((await client.request('/api/clipboard/nope', { method: 'PATCH', body: { text: 'x' } })).status, 404);
  assert.equal((await client.request('/api/clipboard/nope', { method: 'DELETE' })).status, 404);
  assert.equal((await client.bytes('/api/clipboard/nope/file/0')).status, 404);
});

test('只带图片不带文字也能存（复制截图就是这条路）', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [{ filename: 'shot.png', data: PNG }], { text: '' });
  assert.equal(res.status, 201);
  assert.equal(res.payload.item.text, '');
  assert.equal(res.payload.item.images.length, 1);

  const empty = await upload(client, [], { text: '   ' });
  assert.equal(empty.status, 400);
});

test('剪贴板内容不进运行日志', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  await client.request('/api/clipboard', { method: 'POST', body: { text: 'sk-this-is-a-secret-token' } });
  const logs = app.events.list({ limit: 200, level: 'debug' });
  const joined = JSON.stringify(logs);
  assert.equal(joined.includes('sk-this-is-a-secret-token'), false, '日志里绝不能出现剪贴板正文');
  assert.match(joined, /剪贴板新增 1 条/);
});
