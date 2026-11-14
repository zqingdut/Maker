import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { ARK_DEFAULT_MODEL, GenerationError } from '../lib/image-gen.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(128, 3),
]);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const PASSWORD = 'correct-horse-battery';

/** The shape the real client returns, so the queue can be exercised offline. */
function fakeGeneration(overrides = {}) {
  return {
    model: ARK_DEFAULT_MODEL,
    created: 1782203831,
    images: [
      {
        url: 'https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com/a.png?X-Tos-Date=20260930T020000Z&X-Tos-Expires=86400',
        b64: '',
        size: '2048x2048',
        expiresAt: '2026-10-01T02:00:00.000Z',
      },
    ],
    usage: { generated_images: 1 },
    request: {
      mode: 'text2image',
      model: ARK_DEFAULT_MODEL,
      size: '2K',
      optimizeMode: '',
      outputFormat: '',
      background: '',
      group: false,
      webSearch: false,
      watermark: false,
      referenceCount: 0,
      referenceKind: 'none',
      maxImages: 1,
    },
    generatedAt: '2026-09-30T02:00:00.000Z',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
    ...overrides,
  };
}

/** A promise plus its resolver, for holding a job inside the stub. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Boot the app with a stubbed generation client. Nothing here ever reaches Ark,
 * so the whole file runs without spending anything.
 *
 * `cleanup` defaults to "own the directory" — pass an existing `dataDir` and set
 * it explicitly if you want it removed afterwards.
 */
async function boot(t, { generateImages, dataDir: reuse, cleanup = !reuse } = {}) {
  const savedEnv = process.env.ARK_API_KEY;
  delete process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'test-key-never-sent';

  const dataDir = reuse || (await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-queue-')));
  const calls = [];
  const probe = { maxConcurrent: 0, concurrent: 0 };

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
    generateImages: async (input, config) => {
      calls.push({ input, config });
      probe.concurrent += 1;
      probe.maxConcurrent = Math.max(probe.maxConcurrent, probe.concurrent);
      try {
        return await (generateImages ? generateImages(input, config, calls.length) : fakeGeneration());
      } finally {
        probe.concurrent -= 1;
      }
    },
  });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    // Drain in-flight writes before tearing the directory down. Metrics are
    // persisted fire-and-forget, so a rename can still be in flight here and
    // `rm` would race it (ENOTEMPTY). Retries are the belt to flush()'s braces.
    await app.flush();
    await app.close();
    if (cleanup) {
      await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    if (savedEnv === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = savedEnv;
  });

  return { app, base, dataDir, calls, probe };
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
      return { status: response.status, payload, headers: response.headers };
    },
  };
}

/** `setup` works once per data directory; every later boot has to log in. */
async function signIn(base, { existing = false } = {}) {
  const client = makeClient(base);
  const response = await client.request(existing ? '/api/auth/login' : '/api/auth/setup', {
    method: 'POST',
    body: { password: PASSWORD },
  });
  assert.equal(response.status, 200);
  return client;
}

const enqueue = (client, overrides = {}) =>
  client.request('/api/generate/queue', {
    method: 'POST',
    body: { prompt: '一只橘猫', mode: 'text2image', ...overrides },
  });

/** 改并发走的是和界面同一个接口，顺带把它也测了。 */
async function setConcurrency(client, value) {
  const response = await client.request('/api/generate/config', {
    method: 'PUT',
    body: { queueConcurrency: value },
  });
  assert.equal(response.status, 200, `设置并发 ${value} 应该成功`);
  return response;
}

/* ================================================================== *
 * the happy path
 * ================================================================== */

test('a queued job runs, keeps its bitmaps, and exposes a preview handle', async (t) => {
  const { app, base } = await boot(t);
  const client = await signIn(base);

  const queued = await enqueue(client);
  assert.equal(queued.status, 202);
  assert.ok(queued.payload.job.id);
  assert.ok(['queued', 'running'].includes(queued.payload.job.status));

  await app.queue.whenIdle();

  const snapshot = await client.request('/api/generate/queue');
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.payload.jobs.length, 1);
  const [job] = snapshot.payload.jobs;
  assert.equal(job.status, 'done');
  assert.equal(job.result.images.length, 1);
  assert.equal(job.result.model, ARK_DEFAULT_MODEL);
  assert.match(job.result.images[0].previewUrl, /^\/api\/generate\/preview\/[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(job.durationMs) && job.durationMs >= 0);
  assert.equal(snapshot.payload.settled, 1);
  assert.equal(snapshot.payload.pending, 0);
});

