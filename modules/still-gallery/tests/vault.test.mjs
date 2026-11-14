import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { boundaryOf, parseMultipart, titleFromFilename } from '../lib/multipart.mjs';
import { createVaultStore } from '../lib/vault-store.mjs';
import { buildZip, crc32, safeEntryName } from '../lib/zip.mjs';

/** 最小合法 PNG 头 + 填充，足够骗过魔数校验，也让字节比对有意义。 */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(256, 7),
]);
const PASSWORD = 'correct-horse-battery';

/* ------------------------------ 解析器 ------------------------------ */

test('boundary 只从 multipart 头里取，畸形值一律拒绝', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary=abc123'), 'abc123');
  assert.equal(boundaryOf('multipart/form-data; boundary="abc"'), 'abc', '引号会被剥掉');
  assert.equal(boundaryOf('multipart/form-data'), '', '没有 boundary 就是空串');
  assert.equal(boundaryOf('application/json; boundary=abc'), '', '不是 multipart 就不认');
  assert.equal(boundaryOf('multipart/form-data; boundary="a b"'), '', 'boundary 不能含空白');
});

test('解析出多个分段，二进制正文里的 CRLF 不被破坏', () => {
  const boundary = 'BOUND';
  const tricky = Buffer.from([0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0x0d, 0x0a]);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n标题\r\n`),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    tricky,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'title');
  assert.equal(parts[0].data.toString('utf8'), '标题');
  assert.equal(parts[1].filename, 'a.png');
  assert.equal(parts[1].contentType, 'image/png');
  // 正文必须逐字节一致：先 toString 再切会把这些 0x0d/0x0a 改坏。
  assert.deepEqual(parts[1].data, Buffer.concat([PNG, tricky]));
});

test('filename* 优先，文件名里的路径被剥掉', () => {
  const boundary = 'B2';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="fallback.png"; filename*=UTF-8''%E4%B8%AD%E6%96%87.png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const [part] = parseMultipart(body, boundary);
  assert.equal(part.filename, '中文.png');
  assert.equal(titleFromFilename('C:\\Users\\niko\\图片\\风景 图.png'), '风景 图');
  assert.equal(titleFromFilename('no-extension'), 'no-extension');
});

/* ------------------------------- 存储 ------------------------------- */

test('存储层：新增、搜索、改名、删除，文件跟着走', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-vault-'));
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  const store = createVaultStore({
    dir: path.join(dataDir, 'vault'),
    indexFile: path.join(dataDir, 'vault.json'),
  });
  await store.init();

  const one = await store.add({ buffer: PNG, ext: '.png', mime: 'image/png', title: '海边', tags: '风景,蓝色' });
  await store.add({ buffer: PNG, ext: '.png', mime: 'image/png', title: '城市' });

  const searched = await store.list({ q: '海边' });
  assert.equal(searched.total, 1);
  assert.deepEqual(searched.items[0].tags, ['风景', '蓝色']);
  assert.equal((await store.list()).total, 2);

  const patched = await store.patch(one.id, { title: '海边日落', tags: ['风景'] });
  assert.equal(patched.title, '海边日落');
  assert.deepEqual(patched.tags, ['风景']);

  const file = path.join(dataDir, 'vault', `${one.id}.png`);
  assert.deepEqual(await fsp.readFile(file), PNG, '落盘的就是原字节');

  await store.remove(one.id);
  await assert.rejects(fsp.access(file), '删除记录要连带删掉文件');
  assert.equal((await store.list()).total, 1);
});

test('存储层：条数上限与总量配额都拒绝新增，而不是悄悄删旧的', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-vault-q-'));
  t.after(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  const store = createVaultStore({
    dir: path.join(dataDir, 'vault'),
    indexFile: path.join(dataDir, 'vault.json'),
    maxItems: 1,
  });
  await store.init();
  await store.add({ buffer: PNG, ext: '.png', mime: 'image/png', title: '一' });
  await assert.rejects(
    () => store.add({ buffer: PNG, ext: '.png', mime: 'image/png', title: '二' }),
    /最多 1 张/,
  );
  assert.equal((await store.list()).total, 1, '超出上限时旧的一张必须还在');
});

/* ------------------------------- zip ------------------------------- */

/**
 * 一个只够读回自己产物的 ZIP 读取器：走中央目录 → 本地头 → 数据。
 * 用它断言「产出的包真的能被标准结构读出来」，而不是只比对字节前缀。
 */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(eocd, -1, '必须能找到中央目录结束记录');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);

  const out = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, '中央目录头签名');
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, '本地头签名');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressed);
    assert.equal(crc32(data), crc, '中央目录里的 CRC 必须和数据对得上');

    out.push({ name, data: Buffer.from(data) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, offset + size, '中央目录长度必须自洽');
  return out;
}

test('crc32 用标准测试向量', () => {
  assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('包内文件名剥掉路径与非法字符，并加序号防重名', () => {
  assert.equal(safeEntryName('海边/日落 测试', '.png', 0), '01-海边 日落 测试.png');
  assert.equal(safeEntryName('..\\..\\etc\\passwd', '.jpg', 1), '02-.. .. etc passwd.jpg');
  assert.equal(safeEntryName('', '.png', 2), '03-image.png');
  assert.equal(safeEntryName('a\u0000b', '.webp', 3), '04-ab.webp');
  assert.ok(safeEntryName('长'.repeat(200), '.png', 4).length <= 70, '过长的标题要截断');
});

test('zip 产物能被按标准结构读回，二进制内容逐字节一致', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-zip-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const tricky = Buffer.from([0x00, 0x0d, 0x0a, 0x50, 0x4b, 0x03, 0x04, 0xff]);
  await fsp.writeFile(path.join(dir, 'a.bin'), tricky);
  await fsp.writeFile(path.join(dir, 'b.bin'), PNG);

  const { buffer, count, bytes } = await buildZip({
    entries: [
      { path: path.join(dir, 'a.bin'), mtime: new Date('2026-11-07T10:00:00Z') },
      { path: path.join(dir, 'b.bin'), mtime: new Date('2026-11-07T10:00:00Z') },
    ],
    readFile: fsp.readFile,
    nameFor: (entry, index) => safeEntryName(['第一张', '第二张'][index], '.png', index),
  });

  assert.equal(count, 2);
  assert.equal(bytes, tricky.length + PNG.length);

  const entries = readZip(buffer);
  assert.deepEqual(entries.map((entry) => entry.name), ['01-第一张.png', '02-第二张.png']);
  assert.deepEqual(entries[0].data, tricky, '含 CRLF 与 PK 签名的二进制不能被破坏');
  assert.deepEqual(entries[1].data, PNG);
});

test('文件在打包途中消失时跳过它，而不是让整包失败', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-zip-miss-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await fsp.writeFile(path.join(dir, 'ok.bin'), PNG);

  const { buffer, count, skipped } = await buildZip({
    entries: [
      { path: path.join(dir, 'gone.bin') },
      { path: path.join(dir, 'ok.bin') },
    ],
    readFile: fsp.readFile,
    nameFor: (entry, index) => `file-${index}.png`,
  });
  assert.equal(count, 1);
  assert.equal(skipped, 1);
  assert.equal(readZip(buffer).length, 1);
});

/* -------------------------------- API -------------------------------- */

async function boot(t, options = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-vault-api-'));
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
    get cookie() {
      return cookie;
    },
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

/** 拼一个真实的 multipart 请求体。 */
function multipart(fields, files, boundary = '----stillgallerytest') {
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
  return client.request('/api/vault/upload', {
    method: 'POST',
    body,
    headers: { 'content-type': contentType },
  });
}

test('后台图库的所有接口都必须登录', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);

  assert.equal((await client.request('/api/vault')).status, 401);
  assert.equal((await upload(client, [{ filename: 'a.png', data: PNG }])).status, 401);
  assert.equal(
    (await client.request('/api/vault/from-generation', { method: 'POST', body: { id: 'x' } })).status,
    401,
  );
  assert.equal((await client.request('/api/vault/anything/file')).status, 401);
});

test('上传本地图片后能在图库看到，但公开图库里没有它', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [{ filename: '海边 日落.png', data: PNG }], { prompt: '一张海边照片' });
  assert.equal(res.status, 201);
  assert.equal(res.payload.added.length, 1);
  const item = res.payload.added[0];
  assert.equal(item.title, '海边 日落');
  assert.equal(item.prompt, '一张海边照片');
  assert.equal(item.mime, 'image/png');
  assert.equal(item.bytes, PNG.length);

  const listed = await client.request('/api/vault');
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.total, 1);
  assert.equal(listed.payload.items[0].id, item.id);
  assert.equal(listed.payload.stats.count, 1);

  // 私有就是私有：公开图库的接口里绝不能出现它。
  const publicList = await client.request('/api/images');
  assert.equal(publicList.payload.images.length, 0, '公开图库不应包含后台图库的内容');

  // 原图能取回，且字节一致。
  const file = await client.bytes(`/api/vault/${item.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(file.body, PNG);

  // 落盘位置在 data/vault，不在公开的 uploads。
  const files = await fsp.readdir(path.join(app.dataDir, 'vault'));
  assert.deepEqual(files, [`${item.id}.png`]);
});

test('不是图片的字节被拒，且不会落盘', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [
    { filename: 'fake.png', data: Buffer.from('#!/bin/sh\necho not an image\n'), type: 'image/png' },
  ]);
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /不是可识别的图片/);
  assert.deepEqual(await fsp.readdir(path.join(app.dataDir, 'vault')).catch(() => []), []);
});

