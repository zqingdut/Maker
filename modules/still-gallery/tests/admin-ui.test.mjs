/**
 * Structural guards for the admin console, where the failure mode is silent.
 *
 * There is no DOM in this test runner, so these are static checks — but they
 * cover exactly the class of bug that produces "I clicked it and nothing
 * happened", which is invisible to the API tests:
 *
 *   1. A tab button with no panel (or a panel with no tab) switches to nothing.
 *   2. `getElementById('typo')` returns null, and the very next line —
 *      `node.hidden = ...` — throws. Everything after it in that function is
 *      skipped, so the UI ends up half-switched with no error on screen.
 *      A missing id is the cheapest possible cause of a half-dead panel.
 *   3. Panel switching is implemented purely with the `hidden` attribute, which
 *      only works because the stylesheet outranks the user-agent rule. Lose
 *      that one declaration and every panel shows at once.
 *
 * The tab list used to live in a hand-written array in admin.js. When
 * 「生成记录」 and 「运行日志」 were added to the HTML but not to that array,
 * clicking them fell back to 'generate' — the click "did nothing". The set is
 * now read from the DOM, and this file keeps the two sides honest.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8');
const styles = fs.readFileSync(path.join(ROOT, 'public/styles.css'), 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const tabNames = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
const panelIds = [...html.matchAll(/id="(panel-[^"]+)"/g)].map((match) => match[1]);

test('every tab button has a panel, and every panel has a tab button', () => {
  const orphans = tabNames.filter((name) => !ids.has(`panel-${name}`));
  assert.deepEqual(orphans, [], `标签没有对应面板：${orphans.join(', ')}`);

  const loose = panelIds.filter((id) => !tabNames.includes(id.slice('panel-'.length)));
  assert.deepEqual(loose, [], `面板没有对应标签：${loose.join(', ')}`);
});

test('the tab set is read from the DOM rather than duplicated in JS', () => {
  // A hardcoded copy is what silently swallowed the two newest tabs. If this
  // array ever comes back, the next panel added will be dead on arrival.
  assert.equal(
    /const TAB_NAMES\s*=/.test(adminJs),
    false,
    'admin.js 不应再维护一份写死的标签名数组，setTab 要从 DOM 读',
  );
  assert.match(adminJs, /function tabNames\(\)/, 'setTab 需要一个从 DOM 收集标签名的函数');
});

test('every getElementById literal in admin.js exists in admin.html', () => {
  // Matches both quote styles; template literals are dynamic and skipped.
  const refs = [...adminJs.matchAll(/getElementById\(\s*(['"])([^'"]+)\1\s*\)/g)].map((match) => match[2]);
  assert.ok(refs.length > 100, `应该扫到大量引用，实际只有 ${refs.length} 个`);

  const missing = [...new Set(refs)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `admin.js 引用了不存在的 id：${missing.join(', ')}`);
});

test('the provider switch has a button for each branch the code handles', () => {
  const providers = [...html.matchAll(/data-provider="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(providers.sort(), ['ark', 'relay']);

  // The 01ai side owns a parameter block of its own; the Seedream-only fields
  // must be referenced by applyProvider() so they can be hidden.
  for (const id of ['genRelayParams', 'genRelayModel', 'genRelayAspects', 'genRelayPrompt', 'genRelayRefs']) {
    assert.ok(ids.has(id), `缺少网关参数区块的元素 ${id}`);
    assert.ok(adminJs.includes(id), `applyProvider 没有填充 ${id}`);
  }
  assert.match(html, /id="genRelayParams"[^>]*hidden/, '网关参数区块默认应该是隐藏的');
});

test('the gateway parameter block lists only channels the gateway accepts', () => {
  const block = html.slice(html.indexOf('id="genRelayParams"'), html.indexOf('id="genModelNote"'));
  assert.ok(block.length > 0, '找不到网关参数区块');

  // These are the five parameters the relay actually forwards. Anything from
  // the Seedream row (模型下拉 / 尺寸档 / 优化 / 输出格式 / 背景 / 联网) showing
  // up here again would mean the two UIs have been merged back together.
  for (const label of ['模型', '画幅', '提示词', '参考图', '出图']) {
    assert.ok(block.includes(label), `网关参数区块缺少「${label}」`);
  }
  for (const forbidden of ['尺寸', '优化', '联网']) {
    assert.equal(block.includes(forbidden), false, `网关参数区块不应出现「${forbidden}」`);
  }
});

test('panel switching can actually hide a panel', () => {
  // `.tab-panel` and friends set display, and any author rule beats the
  // user-agent [hidden] rule. Without this !important every panel renders at
  // once and the tab bar appears to do nothing.
  assert.match(
    styles,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    '[hidden] 必须带 display:none !important，否则标签页切换会失效',
  );
});

test('the run-log panel opens on a level that has something to show', () => {
  // Defaulting to 警告以上 means a healthy server renders an empty list, which
  // reads as "the tab did nothing".
  const select = html.slice(html.indexOf('id="eventLevel"'), html.indexOf('</select>', html.indexOf('id="eventLevel"')));
  assert.match(select, /value="info"\s+selected/, '运行日志默认级别应为 info 以上');
});

test('the prompt history lives beside the prompt box and holds ten entries', () => {
  // 「提示词旁」是需求本身：列表和输入框必须在同一个布局块里并排，散到别处就不算。
  const start = html.indexOf('class="prompt-layout"');
  const layout = html.slice(start, html.indexOf('id="genModelField"', start));
  assert.ok(start > 0, '找不到 .prompt-layout');
  assert.ok(layout.includes('id="genPrompt"'), '提示词输入框应该在 .prompt-layout 里');
  assert.ok(layout.includes('id="promptHistory"'), '提示词记录应该和输入框并排');

  assert.match(adminJs, /PROMPT_HISTORY_MAX\s*=\s*10/, '容量必须是 10 条');
  // 提示词是这台机器上的草稿，只进 localStorage；落盘到服务端就多一处泄漏点。
  assert.match(adminJs, /PROMPT_HISTORY_KEY\s*=\s*'still-gallery:prompt-history'/);
  // 先进先出：新的一条放最前，超出容量从尾部裁掉。
  assert.match(adminJs, /\.slice\(0, PROMPT_HISTORY_MAX\)/, '超出容量要按先进先出裁掉最旧的');
});