test('a queued bitmap can be previewed and imported through the normal routes', async (t) => {
  const { app, base } = await boot(t);
  const client = await signIn(base);

  await enqueue(client);
  await app.queue.whenIdle();

  const snapshot = await client.request('/api/generate/queue');
  const image = snapshot.payload.jobs[0].result.images[0];

  const preview = await client.request(image.previewUrl);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'image/png');

  const imported = await client.request('/api/images', {
    method: 'POST',
    body: {
      url: image.url,
      title: '来自队列',
      prompt: '一只橘猫',
      model: ARK_DEFAULT_MODEL,
      provenance: { source: 'AI 生成', queueJobId: snapshot.payload.jobs[0].id },
    },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.image.provenance.source, 'AI 生成');
  // The queue id has to survive the provenance whitelist, or the record cannot
  // be traced back to the job that produced it.
  assert.equal(imported.payload.image.provenance.queueJobId, snapshot.payload.jobs[0].id);
});

test('the queue runs up to eight jobs at once by default', async (t) => {
  const gate = deferred();
  const { app, base, probe } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await enqueue(client)).status, 202);
  }
  const before = await client.request('/api/generate/queue');
  assert.equal(before.payload.concurrency, 8, '默认并发是 8');
  assert.equal(before.payload.running, 8, '八个任务同时在飞');
  assert.equal(before.payload.pending, 2, '多出来的两个排队');

  gate.resolve();
  await app.queue.whenIdle();

  assert.equal(probe.maxConcurrent, 8, '桩最多同时看到八个调用');
  const after = await client.request('/api/generate/queue');
  assert.equal(after.payload.jobs.filter((job) => job.status === 'done').length, 10);
});

test('lowering the concurrency only affects jobs that have not started', async (t) => {
  const gate = deferred();
  const { app, base, probe } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await enqueue(client)).status, 202);
  }
  assert.equal((await client.request('/api/generate/queue')).payload.running, 5);

  // 调到 2：已经在跑的 5 个必须跑完（已经计费），只是不再新起。
  const updated = await setConcurrency(client, 2);
  assert.equal(updated.payload.limits.queueConcurrency, 2);
  const mid = await client.request('/api/generate/queue');
  assert.equal(mid.payload.running, 5, '在飞的任务不受影响');
  assert.equal(mid.payload.concurrency, 2);

  gate.resolve();
  await app.queue.whenIdle();
  assert.equal(probe.maxConcurrent, 5, '调低不会打断已经发出去的请求');
});

test('raising the concurrency starts waiting jobs immediately', async (t) => {
  const gate = deferred();
  const { app, base } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);
  await setConcurrency(client, 1);

  for (let index = 0; index < 4; index += 1) {
    assert.equal((await enqueue(client)).status, 202);
  }
  const before = await client.request('/api/generate/queue');
  assert.equal(before.payload.running, 1);
  assert.equal(before.payload.pending, 3);

  await setConcurrency(client, 4);
  const after = await client.request('/api/generate/queue');
  assert.equal(after.payload.running, 4, '调大后立刻把排队的拉起来');
  assert.equal(after.payload.pending, 0);

  gate.resolve();
  await app.queue.whenIdle();
});

test('a concurrency outside 1–32 is refused, not silently clamped', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  for (const value of [0, -3, 33, 2.5, 'abc']) {
    const response = await client.request('/api/generate/config', {
      method: 'PUT',
      body: { queueConcurrency: value },
    });
    assert.equal(response.status, 400, `${JSON.stringify(value)} 应该被拒绝`);
  }

  // 拒绝之后设置仍然是原来的值。
  const config = await client.request('/api/generate/config');
  assert.equal(config.payload.limits.queueConcurrency, 8);
  assert.equal(config.payload.limits.queueConcurrencyMax, 32);
});

