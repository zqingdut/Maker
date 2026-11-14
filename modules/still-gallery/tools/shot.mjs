/**
 * Drive a headless Chromium over the DevTools protocol to capture a screenshot
 * of a page, optionally pre-seeding a session cookie and exercising the UI
 * (set a file input, click buttons, run a script) so protected or interactive
 * screens can be verified.
 *
 *   node tools/shot.mjs --url <url> --out <file>
 *     [--cookie name=value] [--width 1400] [--height 1100] [--wait 1500]
 *     [--file "#input=path"] [--click "#selector"] [--drag "x1,y1,x2,y2"]
 *     [--script "js"] [--sleep 3000] [--settle 1500] [--viewport-only]
 *
 * --file, --click, --drag, --script and --sleep may each be repeated and run in
 * the order given. `--sleep` waits *between* steps; `--settle` waits once after
 * the last step, before the screenshot. Mixing those two up is how a probe ends
 * up reading the state from 400 ms ago and looks like a dead button.
 *
 * --drag drives real mouse events through the input domain, so pointer capture
 * and drag thresholds behave as they do for a user; synthetic PointerEvents
 * cannot do that (setPointerCapture rejects them).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
function argAll(name) {
  const out = [];
  args.forEach((value, index) => {
    if (value === `--${name}`) out.push(args[index + 1]);
  });
  return out;
}

const url = arg('url');
const out = arg('out', 'shot.png');
const cookie = arg('cookie');
const width = Number(arg('width', 1400));
const height = Number(arg('height', 1100));
const waitMs = Number(arg('wait', 1600));
const settleMs = Number(arg('settle', 2500));
const stepDelay = Number(arg('step-delay', 400));
const port = Number(arg('port', 9333));
/**
 * Chrome's `captureBeyondViewport` re-composites the page and mis-paints
 * anything that overlaps another stacking context — an absolutely positioned
 * dropdown ends up showing the text underneath it. Pass --viewport-only when
 * the shot is about an overlay rather than the full scroll height.
 */
const viewportOnly = args.includes('--viewport-only');

/** Ordered UI actions taken from the raw argv so they run in the given order. */
const steps = [];
args.forEach((value, index) => {
  if (value === '--file') steps.push({ kind: 'file', value: args[index + 1] });
  if (value === '--click') steps.push({ kind: 'click', value: args[index + 1] });
  if (value === '--drag') steps.push({ kind: 'drag', value: args[index + 1] });
  if (value === '--script') steps.push({ kind: 'script', value: args[index + 1] });
  if (value === '--sleep') steps.push({ kind: 'sleep', value: args[index + 1] });
});

if (!url) {
  console.error('usage: node tools/shot.mjs --url <url> --out <file> [--cookie name=value] [--file "#input=path"] [--click "#sel"] [--script "js"]');
  process.exit(1);
}

const CANDIDATES = [
  path.join(os.homedir(), 'Library/Caches/ms-playwright'),
  path.join(os.homedir(), '.cache/ms-playwright'),
];

async function findBrowser() {
  for (const root of CANDIDATES) {
    let entries = [];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort().reverse()) {
      for (const rel of [
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-linux/chrome',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const candidate = path.join(root, entry, rel);
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  throw new Error('no headless chromium found in the playwright cache');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEndpoint(deadlineMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('devtools endpoint never became ready');
}

function makeClient(socket) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    events.push(message);
  });
  return {
    events,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const browserPath = await findBrowser();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'shot-profile-'));
const child = spawn(
  browserPath,
  [
    '--headless',
    '--no-sandbox',
    '--disable-gpu',
    '--in-process-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const wsUrl = await waitForEndpoint();
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  const client = makeClient(socket);
  await client.send('Page.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (cookie) {
    const index = cookie.indexOf('=');
    const name = cookie.slice(0, index);
    const value = cookie.slice(index + 1);
    const host = new URL(url).hostname;
    await client.send('Network.setCookie', {
      name,
      value,
      domain: host,
      path: '/',
      httpOnly: true,
    });
  }

  await client.send('Page.navigate', { url });
  await sleep(waitMs);

  for (const step of steps) {
    if (step.kind === 'sleep') {
      // `--settle` 只在全部步骤之后生效一次，用来等「最后一步」的后果；
      // 步骤之间的等待必须靠 `--sleep`，否则下一个探针会在 400ms 后就跑，
      // 读到的还是旧状态（会误判成「按钮没反应」）。
      const ms = Number(step.value);
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`--sleep needs milliseconds, got: ${step.value}`);
      await sleep(ms);
    } else if (step.kind === 'file') {
      const separator = step.value.indexOf('=');
      const selector = step.value.slice(0, separator);
      const filePath = path.resolve(step.value.slice(separator + 1));
      const { result } = await client.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
      });
      if (!result || !result.objectId) throw new Error(`selector not found: ${selector}`);
      await client.send('DOM.setFileInputFiles', { files: [filePath], objectId: result.objectId });
      await client.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`,
      });
    } else if (step.kind === 'click') {
      await client.send('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(step.value)}).click()`,
      });
    } else if (step.kind === 'drag') {
      const [x1, y1, x2, y2] = step.value.split(',').map(Number);
      if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) {
        throw new Error(`--drag needs "x1,y1,x2,y2", got: ${step.value}`);
      }
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 0 });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x1,
        y: y1,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      // Intermediate moves matter: the handlers gate on a drag threshold and on
      // pointermove, so a press/release pair with no motion looks like a tap.
      const STEPS = 12;
      for (let i = 1; i <= STEPS; i += 1) {
        const t = i / STEPS;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x1 + (x2 - x1) * t,
          y: y1 + (y2 - y1) * t,
          button: 'left',
          buttons: 1,
        });
      }
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x2,
        y: y2,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    } else if (step.kind === 'script') {
      const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression: step.value,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`script failed: ${exceptionDetails.text}`);
      if (result && result.value !== undefined) console.log(`script → ${JSON.stringify(result.value)}`);
    }
    await sleep(stepDelay);
  }

  if (steps.length) await sleep(settleMs);

  const { data } = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !viewportOnly,
  });
  await fs.writeFile(out, Buffer.from(data, 'base64'));
  console.log(`wrote ${out}`);
  socket.close();
} finally {
  child.kill('SIGKILL');
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
