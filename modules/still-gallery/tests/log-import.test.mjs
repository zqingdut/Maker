import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { SAMPLE_LOG, EXPECTED } from './log-fixture.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(96, 5),
]);

const PASSWORD = 'correct-horse-battery';

async function boot(t, { downloadImage, seedDemo = false } = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-log-'));
  const calls = [];
  const app = createApp({
    dataDir,
    seedDemo,
    downloadImage:
      downloadImage ||
      (async (url) => {
        calls.push(url);
        return {
          buffer: PNG,
          ext: '.png',
          mime: 'image/png',
          sourceUrl: url,
          finalUrl: url,
          bytes: PNG.length,
        };
      }),
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { app, base, dataDir, calls };
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

async function authed(base) {
  const client = makeClient(base);
  const setup = await client.request('/api/auth/setup', { method: 'POST', body: { password: PASSWORD } });
  assert.equal(setup.status, 200);
  return client;
}

test('log parsing requires an authenticated administrator', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);
  const response = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'a.log', logText: SAMPLE_LOG },
  });
  assert.equal(response.status, 401);
});

test('the dry run reports the plan without touching the network', async (t) => {
  const { base, calls } = await boot(t);
  const client = await authed(base);

  const response = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.stats.total, EXPECTED.total);
  assert.equal(response.payload.stats.withImage, EXPECTED.withImage);
  assert.equal(response.payload.plan.length, EXPECTED.withImage);
  assert.equal(response.payload.skipped.length, EXPECTED.withoutImage);
  assert.match(response.payload.skipped[0].reason, /未产出图片/);
  assert.equal(calls.length, 0, 'a dry run must not download anything');

  const [first] = response.payload.plan;
  assert.equal(first.index, 1);
  assert.equal(first.title, '画一只坐在窗台上的橘猫');
  assert.equal(first.mode, 'text2image');
  assert.equal(first.imageModel, 'doubao-seedream-4-0-20260415');
  assert.equal(first.alreadyImported, false);
  assert.equal(first.urlExpired, false);
  assert.equal(first.imageUrl, EXPECTED.urls[0]);

  const third = response.payload.plan[2];
  assert.equal(third.mode, 'image2image');
});

test('import downloads each image and links it to the parsed prompt', async (t) => {
  const { base, dataDir, calls } = await boot(t);
  const client = await authed(base);

  const response = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG, tags: ['白板智能体'] },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.imported.length, 3);
  assert.equal(response.payload.failed.length, 0);
  assert.equal(response.payload.skipped.length, 1);
  assert.deepEqual(calls, EXPECTED.urls);

  const list = await client.request('/api/images');
  assert.equal(list.payload.images.length, 3);

  const cat = list.payload.images.find((image) => image.title === '画一只坐在窗台上的橘猫');
  assert.ok(cat, 'the parsed entry should be in the gallery');
  assert.equal(cat.prompt, '一只橘猫坐在木质窗台上，午后阳光斜照，赛璐珞简笔漫画风格');
  assert.equal(cat.sourceUrl, EXPECTED.urls[0]);
  assert.match(cat.imageUrl, /^\/uploads\/[0-9a-f-]+\.png$/);
  assert.equal(cat.model, 'doubao-seedream-4-0-20260415');
  assert.deepEqual(cat.tags, ['白板智能体', '文生图']);
  assert.equal(cat.provenance.source, 'whiteboard_agent.log');
  assert.equal(cat.provenance.sessionId, '111111111');
  assert.equal(cat.provenance.latencySeconds, 64.93);
  assert.deepEqual(cat.provenance.tokens, { prompt: 4714, completion: 2372, total: 7086 });

  const onDisk = path.join(dataDir, 'uploads', path.basename(cat.imageUrl));
  assert.equal(fs.existsSync(onDisk), true);

  const served = await fetch(`${base}${cat.imageUrl}`);
  assert.equal(served.status, 200);
});