test('a busy round evicts the oldest preview handles, not the newest', async (t) => {
  // 13 个任务 × 10 张 = 130 个预览令牌，超过 120 的容量上限。原来的 60 会在
  // 并发 8 的一轮里就把先完成的那几张挤掉，表现为图片 404、预览空白。
  const images = Array.from({ length: 10 }, (_, index) => ({
    url: `https://x.tos-cn-beijing.volces.com/${index}.png?X-Tos-Date=20260930T020000Z&X-Tos-Expires=86400`,
    b64: '',
    size: '2048x2048',
    expiresAt: '2026-10-01T02:00:00.000Z',
  }));
  const { app, base } = await boot(t, {
    generateImages: async () =>
      fakeGeneration({
        images,
        request: { ...fakeGeneration().request, mode: 'text2group', group: true, maxImages: 10 },
      }),
  });
  const client = await signIn(base);
  await setConcurrency(client, 16);

  for (let index = 0; index < 13; index += 1) {
    assert.equal((await enqueue(client, { mode: 'text2group', maxImages: 10 })).status, 202);
  }
  await app.queue.whenIdle();

  const snapshot = await client.request('/api/generate/queue');
  const done = snapshot.payload.jobs.filter((job) => job.status === 'done');
  assert.equal(done.length, 13);

  const handles = done.flatMap((job) => job.result.images.map((image) => image.previewUrl));
  assert.equal(handles.length, 130);

  let alive = 0;
  for (const handle of handles) {
    if ((await client.request(handle)).status === 200) alive += 1;
  }
  assert.equal(alive, 120, '容量 120 个，多出来的 10 个按最旧淘汰');
});

/* ================================================================== *
 * cancellation
 * ================================================================== */

test('a queued job can be cancelled before it ever reaches the upstream', async (t) => {
  const gate = deferred();
  const { app, base, calls } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);
  // 串行才能确定「第二个还没开始」。
  await setConcurrency(client, 1);

  await enqueue(client);
  const second = await enqueue(client);
  assert.equal(second.payload.job.status, 'queued');

  const cancelled = await client.request('/api/generate/queue/cancel', {
    method: 'POST',
    body: { id: second.payload.job.id },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.payload.job.status, 'canceled');

  gate.resolve();
  await app.queue.whenIdle();

  assert.equal(calls.length, 1, 'the cancelled job was never sent upstream');
  const snapshot = await client.request('/api/generate/queue');
  const statuses = snapshot.payload.jobs.map((job) => job.status).sort();
  assert.deepEqual(statuses, ['canceled', 'done']);
});

test('a running job refuses cancellation because it is already billed', async (t) => {
  const gate = deferred();
  const { app, base } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);

  const first = await enqueue(client);
  const refused = await client.request('/api/generate/queue/cancel', {
    method: 'POST',
    body: { id: first.payload.job.id },
  });
  assert.equal(refused.status, 409);
  assert.match(refused.payload.error, /已开始执行/);

  gate.resolve();
  await app.queue.whenIdle();
});

test('cancelling an unknown job is a 404, not a silent success', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);
  const missing = await client.request('/api/generate/queue/cancel', {
    method: 'POST',
    body: { id: 'job-nope' },
  });
  assert.equal(missing.status, 404);
});

/* ================================================================== *
 * pause / resume
 * ================================================================== */

test('pausing holds new jobs back and resuming releases them', async (t) => {
  const { app, base, calls } = await boot(t);
  const client = await signIn(base);

  const paused = await client.request('/api/generate/queue/pause', {
    method: 'POST',
    body: { paused: true },
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.payload.paused, true);

  await enqueue(client);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, 0, 'nothing is sent while paused');

  const snapshot = await client.request('/api/generate/queue');
  assert.equal(snapshot.payload.pending, 1);
  assert.equal(snapshot.payload.paused, true);

  const resumed = await client.request('/api/generate/queue/pause', {
    method: 'POST',
    body: { paused: false },
  });
  assert.equal(resumed.payload.paused, false);

  await app.queue.whenIdle();
  assert.equal(calls.length, 1);
});

/* ================================================================== *
 * validation and limits
 * ================================================================== */

test('an invalid job is refused at enqueue time and never costs anything', async (t) => {
  const { app, base, calls } = await boot(t);
  const client = await signIn(base);

  const bad = await enqueue(client, { mode: 'text2everything' });
  assert.equal(bad.status, 400);
  assert.match(bad.payload.error, /生成模式/);

  const empty = await enqueue(client, { prompt: '' });
  assert.equal(empty.status, 400);

  await app.queue.whenIdle();
  assert.equal(calls.length, 0);

  const snapshot = await client.request('/api/generate/queue');
  assert.deepEqual(snapshot.payload.jobs, []);
});

