import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

/** 启动一个隔离实例；不联网，也不 seed demo 数据。 */
async function boot(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-gallery-events-'));
  const app = createApp({ dataDir, seedDemo: false });
  await app.init();
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${address.port}` };
}

async function login(base) {
  const response = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'events-test-pass' }),
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()[0].split(';')[0];
}

test('/api/logs requires the administrator session', async (t) => {
  const { base } = await boot(t);
  const response = await fetch(`${base}/api/logs`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /登录/);
});

test('a rejected request shows up as a warn entry', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);

  // 未带 cookie 访问需要鉴权的接口 —— 应当被记成 warn，而不是静默丢掉。
  const denied = await fetch(`${base}/api/metrics`);
  assert.equal(denied.status, 401);

  const listed = await fetch(`${base}/api/logs?level=warn`, { headers: { cookie } });
  assert.equal(listed.status, 200);
  const payload = await listed.json();

  const entry = payload.entries.find((item) => item.message.includes('/api/metrics'));
  assert.ok(entry, '应当有一条关于 /api/metrics 的日志');
  assert.equal(entry.level, 'warn');
  assert.equal(entry.meta.status, 401);
  assert.equal(entry.scope, 'http');
});

test('the level filter is a floor, not an exact match', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);
  await fetch(`${base}/api/metrics`); // 401 → warn
  await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  }); // 401 → warn

  const errors = await (await fetch(`${base}/api/logs?level=error`, { headers: { cookie } })).json();
  const warns = await (await fetch(`${base}/api/logs?level=warn`, { headers: { cookie } })).json();
  const all = await (await fetch(`${base}/api/logs?level=debug`, { headers: { cookie } })).json();

  assert.equal(errors.entries.filter((e) => e.scope === 'http').length, 0);
  assert.ok(warns.entries.filter((e) => e.scope === 'http').length >= 2);
  // debug 是下限 0，所以必然包含 warn 的全部内容。
  assert.ok(all.entries.length >= warns.entries.length);
});

test('successful GETs stay out of the log, mutations do not', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);
  await fetch(`${base}/api/images`); // 200 的 GET：不记

  const payload = await (await fetch(`${base}/api/logs?level=debug`, { headers: { cookie } })).json();
  assert.equal(
    payload.entries.some((entry) => entry.message.includes('/api/images')),
    false,
    '成功的 GET 会把面板刷满，不该记',
  );
  assert.ok(
    payload.entries.some((entry) => entry.message.includes('POST /api/auth/setup')),
    '写操作必须留下痕迹',
  );
});

test('DELETE /api/logs clears the buffer and records the clear itself', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);
  await fetch(`${base}/api/metrics`);

  const cleared = await fetch(`${base}/api/logs`, { method: 'DELETE', headers: { cookie } });
  assert.equal(cleared.status, 200);
  const payload = await cleared.json();
  assert.ok(payload.removed >= 1);
  assert.equal(payload.size, 1, '清空后只剩「清空了 N 条」这一条');
  assert.match(payload.entries[0].message, /清空了/);
});

test('失败请求的日志里带着原因，而不只是一个状态码', async (t) => {
  const { base } = await boot(t);
  const cookie = await login(base);

  // 线上挂着 CDN 时，5xx 的响应体会被换成一张通用错误页，浏览器里只剩
  // 「请求失败（502）」。日志是唯一一定到得了运维眼前的地方，所以原因必须写在这里。
  const missing = await fetch(
    `${base}/api/generations/00000000-0000-4000-8000-000000000000/import`,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    },
  );
  assert.equal(missing.status, 404);

  const payload = await (await fetch(`${base}/api/logs?level=warn`, { headers: { cookie } })).json();
  const entry = payload.entries.find((item) => item.message.includes('/import'));
  assert.ok(entry, '失败请求必须留下日志');
  assert.match(entry.message, /→ 404/, '状态码要留着');
  assert.match(entry.message, /生成记录不存在/, '为什么失败也要写出来');
});

test('HTML and module imports carry a content version', async (t) => {
  const { base } = await boot(t);

  const html = await (await fetch(`${base}/admin.html`)).text();
  const script = html.match(/src="(\/admin\.js\?v=[0-9a-f]+)"/);
  const style = html.match(/href="(\/styles\.css\?v=[0-9a-f]+)"/);
  assert.ok(script, 'admin.js 的引用必须带 ?v=');
  assert.ok(style, 'styles.css 的引用必须带 ?v=');

  // 模块图也得跟着走：admin.js 静态 import 了 ui.js，只给入口打版本号会漏掉它。
  const js = await (await fetch(`${base}${script[1]}`)).text();
  assert.match(js, /from '\.\/ui\.js\?v=[0-9a-f]+'/);
});

test('static assets revalidate instead of being cached blindly', async (t) => {
  const { base } = await boot(t);

  const first = await fetch(`${base}/styles.css`);
  assert.equal(first.status, 200);
  // 资源名没有内容指纹，所以不能给长缓存：否则发布新版本后浏览器会拿旧 JS/CSS
  // 去配新 HTML，表现就是「按钮点了没反应」。
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag, '必须带 ETag 才能靠 304 省流量');

  const second = await fetch(`${base}/styles.css`, { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');

  // HTML 更严格：连条件请求都不缓存。
  const html = await fetch(`${base}/admin.html`);
  assert.equal(html.headers.get('cache-control'), 'no-store');
});