test('re-importing the same log skips entries that are already stored', async (t) => {
  const { base, calls } = await boot(t);
  const client = await authed(base);

  const first = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });
  assert.equal(first.payload.imported.length, 3);

  const second = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });
  assert.equal(second.payload.imported.length, 0);
  assert.equal(second.payload.skipped.length, 4, '3 already stored plus 1 without an image');
  assert.ok(second.payload.skipped.some((item) => item.reason.includes('已在库中')));
  assert.equal(calls.length, 3, 'no extra downloads on the second pass');

  const preview = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });
  assert.equal(preview.payload.plan.every((item) => item.alreadyImported), true);
});

test('sessionIndexes narrows an import to the selected rows', async (t) => {
  const { base, calls } = await boot(t);
  const client = await authed(base);

  const response = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG, sessionIndexes: [1, 3] },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.imported.length, 2);
  assert.deepEqual(calls, [EXPECTED.urls[0], EXPECTED.urls[2]]);

  const list = await client.request('/api/images');
  assert.deepEqual(
    list.payload.images.map((image) => image.title).sort(),
    ['画一只坐在窗台上的橘猫', '把背景改成夜晚'].sort(),
  );
});

test('a failing download is reported per item instead of aborting the batch', async (t) => {
  const { base } = await boot(t, {
    downloadImage: async (url) => {
      if (url.includes('house')) {
        const { DownloadError } = await import('../lib/downloader.mjs');
        throw new DownloadError('图片来源返回状态码 403', 502);
      }
      return {
        buffer: PNG,
        ext: '.png',
        mime: 'image/png',
        sourceUrl: url,
        finalUrl: url,
        bytes: PNG.length,
      };
    },
  });
  const client = await authed(base);

  const response = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.imported.length, 2);
  assert.equal(response.payload.failed.length, 1);
  assert.match(response.payload.failed[0].reason, /403/);

  const list = await client.request('/api/images');
  assert.equal(list.payload.images.length, 2, 'the good items still land');
});

test('a failed download leaves no orphan file behind', async (t) => {
  const { base, dataDir } = await boot(t, {
    downloadImage: async () => {
      const { DownloadError } = await import('../lib/downloader.mjs');
      throw new DownloadError('下载图片失败：连接被重置', 502);
    },
  });
  const client = await authed(base);

  const response = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });
  assert.equal(response.payload.imported.length, 0);
  assert.equal(response.payload.failed.length, 3);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'uploads')), []);

  const list = await client.request('/api/images');
  assert.deepEqual(list.payload.images, []);
});

test('log uploads are validated', async (t) => {
  const { base } = await boot(t);
  const client = await authed(base);

  const empty = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'x.log', logText: '   ' },
  });
  assert.equal(empty.status, 400);

  const noFile = await client.request('/api/logs/parse', { method: 'POST', body: {} });
  assert.equal(noFile.status, 400);

  const oversized = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'x.log', logText: 'a'.repeat(17 * 1024 * 1024) },
  });
  assert.equal(oversized.status, 413);

  const crossOrigin = await client.request('/api/logs/parse', {
    method: 'POST',
    body: { fileName: 'x.log', logText: SAMPLE_LOG },
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(crossOrigin.status, 403);
});

test('a log with no generation markers imports nothing and explains why', async (t) => {
  const { base } = await boot(t);
  const client = await authed(base);

  const response = await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'unrelated.log', logText: '2026-09-17 10:00:00,000 INFO boot: starting up\n' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.payload.imported.length, 0);
  assert.equal(response.payload.failed.length, 0);
  assert.equal(response.payload.stats.total, 0);
});

test('exported entries carry their provenance', async (t) => {
  const { base } = await boot(t);
  const client = await authed(base);
  await client.request('/api/logs/import', {
    method: 'POST',
    body: { fileName: 'whiteboard_agent.log', logText: SAMPLE_LOG },
  });

  const exported = await client.request('/api/export');
  assert.equal(exported.payload.images.length, 3);
  const withSource = exported.payload.images.find((image) => image.provenance);
  assert.equal(withSource.provenance.source, 'whiteboard_agent.log');
  assert.ok(withSource.sourceUrl.startsWith('https://cdn.example.com/'));
});