test('超过单张上限的图片被拒', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);
  const huge = Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]);

  const res = await upload(client, [{ filename: 'huge.png', data: huge }]);
  assert.equal(res.status, 400);
  assert.match(res.payload.error, /15MB/);
});

test('一次传多张：好的进库，坏的单独报错，不回滚已成功的', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const res = await upload(client, [
    { filename: 'ok-1.png', data: PNG },
    { filename: 'bad.png', data: Buffer.from('nope') },
    { filename: 'ok-2.png', data: PNG },
  ]);
  assert.equal(res.status, 201);
  assert.equal(res.payload.added.length, 2);
  assert.equal(res.payload.failed.length, 1);
  assert.equal(res.payload.failed[0].filename, 'bad.png');
  assert.equal((await client.request('/api/vault')).payload.total, 2);
});

test('从生成记录导入：字节与提示词一起搬过来', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const generation = await app.generations.add({
    prompt: '一只在雪地里的狐狸，超广角',
    model: 'doubao-seedream-4-0-20260415',
    buffer: PNG,
    ext: '.png',
    mime: 'image/png',
  });

  const res = await client.request('/api/vault/from-generation', {
    method: 'POST',
    body: { id: generation.id },
  });
  assert.equal(res.status, 201);
  assert.equal(res.payload.item.source, 'generation');
  assert.equal(res.payload.item.sourceId, generation.id);
  assert.equal(res.payload.item.prompt, '一只在雪地里的狐狸，超广角');
  assert.match(res.payload.item.title, /狐狸/);

  const file = await client.bytes(`/api/vault/${res.payload.item.id}/file`);
  assert.deepEqual(file.body, PNG);

  // 记录不存在时是 404，不是 500。
  const missing = await client.request('/api/vault/from-generation', {
    method: 'POST',
    body: { id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(missing.status, 404);
});

test('改名与标签、单删、批量删都会同步磁盘', async (t) => {
  const { base, app } = await boot(t);
  const client = await signIn(base);

  const first = (await upload(client, [{ filename: 'a.png', data: PNG }])).payload.added[0];
  const second = (await upload(client, [{ filename: 'b.png', data: PNG }])).payload.added[0];

  const patched = await client.request(`/api/vault/${first.id}`, {
    method: 'PATCH',
    body: { title: '改过的标题', tags: '标签一,标签二' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.payload.item.title, '改过的标题');
  assert.deepEqual(patched.payload.item.tags, ['标签一', '标签二']);

  const blank = await client.request(`/api/vault/${first.id}`, { method: 'PATCH', body: { title: '  ' } });
  assert.equal(blank.status, 400);

  const removed = await client.request(`/api/vault/${first.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  await assert.rejects(fsp.access(path.join(app.dataDir, 'vault', `${first.id}.png`)));

  const batch = await client.request('/api/vault/batch', {
    method: 'POST',
    body: { action: 'delete', ids: [second.id] },
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.payload.affected, 1);
  assert.equal((await client.request('/api/vault')).payload.total, 0);
});

test('上传必须带 multipart，JSON 请求会被 415 挡住', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);
  const res = await client.request('/api/vault/upload', { method: 'POST', body: { files: [] } });
  assert.equal(res.status, 415);
  assert.match(res.payload.error, /multipart/);
});

test('批量下载打成 zip：文件名带标题，内容与图库一致', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const one = (await upload(client, [{ filename: '海边.png', data: PNG }], { prompt: '海边' })).payload.added[0];
  const two = (await upload(client, [{ filename: '城市.png', data: PNG }])).payload.added[0];

  const response = await fetch(`${base}/api/vault/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: JSON.stringify({ ids: [one.id, two.id] }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(
    response.headers.get('content-disposition') || '',
    /^attachment; filename="still-gallery-vault-\d{8}-\d{4}\.zip"$/,
  );

  const entries = readZip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(entries.map((entry) => entry.name), ['01-海边.png', '02-城市.png']);
  assert.deepEqual(entries[0].data, PNG, '包里的字节必须和图库里的原图一致');

  // 未登录：不能因为「下载」就绕过鉴权。
  const anonymous = await fetch(`${base}/api/vault/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [one.id] }),
  });
  assert.equal(anonymous.status, 401);

  const empty = await client.request('/api/vault/archive', { method: 'POST', body: { ids: [] } });
  assert.equal(empty.status, 400);

  const missing = await client.request('/api/vault/archive', {
    method: 'POST',
    body: { ids: ['00000000-0000-0000-0000-000000000000'] },
  });
  assert.equal(missing.status, 404);
});
