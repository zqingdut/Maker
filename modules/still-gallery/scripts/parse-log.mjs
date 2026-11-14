#!/usr/bin/env node
/**
 * Parse a `whiteboard_agent.log` into the gallery's entry structure, and
 * optionally push the result straight into a running Still Gallery instance.
 *
 *   # inspect only
 *   node scripts/parse-log.mjs ~/Downloads/whiteboard_agent.log
 *
 *   # dump the parsed structure for inspection / piping
 *   node scripts/parse-log.mjs whiteboard_agent.log --json --out /tmp/parsed.json
 *
 *   # import into a running server (downloads every image server-side)
 *   node scripts/parse-log.mjs whiteboard_agent.log --import --password '<admin password>'
 *
 *   # import straight into the data directory (no password, server must be stopped)
 *   node scripts/parse-log.mjs whiteboard_agent.log --local --data-dir ./data
 *
 * Options:
 *   --out <path>       write the parsed JSON to a file
 *   --json             print the full parsed JSON instead of a table
 *   --import           import via the gallery HTTP API
 *   --local            import directly into the data directory (no HTTP)
 *   --data-dir <path>  data directory for --local (default ./data)
 *   --server <url>     gallery base URL (default http://127.0.0.1:4317)
 *   --password <pw>    admin password, or set GALLERY_PASSWORD
 *   --tags a,b,c       extra tags applied to every imported entry
 *   --limit <n>        only consider the first n sessions
 *   --include-empty    also list sessions that produced no image (never imported)
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseWhiteboardLog, sessionToEntry, MAX_LOG_BYTES } from '../lib/log-parser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(HERE, '..', 'data');

function parseArgs(argv) {
  const options = {
    file: null,
    out: null,
    json: false,
    import: false,
    local: false,
    dataDir: null,
    server: process.env.GALLERY_URL || 'http://127.0.0.1:4317',
    password: process.env.GALLERY_PASSWORD || '',
    tags: [],
    limit: 0,
    includeEmpty: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--import') options.import = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--data-dir') options.dataDir = argv[++i];
    else if (arg === '--server') options.server = argv[++i];
    else if (arg === '--password') options.password = argv[++i];
    else if (arg === '--tags') options.tags = String(argv[++i] || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    else if (arg === '--limit') options.limit = Number(argv[++i]) || 0;
    else if (arg === '--include-empty') options.includeEmpty = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('--')) options.file = arg;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function usage() {
  console.log(`用法: node scripts/parse-log.mjs <日志文件> [选项]

选项:
  --out <路径>       把解析结果写入 JSON 文件
  --json             直接输出完整 JSON（默认输出表格）
  --import           通过画廊 API 导入（服务端下载图片）
  --local            直接写入数据目录导入，不需要密码
  --data-dir <路径>  --local 使用的数据目录，默认 ./data
  --server <地址>    画廊地址，默认 http://127.0.0.1:4317
  --password <密码>  管理员密码，也可用环境变量 GALLERY_PASSWORD
  --tags a,b         给所有导入条目附加标签
  --limit <n>        只处理前 n 个会话
  --include-empty    同时列出未产出图片的会话（不会被导入）
`);
}

/** Best-effort check that nothing else is serving this port. */
function isPortOpen(port, host = '127.0.0.1', timeout = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  return `${seconds.toFixed(1)}s`;
}

function renderTable(result) {
  const lines = [];
  lines.push(
    `${pad('#', 4)}${pad('状态', 10)}${pad('模式', 12)}${pad('耗时', 9)}${pad('提示词', 8)}标题`,
  );
  lines.push('-'.repeat(110));
  for (const session of result.sessions) {
    const status = session.status === 'ok' ? '有图片' : '无图片';
    const mode = session.mode === 'image2image' ? '图生图' : '文生图';
    lines.push(
      `${pad(session.index, 4)}${pad(status, 10)}${pad(mode, 12)}${pad(formatDuration(session.totalSeconds), 9)}${pad(session.prompt.length, 8)}${session.title || '(无标题)'}`,
    );
    for (const warning of session.warnings) {
      lines.push(`${pad('', 4)}⚠ ${warning}`);
    }
  }
  return lines.join('\n');
}

async function request(server, pathname, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${server.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload, response };
}

async function login(server, password) {
  const { status, payload, response } = await request(server, '/api/auth/login', {
    method: 'POST',
    body: { password },
  });
  if (status !== 200) throw new Error(payload?.error || `登录失败（${status}）`);
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const cookie = setCookie.map((entry) => entry.split(';')[0]).join('; ');
  if (!cookie) throw new Error('登录成功但没有拿到会话 Cookie');
  return cookie;
}