test('the queue refuses to grow past its pending ceiling', async (t) => {
  const gate = deferred();
  const { app, base } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);

  const first = await client.request('/api/generate/queue');
  const ceiling = first.payload.maxPending;
  assert.ok(ceiling > 0);

  for (let index = 0; index < ceiling; index += 1) {
    assert.equal((await enqueue(client)).status, 202, `job ${index + 1} should be accepted`);
  }
  const overflow = await enqueue(client);
  assert.equal(overflow.status, 429);
  assert.match(overflow.payload.error, /队列已满/);

  gate.resolve();
  await app.queue.whenIdle();
});

test('the queue snapshot never carries reference images back to the browser', async (t) => {
  const { app, base } = await boot(t);
  const client = await signIn(base);

  await enqueue(client, {
    mode: 'image2image',
    referenceImages: [PNG_DATA_URL],
  });
  await app.queue.whenIdle();

  const snapshot = await client.request('/api/generate/queue');
  const serialised = JSON.stringify(snapshot.payload);
  assert.ok(!serialised.includes('data:image'), 'base64 payloads must not be echoed');
  assert.ok(!serialised.includes('referenceImages'));
  assert.equal(snapshot.payload.jobs[0].label.referenceCount, 1);
  // The prompt has to survive intact — importing a finished job stores it.
  assert.equal(snapshot.payload.jobs[0].label.prompt, '一只橘猫');
});

/* ================================================================== *
 * clearing
 * ================================================================== */