async function importLocally(options, absolute, text, importableCount) {
  if (!importableCount) {
    console.error('没有可导入的会话（都没有产出图片）');
    process.exitCode = 1;
    return;
  }

  const dataDir = path.resolve(options.dataDir || DEFAULT_DATA_DIR);
  const imagesFile = path.join(dataDir, 'images.json');

  try {
    await fs.access(imagesFile);
  } catch {
    console.error(`数据目录里没有 images.json：${imagesFile}`);
    console.error('请用 --data-dir 指向画廊的数据目录，或先启动一次服务生成它。');
    process.exitCode = 1;
    return;
  }

  // The server keeps the store in memory and rewrites the whole file on every
  // mutation, so a concurrent local write would be lost.
  const running = await isPortOpen(Number(new URL(options.server).port || 4317));
  if (running) {
    console.error(`⚠ 检测到 ${options.server} 上仍有服务在运行。`);
    console.error('  服务会把内存中的副本整份写回 images.json，可能覆盖本次导入。');
    console.error('  请先停止服务，或改用 --import --password <密码> 走 HTTP 通道。');
    process.exitCode = 1;
    return;
  }

  console.error(`\n本地导入 → ${dataDir}`);
  const { createApp } = await import('../server.mjs');
  const app = createApp({ dataDir });
  await app.init();
  const report = await app.importLogLocally(text, {
    fileName: path.basename(absolute),
    tags: options.tags,
    limit: options.limit,
  });

  console.log();
  console.log(`导入完成：成功 ${report.imported.length} 条，跳过 ${report.skipped.length} 条，失败 ${report.failed.length} 条`);
  for (const item of report.imported) console.log(`  ✓ ${item.title}  →  ${item.imageUrl}`);
  for (const item of report.skipped) console.log(`  – 跳过 #${item.index} ${item.title}：${item.reason}`);
  for (const item of report.failed) console.log(`  ✗ 失败 #${item.index} ${item.title}：${item.reason}`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exitCode = 1;
    return;
  }

  if (options.help || !options.file) {
    usage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const absolute = path.resolve(options.file);
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    console.error(`找不到日志文件：${absolute}`);
    process.exitCode = 1;
    return;
  }
  if (stat.size > MAX_LOG_BYTES) {
    console.error(`日志文件超过 ${Math.round(MAX_LOG_BYTES / 1024 / 1024)}MB 上限`);
    process.exitCode = 1;
    return;
  }

  const text = await fs.readFile(absolute, 'utf8');
  const fileName = path.basename(absolute);
  const result = parseWhiteboardLog(text, { fileName });

  const selected = options.limit > 0 ? result.sessions.slice(0, options.limit) : result.sessions;
  const importable = selected.filter((session) => session.status === 'ok');
  const skipped = selected.filter((session) => session.status !== 'ok');

  // The gallery-shaped view of the same data, so `--out` produces something
  // that can be diffed against what the server actually stores.
  const enriched = {
    ...result,
    entries: importable.map((session) => ({
      ...sessionToEntry(session, { tags: options.tags, source: fileName }),
      imageUrl: session.imageUrl,
      sourceUrl: session.imageUrl,
      sessionIndex: session.index,
    })),
  };

  if (options.json) {
    console.log(JSON.stringify(enriched, null, 2));
  } else {
    console.log(`日志文件: ${fileName}（${(stat.size / 1024).toFixed(0)} KB）`);
    console.log(
      `识别到 ${result.stats.total} 个生成会话：${result.stats.withImage} 个产出图片，${result.stats.withoutImage} 个仅文字回复`,
    );
    if (result.warnings.length) {
      for (const warning of result.warnings) console.log(`⚠ ${warning}`);
    }
    console.log();
    console.log(renderTable({ sessions: options.includeEmpty ? selected : importable }));
    console.log();
    console.log(`可导入: ${importable.length} 条${skipped.length && !options.includeEmpty ? `（已跳过 ${skipped.length} 条无图片会话）` : ''}`);
  }

  if (options.out) {
    const target = path.resolve(options.out);
    await fs.writeFile(target, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8');
    console.error(`解析结果已写入 ${target}`);
  }

  if (options.local) {
    await importLocally(options, absolute, text, importable.length);
    return;
  }

  if (!options.import) return;

  if (!options.password) {
    console.error('导入需要管理员密码：--password <密码> 或设置 GALLERY_PASSWORD');
    console.error('（若服务已停止，可改用 --local 直接写入数据目录）');
    process.exitCode = 1;
    return;
  }
  if (!importable.length) {
    console.error('没有可导入的会话（都没有产出图片）');
    process.exitCode = 1;
    return;
  }

  console.error(`\n正在连接 ${options.server} …`);
  const cookie = await login(options.server, options.password);

  const preview = await request(options.server, '/api/logs/parse', {
    method: 'POST',
    body: { fileName, logText: text, tags: options.tags, limit: options.limit },
    cookie,
  });
  if (preview.status !== 200) {
    console.error(`解析失败：${preview.payload?.error || preview.status}`);
    process.exitCode = 1;
    return;
  }
  console.error(
    `服务端解析：可导入 ${preview.payload.plan.length} 条，其中 ${preview.payload.plan.filter((item) => item.alreadyImported).length} 条已存在`,
  );

  const { status, payload } = await request(options.server, '/api/logs/import', {
    method: 'POST',
    body: { fileName, logText: text, tags: options.tags, limit: options.limit },
    cookie,
  });
  if (status !== 200) {
    console.error(`导入失败：${payload?.error || status}`);
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(`导入完成：成功 ${payload.imported.length} 条，跳过 ${payload.skipped.length} 条，失败 ${payload.failed.length} 条`);
  for (const item of payload.imported) {
    console.log(`  ✓ ${item.title}  →  ${item.imageUrl}`);
  }
  for (const item of payload.skipped) {
    console.log(`  – 跳过 #${item.index} ${item.title}：${item.reason}`);
  }
  for (const item of payload.failed) {
    console.log(`  ✗ 失败 #${item.index} ${item.title}：${item.reason}`);
  }
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exitCode = 1;
});