test('settled jobs can be cleared or removed, running ones cannot', async (t) => {
  const gate = deferred();
  const { app, base } = await boot(t, {
    generateImages: async () => {
      await gate.promise;
      return fakeGeneration();
    },
  });
  const client = await signIn(base);

  const running = await enqueue(client);
  const refused = await client.request('/api/generate/queue/remove', {
    method: 'POST',
    body: { id: running.payload.job.id },
  });
  assert.equal(refused.status, 409);

  gate.resolve();
  await app.queue.whenIdle();

  const cleared = await client.request('/api/generate/queue/clear', {
    method: 'POST',
    body: {},
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.removed, 1);
  assert.deepEqual(cleared.payload.queue.jobs, []);
});

/* ================================================================== *
 * metrics
 * ================================================================== */

test('both direct and queued runs feed the same per-model average', async (t) => {
  const { app, base, calls } = await boot(t);
  const client = await signIn(base);

  const direct = await client.request('/api/generate', {
    method: 'POST',
    body: { prompt: '直接生成', mode: 'text2image' },
  });
  assert.equal(direct.status, 200);

  await enqueue(client);
  await app.queue.whenIdle();
  assert.equal(calls.length, 2);

  const report = await client.request('/api/metrics');
  assert.equal(report.status, 200);
  assert.equal(report.payload.overall.runs, 2);
  assert.equal(report.payload.overall.ok, 2);
  assert.equal(report.payload.overall.images, 2);

  const [row] = report.payload.models;
  assert.equal(row.model, ARK_DEFAULT_MODEL);
  assert.equal(row.runs, 2);
  assert.equal(row.ok, 2);
  assert.ok(row.avgMs >= 0, 'the average is a real number');
  assert.equal(row.avgMsPerImage, row.avgMs, 'one image per request, so they agree');

  // Every produced bitmap gets a line, and a single-image run is a measured one.
  assert.equal(report.payload.images.length, 2);
  assert.ok(report.payload.images.every((image) => image.measured === true));
  assert.ok(report.payload.recent.some((entry) => entry.source === 'queue'));
  assert.ok(report.payload.recent.some((entry) => entry.source === 'direct'));

  // The queue rides along so the tab can show both without a second request.
  assert.ok(report.payload.queue);
  assert.equal(report.payload.queue.settled, 1);
});

test('a group request is apportioned across its bitmaps, and marked as such', async (t) => {
  const { app, base } = await boot(t, {
    generateImages: async () =>
      fakeGeneration({
        images: [1, 2, 3].map((index) => ({
          url: `https://x.tos-cn-beijing.volces.com/${index}.png?X-Tos-Date=20260930T020000Z&X-Tos-Expires=86400`,
          b64: '',
          size: '2048x2048',
          expiresAt: '2026-10-01T02:00:00.000Z',
        })),
        request: { ...fakeGeneration().request, mode: 'text2group', group: true, maxImages: 3 },
      }),
  });
  const client = await signIn(base);

  const queued = await enqueue(client, { mode: 'text2group', maxImages: 3 });
  assert.equal(queued.status, 202);
  await app.queue.whenIdle();

  const report = await client.request('/api/metrics');
  const [row] = report.payload.models;
  assert.equal(row.images, 3);
  assert.equal(row.avgMsPerImage, Math.round((row.avgMs / 3) * 10) / 10);

  assert.equal(report.payload.images.length, 3);
  assert.ok(
    report.payload.images.every((image) => image.measured === false),
    'a group batch shares one upstream clock',
  );
  assert.deepEqual(
    report.payload.images.map((image) => image.total),
    [3, 3, 3],
  );
});

test('a failed attempt is recorded, and does not drag the average down', async (t) => {
  const { base } = await boot(t, {
    generateImages: async () => {
      throw new GenerationError('生图服务暂时不可用（HTTP 503）', 502);
    },
  });
  const client = await signIn(base);

  const failed = await client.request('/api/generate', {
    method: 'POST',
    body: { prompt: '会失败的请求', mode: 'text2image', size: '2K' },
  });
  assert.equal(failed.status, 502);

  const report = await client.request('/api/metrics');
  assert.equal(report.payload.overall.runs, 1);
  assert.equal(report.payload.overall.failed, 1);
  assert.equal(report.payload.overall.images, 0);
  assert.equal(report.payload.models[0].avgMs, null, 'no success means no average');
  assert.equal(report.payload.models[0].successRate, 0);
  assert.match(report.payload.models[0].lastError, /503/);
  assert.deepEqual(report.payload.images, []);

  // A failed attempt has no response to read the request back out of, so the
  // sample has to carry what we *asked* for — otherwise the log row shows an
  // unknown model and a blank size.
  const [entry] = report.payload.recent;
  assert.equal(entry.model, ARK_DEFAULT_MODEL);
  assert.equal(entry.size, '2K');
  assert.equal(entry.mode, 'text2image');
  assert.equal(entry.imageCount, 0);
});

test('metrics history can be cleared without touching the library', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  await client.request('/api/generate', {
    method: 'POST',
    body: { prompt: '先攒一条样本', mode: 'text2image' },
  });

  const cleared = await client.request('/api/metrics', { method: 'DELETE' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.overall.runs, 0);
  assert.deepEqual(cleared.payload.models, []);

  const after = await client.request('/api/metrics');
  assert.equal(after.payload.overall.runs, 0);
});

/* ================================================================== *
 * persistence and access control
 * ================================================================== */

test('timing samples survive a restart', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-queue-'));
  const first = await boot(t, { dataDir, cleanup: true });
  const client = await signIn(first.base);
  await client.request('/api/generate', {
    method: 'POST',
    body: { prompt: '写入一条样本', mode: 'text2image' },
  });

  await first.app.flush();

  const metricsFile = path.join(dataDir, 'metrics.json');
  const stored = JSON.parse(await fsp.readFile(metricsFile, 'utf8'));
  assert.equal(stored.samples.length, 1);
  assert.equal(stored.samples[0].model, ARK_DEFAULT_MODEL);
  assert.equal(stored.samples[0].ok, true);

  await first.app.close();

  const second = await boot(t, { dataDir, cleanup: false });
  const secondClient = await signIn(second.base, { existing: true });
  const report = await secondClient.request('/api/metrics');
  assert.equal(report.payload.overall.runs, 1, 'the sample was reloaded from disk');
  assert.equal(report.payload.models[0].model, ARK_DEFAULT_MODEL);
});

test('a corrupt metrics file degrades to an empty history instead of crashing', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-queue-'));
  await fsp.writeFile(path.join(dataDir, 'metrics.json'), '{ this is not json', 'utf8');

  const { base } = await boot(t, { dataDir, cleanup: true });
  const client = await signIn(base);
  const report = await client.request('/api/metrics');
  assert.equal(report.status, 200);
  assert.equal(report.payload.overall.runs, 0);
});

test('the queue and metrics routes are closed to anonymous callers', async (t) => {
  const { base } = await boot(t);
  const client = makeClient(base);

  for (const [pathname, method] of [
    ['/api/generate/queue', 'GET'],
    ['/api/metrics', 'GET'],
    ['/api/metrics', 'DELETE'],
  ]) {
    const response = await client.request(pathname, { method });
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }

  const queued = await client.request('/api/generate/queue', {
    method: 'POST',
    body: { prompt: 'x', mode: 'text2image' },
  });
  assert.equal(queued.status, 401);
});

test('write-shaped queue actions reject a cross-site origin', async (t) => {
  const { base } = await boot(t);
  const client = await signIn(base);

  const forged = await client.request('/api/generate/queue/pause', {
    method: 'POST',
    body: { paused: true },
    headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(forged.status, 403);
});
