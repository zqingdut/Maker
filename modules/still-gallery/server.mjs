/**
 * Still Gallery — a dependency-free image + prompt gallery server.
 *
 *   public gallery : GET  /
 *   admin console  : GET  /admin
 *   protected API  : POST/PATCH/DELETE under /api (single administrator account)
 *
 * Storage lives in DATA_DIR: images.json (atomic writes), auth.json (scrypt hash),
 * uploads/ (downloaded bitmaps).
 *
 * 中文说明：本文件承载全部面向用户的错误文案，历史上曾被写坏过——三字节 UTF-8
 * 字符的第三个字节被替换成 '?'（解码后表现为 U+FFFD 加一个问号）。改动后请运行
 * `tests/encoding.test.mjs`，它会扫描全部源码，确认没有残留的 U+FFFD。
 */
import { createServer } from 'node:http';
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadImage, DownloadError, sniffImage } from './lib/downloader.mjs';
import { createJobQueue, QueueError, MAX_CONCURRENCY, normalizeConcurrency } from './lib/job-queue.mjs';
import { GENERATION_KEEP_MS, createGenerationStore } from './lib/generation-store.mjs';
import { createVaultStore, VaultError } from './lib/vault-store.mjs';
import {
  CLIPBOARD_MAX_FILE_BYTES,
  CLIPBOARD_MAX_IMAGES,
  CLIPBOARD_MAX_TEXT_CHARS,
  ClipboardError,
  createClipboardStore,
} from './lib/clipboard-store.mjs';
import { boundaryOf, parseMultipart, titleFromFilename } from './lib/multipart.mjs';
import { ZIP_MAX_ENTRIES, safeEntryName, writeZip } from './lib/zip.mjs';
import {
  MAX_SAMPLES,
  buildReport,
  createSample,
  normalizeSample,
  trimSamples,
} from './lib/metrics.mjs';
import { parseWhiteboardLog, sessionToEntry, MAX_LOG_BYTES } from './lib/log-parser.mjs';
import { createEventLog, isLogLevel } from './lib/event-log.mjs';
import {
  ARK_DEFAULT_BASE_URL,
  ARK_DEFAULT_MODEL,
  ARK_MODEL_SUGGESTIONS,
  BACKGROUNDS,
  GENERATION_TIMEOUT_MS,
  GenerationError,
  MAX_GROUP_IMAGES,
  MAX_REFERENCE_IMAGES,
  MODES as GENERATION_MODES,
  OUTPUT_FORMATS,
  apiKeyHint,
  buildGenerationPayload,
  generateImages,
  maxGroupImagesFor,
  modelCatalog,
  normalizeBaseUrl,
  normalizeModel,
  sizeSuggestionsFor,
} from './lib/image-gen.mjs';
import {
  RELAY_ASPECTS,
  RELAY_ASPECT_PIXELS,
  RELAY_DEFAULT_ASPECT,
  RELAY_DEFAULT_BASE_URL,
  RELAY_MAX_PROMPT_CHARS,
  RELAY_MAX_REFERENCE_IMAGES,
  RELAY_MODEL_LABEL,
  RELAY_LOCAL_BASE_URL,
  buildRelayPayload,
  generateViaRelay,
  normalizeRelayBaseUrl,
  resolveRelayEndpoint,
  resolveRelayEndpoints,
} from './lib/relay-gen.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
/**
 * Generation requests may carry reference images inline as base64, so this route
 * gets its own ceiling. It is behind the session cookie, the same-origin check
 * and a rate limiter, and the decoded payload is capped per image downstream.
 */
const MAX_GENERATE_BODY_BYTES = 48 * 1024 * 1024;
/**
 * 上传到后台图库的请求体上限。
 *
 * 和生成请求同一量级（参考图也是图片），但它不需要 48MB 那么多：前台一次只传
 * 一张，8 张的上限是给脚本调用留的余量。真正的单张上限（15MB）在存储层卡，
 * 这里卡的是「一个请求最多占多少内存」。
 */
const MAX_VAULT_UPLOAD_BYTES = 48 * 1024 * 1024;
/** 一个上传请求最多带几张图。 */
const MAX_VAULT_UPLOAD_FILES = 8;
/**
 * 剪贴板单条文字上限是 10 万字符（约 300KB UTF-8），请求体按 1MB 卡。
 * 不走默认的 64KB：那连一篇中等长度的 Markdown 都存不进去，而用户看到的是
 * 一个「请求内容过大」——他不会知道是字数限制，只会以为功能坏了。
 */
const MAX_CLIPBOARD_BODY_BYTES = 1024 * 1024;
const COOKIE_NAME = 'sg_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // `blob:` is needed for the local previews of reference images picked in the
  // generation panel; everything else stays locked to this origin.
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: blob: https: http:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const exists = (file) => fs.existsSync(file);

async function readJsonFile(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${randomUUID()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}

function verifyPassword(password, record) {
  const candidate = Buffer.from(hashPassword(password, record.salt), 'hex');
  const expected = Buffer.from(record.hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/* ------------------------------------------------------------------ *
 * Validation helpers
 * ------------------------------------------------------------------ */

function cleanString(value, { field, max, required = false }) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field}不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field}必须是文本`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text && required) throw new HttpError(400, `${field}不能为空`);
  if (text.length > max) throw new HttpError(400, `${field}长度不能超过 ${max} 个字符`);
  return text;
}

/**
 * 从提示词取一个默认标题。和前端 `autoTitle()` 同一套规则：导入时如果操作者
 * 没填标题，两边的结果必须一样，否则同一张图从两个入口进来会得到不同标题。
 */
function autoTitle(prompt, index, total) {
  const text = String(prompt || '').trim().replace(/\s+/g, ' ');
  const base = text.length > 28 ? `${text.slice(0, 28)}…` : text || 'AI 生成';
  return total > 1 ? `${base}（${index}）` : base;
}

/** Per-image tag ceiling. Mirrored by the admin UI tag hint. */
const MAX_TAGS_PER_IMAGE = 12;
/**
 * 队列默认同时跑几个任务。8 是折中：控制台点一次生成就入队一次，串行会把
 * 六张图的等待叠成六倍；再往上加就该看上游账号的实际配额了。
 */
const QUEUE_CONCURRENCY_DEFAULT = 8;
function cleanTags(value) {
  let list = [];
  if (value === undefined || value === null) return list;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    list = value.split(/[,，]/);
  } else {
    throw new HttpError(400, '标签格式不正确');
  }
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new HttpError(400, '标签必须是文本');
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    if (tag.length > 32) throw new HttpError(400, '单个标签不能超过 32 个字符');
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length > MAX_TAGS_PER_IMAGE) {
      throw new HttpError(400, `标签数量不能超过 ${MAX_TAGS_PER_IMAGE} 个`);
    }
  }
  return out;
}

/**
 * Provenance is a small, closed record describing where an image came from — a
 * parsed agent log, or a generation request. It is whitelisted in both
 * directions so a client cannot park an arbitrary blob inside images.json, and
 * so a hand-edited file cannot leak unexpected fields back out.
 */
const PROVENANCE_TEXT_KEYS = {
  source: 120,
  sessionId: 64,
  mode: 40,
  model: 120,
  llmModel: 120,
  size: 40,
  outputFormat: 20,
  background: 20,
  generatedAt: 40,
  urlExpiresAt: 40,
  promptOptimizeMode: 40,
  apiBase: 200,
  requestId: 64,
  queueJobId: 64,
  rawRequest: 2000,
};
const PROVENANCE_NUMBER_KEYS = new Set([
  'latencySeconds',
  'imageLatencySeconds',
  'llmLatencySeconds',
  'groupIndex',
  'groupTotal',
  'referenceCount',
  'maxImages',
]);
const PROVENANCE_BOOLEAN_KEYS = new Set(['watermark', 'referenceImage', 'promptTruncated', 'webSearch']);
const PROVENANCE_TOKEN_KEYS = ['prompt', 'completion', 'total'];

function readProvenance(value, { strict }) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new HttpError(400, '来源信息格式不正确');
    return null;
  }
  const out = {};

  for (const [key, max] of Object.entries(PROVENANCE_TEXT_KEYS)) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      if (strict) throw new HttpError(400, `来源字段 ${key} 必须是文本`);
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    if (text.length > max) {
      if (strict) throw new HttpError(400, `来源字段 ${key} 过长`);
      continue;
    }
    out[key] = text;
  }

  for (const key of PROVENANCE_NUMBER_KEYS) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const number = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (Number.isFinite(number)) {
      out[key] = number;
      continue;
    }
    if (strict) throw new HttpError(400, `来源字段 ${key} 必须是数字`);
  }

  for (const key of PROVENANCE_BOOLEAN_KEYS) {
    const raw = value[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean') {
      out[key] = raw;
      continue;
    }
    if (raw === 'true' || raw === 'false') {
      out[key] = raw === 'true';
      continue;
    }
    if (strict) throw new HttpError(400, `来源字段 ${key} 必须是布尔值`);
  }

  if (value.tokens && typeof value.tokens === 'object' && !Array.isArray(value.tokens)) {
    const tokens = {};
    for (const key of PROVENANCE_TOKEN_KEYS) {
      const number = Number(value.tokens[key]);
      if (Number.isFinite(number)) tokens[key] = number;
    }
    if (Object.keys(tokens).length) out.tokens = tokens;
  }

  return Object.keys(out).length ? out : null;
}

function cleanMeta(body) {
  return {
    title: cleanString(body.title, { field: '标题', max: 120, required: true }),
    prompt: cleanString(body.prompt, { field: '提示词', max: 8000, required: true }),
    negativePrompt: cleanString(body.negativePrompt, { field: '反向提示词', max: 4000 }),
    model: cleanString(body.model, { field: '模型', max: 120 }),
    aspectRatio: cleanString(body.aspectRatio, { field: '画面比例', max: 16 }),
    seed: cleanString(body.seed === undefined || body.seed === null ? '' : String(body.seed), { field: '随机种子', max: 64 }),
    steps: cleanString(body.steps === undefined || body.steps === null ? '' : String(body.steps), { field: '采样步数', max: 64 }),
    guidance: cleanString(body.guidance === undefined || body.guidance === null ? '' : String(body.guidance), { field: '引导强度', max: 64 }),
    tags: cleanTags(body.tags),
    provenance: readProvenance(body.provenance, { strict: true }),
  };
}

function sanitizeImage(record) {
  const {
    id, title, imageUrl, sourceUrl, prompt, negativePrompt, model, tags,
    aspectRatio, seed, steps, guidance, bytes, mime, createdAt, updatedAt, demo,
    provenance,
  } = record;
  return {
    id, title, imageUrl, sourceUrl: sourceUrl || '', prompt,
    negativePrompt: negativePrompt || '', model: model || '',
    tags: Array.isArray(tags) ? tags : [],
    aspectRatio: aspectRatio || '', seed: seed || '', steps: steps || '', guidance: guidance || '',
    bytes: bytes || 0, mime: mime || '', createdAt, updatedAt,
    demo: Boolean(demo),
    provenance: readProvenance(provenance, { strict: false }),
  };
}

/* ------------------------------------------------------------------ *
 * App factory
 * ------------------------------------------------------------------ */

export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const publicDir = path.resolve(options.publicDir || path.join(ROOT, 'public'));
  const uploadsDir = path.join(dataDir, 'uploads');
  const imagesFile = path.join(dataDir, 'images.json');
  const authFile = path.join(dataDir, 'auth.json');
  const settingsFile = path.join(dataDir, 'settings.json');
  const metricsFile = path.join(dataDir, 'metrics.json');
  /**
   * 生成记录：24 小时内生成过的图片，可以回看 / 放大 / 补导入。
   * 图片本体落在 data/generations/，索引是 data/generations.json，都已被 .gitignore 忽略。
   */
  const generations = createGenerationStore({
    dir: path.join(dataDir, 'generations'),
    indexFile: path.join(dataDir, 'generations.json'),
    // 测试可以调小保留窗口，直接验证过期剪枝。
    keepMs: Number.isFinite(options.generationKeepMs) ? options.generationKeepMs : GENERATION_KEEP_MS,
    max: Number.isFinite(options.generationMax) ? options.generationMax : undefined,
  });
  /**
   * 后台图库：只对已登录管理员可见的私有图片库，和公开图库（images.json）完全分开。
   * 图片落在 data/vault/，索引是 data/vault.json，同样被 .gitignore 忽略。
   *
   * 分开存而不是给 images 加一个 visibility 字段，是因为「过滤写漏一次」的代价
   * 是私有图片直接出现在首页上。两个目录、两条 API 前缀，漏不掉。
   */
  const vault = createVaultStore({
    dir: path.join(dataDir, 'vault'),
    indexFile: path.join(dataDir, 'vault.json'),
    maxItems: Number.isFinite(options.vaultMaxItems) ? options.vaultMaxItems : undefined,
    maxBytes: Number.isFinite(options.vaultMaxBytes) ? options.vaultMaxBytes : undefined,
  });
  /**
   * 后台剪贴板：最近 100 条图文内容，先进先出。
   *
   * 和后台图库一样是私有数据（同样 requireAuth），但满了**会**挤掉最旧的——
   * 这是需求本身，不是偷懒。图片落在 data/clipboard/，索引是 data/clipboard.json，
   * 两者都被 .gitignore 忽略。
   */
  const clipboard = createClipboardStore({
    dir: path.join(dataDir, 'clipboard'),
    indexFile: path.join(dataDir, 'clipboard.json'),
    maxItems: Number.isFinite(options.clipboardMaxItems) ? options.clipboardMaxItems : undefined,
    maxBytes: Number.isFinite(options.clipboardMaxBytes) ? options.clipboardMaxBytes : undefined,
  });
  const seedDemo = options.seedDemo !== false;
  // Injection point used only by the test suite; production always uses the guarded downloader.
  const fetchImage = options.downloadImage || downloadImage;
  // Same idea for the generation call: tests stub the network, production does not.
  const fetchGeneration = options.generateImages || generateImages;
  // 01ai 网关是另一套协议，独立注入点，互不影响。
  const fetchRelayGeneration = options.generateRelay || generateViaRelay;

  /** @type {Array<object>} */
  let images = [];
  /** @type {{salt:string, hash:string, createdAt:string}|null} */
  let authRecord = null;
  /**
   * Generation credentials live here, never in source. The API key is written to
   * data/settings.json (mode 0600, git-ignored) and is never returned to a client
   * — only a masked hint is. An ARK_API_KEY environment variable, when present,
   * always wins and locks the field in the UI.
   */
  let settings = {
    arkApiKey: '',
    arkBaseUrl: ARK_DEFAULT_BASE_URL,
    defaultModel: ARK_DEFAULT_MODEL,
    // 'ark'（火山方舟，默认）| 'relay'（01ai 网关）。两套凭据各自独立保存，
    // 切换上游不需要重新填。
    provider: 'ark',
    relayBaseUrl: RELAY_DEFAULT_BASE_URL,
    relayToken: '',
    // 队列同时跑几个任务。默认 8：控制台点一次生成就入队一次，串行会把
    // 六张图的等待时间叠成六倍。上限由上游配额决定，这里只保证不会失控。
    queueConcurrency: QUEUE_CONCURRENCY_DEFAULT,
    updatedAt: '',
  };
  const sessions = new Map();
  const rateBuckets = new Map();
  /**
   * 运行日志（内存环形缓冲，重启即清空）。存在的理由只有一个：出问题时用户
   * 能在后台页面看到「刚才发生了什么」，不必去翻 ssh 或浏览器控制台。
   * 容量按条数算，见 lib/event-log.mjs。
   */
  const events = createEventLog({ limit: 800 });
  /**
   * Preview handles for freshly generated images.
   *
   * The console must not load a generated bitmap straight from Ark's signed TOS
   * URL: that URL is only valid for 24h, it is fetched by the *browser* over the
   * public internet, and when it fails the `<img>` simply stays blank. Routing
   * the preview through this process instead means the bytes are fetched once by
   * the server (through the same SSRF-guarded downloader the importer uses) and
   * then served from localhost.
   *
   * Keyed by an opaque token rather than accepting a URL from the client, so the
   * endpoint cannot be turned into an open proxy.
   *
   * @type {Map<string, {url:string, buffer:Buffer|null, mime:string}>}
   */
  const previews = new Map();
  /**
   * 令牌上限按「同时可能出现的张数」定：队列默认并发 8、组图最多 10 张，一轮就是
   * 80 个令牌，原来的 60 会在浏览器还没请求到时就淘汰掉先完成的那几张，表现为
   * 图片 404、预览空白。
   */
  const PREVIEW_CACHE_MAX = 120;
  /**
   * 但令牌数不是唯一的约束——每个令牌在第一次被访问后会缓存整张图。120 张 2K PNG
   * 可能是几百 MB，所以同时按字节数设一个硬上限，谁先到就按谁的来。
   */
  const PREVIEW_CACHE_BYTES = 96 * 1024 * 1024;
  let previewBytes = 0;

  /**
   * 按插入顺序淘汰最旧的，但跳过 `keep`（刚写入/刚被访问的那一条）。
   * 计数和字节数两个上限同时生效，先触发的那个说了算。
   */
  function trimPreviews(keep) {
    for (const key of previews.keys()) {
      if (previews.size <= PREVIEW_CACHE_MAX && previewBytes <= PREVIEW_CACHE_BYTES) return;
      if (key === keep) continue;
      const entry = previews.get(key);
      if (entry.buffer) previewBytes -= entry.buffer.length;
      previews.delete(key);
    }
  }

  /**
   * Generation timing samples, newest last. Persisted to `data/metrics.json` so
   * the averages survive a restart; capped at `MAX_SAMPLES` so the file cannot
   * grow without bound. Each sample is one *request*, not one bitmap — see
   * lib/metrics.mjs for why the per-image figure is apportioned.
   *
   * @type {Array<object>}
   */
  let samples = [];

  /** Ceiling on queued+running jobs. Beyond this the queue is a denial vector. */
  const QUEUE_MAX_PENDING = 50;
  /** Settled jobs kept for display; the oldest fall off first. */
  const QUEUE_HISTORY_MAX = 60;

  let writeChain = Promise.resolve();
  function withLock(task) {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Persist the store. The previous revision is kept alongside as
   * `images.json.bak` so an accidental truncation, a bad edit, or an external
   * tool reverting the file is recoverable instead of terminal.
   */
  async function persistImages() {
    if (exists(imagesFile)) {
      await fsp.copyFile(imagesFile, `${imagesFile}.bak`).catch(() => {});
    }
    await writeJsonAtomic(imagesFile, images);
  }

  async function init() {
    await fsp.mkdir(uploadsDir, { recursive: true });
    authRecord = await readJsonFile(authFile, null);
    const stored = await readJsonFile(settingsFile, null);
    if (stored && typeof stored === 'object') {
      settings = {
        arkApiKey: typeof stored.arkApiKey === 'string' ? stored.arkApiKey : '',
        arkBaseUrl: typeof stored.arkBaseUrl === 'string' && stored.arkBaseUrl ? stored.arkBaseUrl : ARK_DEFAULT_BASE_URL,
        defaultModel: typeof stored.defaultModel === 'string' && stored.defaultModel ? stored.defaultModel : ARK_DEFAULT_MODEL,
        provider: stored.provider === 'relay' ? 'relay' : 'ark',
        relayBaseUrl:
          typeof stored.relayBaseUrl === 'string' && stored.relayBaseUrl
            ? stored.relayBaseUrl
            : RELAY_DEFAULT_BASE_URL,
        relayToken: typeof stored.relayToken === 'string' ? stored.relayToken : '',
        // 老配置文件里没有这个字段，读出来是 undefined。缺省/损坏都回落到默认值，
        // 不能悄悄变成 1——那会让老用户升级后队列突然退回串行。
        queueConcurrency:
          Number(stored.queueConcurrency) >= 1
            ? normalizeConcurrency(stored.queueConcurrency)
            : QUEUE_CONCURRENCY_DEFAULT,
        updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : '',
      };
    }
    if (!exists(imagesFile)) {
      let seed = seedDemo ? await readJsonFile(path.join(dataDir, 'demo.json'), null) : [];
      if (!Array.isArray(seed)) seed = await readJsonFile(path.join(ROOT, 'data', 'demo.json'), []);
      await writeJsonAtomic(imagesFile, Array.isArray(seed) ? seed : []);
    }
    const loaded = await readJsonFile(imagesFile, []);
    images = Array.isArray(loaded) ? loaded : [];

    const storedMetrics = await readJsonFile(metricsFile, null);
    const rawSamples = storedMetrics && Array.isArray(storedMetrics.samples) ? storedMetrics.samples : [];
    samples = trimSamples(rawSamples.map(normalizeSample).filter(Boolean), MAX_SAMPLES);

    // 生成记录：读索引 + 剪掉超过 24 小时的条目（含文件）。
    await generations.init();
    // 后台图库只读索引，没有过期逻辑：它是长期资产，只能由管理员删除。
    await vault.init();
    // 剪贴板同理，只是满了按先进先出淘汰（淘汰发生在写入时，不在启动时）。
    await clipboard.init();

    // 队列在 createApp() 里就建好了，那时还没读到 settings，所以并发值在这里补上。
    queue.setConcurrency(settings.queueConcurrency);
  }

  /** The key never touches the filesystem when the environment supplies it. */
  async function persistSettings() {
    await writeJsonAtomic(settingsFile, settings);
    await fsp.chmod(settingsFile, 0o600).catch(() => {});
  }

  /**
   * Persist timing samples. Kept beside `persistImages` (same `.bak` courtesy)
   * because losing the metrics file costs history, not data.
   *
   * Failures are swallowed on purpose: a full disk must not turn a successful,
   * already-billed generation into an error response.
   */
  async function persistMetrics() {
    try {
      await withLock(async () => {
        if (exists(metricsFile)) {
          await fsp.copyFile(metricsFile, `${metricsFile}.bak`).catch(() => {});
        }
        await writeJsonAtomic(metricsFile, { version: 1, samples });
      });
    } catch (error) {
      console.error('[still-gallery] 指标写入失败：', error.message);
    }
  }

  /**
   * Record one generation attempt. `durationMs` must be the wall clock of the
   * upstream call itself — not of request parsing, validation or preview minting
   * — otherwise the average stops describing what Ark costs in latency.
   */
  function recordSample(partial) {
    const sample = createSample(partial);
    if (!sample) return null;
    samples.push(sample);
    samples = trimSamples(samples, MAX_SAMPLES);
    void persistMetrics();
    return sample;
  }

  /** The user-facing message for anything thrown by the generation client. */
  function generationMessage(error) {
    if (error instanceof GenerationError || error instanceof HttpError) return error.message;
    return error && error.message ? error.message : '生图失败';
  }

  function effectiveArkConfig() {
    const envKey = String(process.env.ARK_API_KEY || '').trim();
    const envBase = String(process.env.ARK_BASE_URL || '').trim();
    const baseUrl = envBase || settings.arkBaseUrl || ARK_DEFAULT_BASE_URL;
    if (envKey) {
      return { apiKey: envKey, baseUrl, source: 'env', defaultModel: settings.defaultModel || ARK_DEFAULT_MODEL };
    }
    return {
      apiKey: settings.arkApiKey || '',
      baseUrl,
      source: settings.arkApiKey ? 'file' : null,
      defaultModel: settings.defaultModel || ARK_DEFAULT_MODEL,
    };
  }

  /** 当前生效的上游。settings 里只认这两个值，其余一律按方舟处理。 */
  function currentProvider() {
    return settings.provider === 'relay' ? 'relay' : 'ark';
  }

  /**
   * 01ai 网关口令与地址。环境变量（`IMAGE_RELAY_TOKEN` / `IMAGE_RELAY_BASE`）
   * 优先于 data/settings.json，和方舟那套保持同一套语义。
   *
   * `localBaseUrl` 是本机优先候选：默认先打 127.0.0.1:4399（本机 image-gateway
   * 的默认端口），连不上或那里没有网关路由才退回 `baseUrl`。`IMAGE_RELAY_LOCAL_BASE=off` 可关掉。
   */
  function effectiveRelayConfig() {
    const envToken = String(process.env.IMAGE_RELAY_TOKEN || '').trim();
    const envBase = String(process.env.IMAGE_RELAY_BASE || '').trim();
    const envLocal = String(process.env.IMAGE_RELAY_LOCAL_BASE || '').trim();
    const baseUrl = envBase || settings.relayBaseUrl || RELAY_DEFAULT_BASE_URL;
    const localBaseUrl = envLocal || RELAY_LOCAL_BASE_URL;
    if (envToken) return { token: envToken, baseUrl, localBaseUrl, source: 'env' };
    return {
      token: settings.relayToken || '',
      baseUrl,
      localBaseUrl,
      source: settings.relayToken ? 'file' : null,
    };
  }

  /** Shape shared by GET and PUT /api/generate/config — never includes the key. */
  function describeGenerationConfig() {
    const config = effectiveArkConfig();
    const relay = effectiveRelayConfig();
    return {
      configured: Boolean(config.apiKey),
      source: config.source,
      envLocked: Boolean(String(process.env.ARK_API_KEY || '').trim()),
      apiKeyHint: apiKeyHint(config.apiKey),
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel,
      provider: currentProvider(),
      relay: {
        configured: Boolean(relay.token),
        source: relay.source,
        envLocked: Boolean(String(process.env.IMAGE_RELAY_TOKEN || '').trim()),
        tokenHint: apiKeyHint(relay.token),
        baseUrl: relay.baseUrl,
        // 本机优先候选；`localFallback` 为 false 表示这条链只剩域名地址。
        localBaseUrl: relay.localBaseUrl,
        localFallback:
          resolveRelayEndpoints(relay.baseUrl, { localBaseUrl: relay.localBaseUrl }).length > 1,
        // 只用于填下拉框，服务端不按它做白名单校验（网关自己也不校验）。
        aspects: RELAY_ASPECTS,
        aspectPixels: RELAY_ASPECT_PIXELS,
        defaultAspect: RELAY_DEFAULT_ASPECT,
        maxPromptChars: RELAY_MAX_PROMPT_CHARS,
        maxReferenceImages: RELAY_MAX_REFERENCE_IMAGES,
        modelLabel: RELAY_MODEL_LABEL,
      },
      modelSuggestions: ARK_MODEL_SUGGESTIONS,
      // Per-family limits, so the console can adjust the reference cap and grey
      // out unsupported switches before the request is ever sent.
      modelCatalog: modelCatalog(),
      // Per model, not global: `4K` is a valid preset on Seedream 4.0 and an
      // instant 400 from Seedream 5.0 pro. The console re-reads this list from
      // `modelCatalog` whenever the operator switches model.
      sizeSuggestions: sizeSuggestionsFor(config.defaultModel),
      outputFormats: OUTPUT_FORMATS,
      backgrounds: BACKGROUNDS,
      modes: GENERATION_MODES,
      limits: {
        maxReferenceImages: MAX_REFERENCE_IMAGES,
        maxGroupImages: MAX_GROUP_IMAGES,
        maxGroupImagesWithOneReference: maxGroupImagesFor(1),
        timeoutSeconds: Math.round(GENERATION_TIMEOUT_MS / 1000),
        queueMaxPending: QUEUE_MAX_PENDING,
        queueConcurrency: settings.queueConcurrency,
        queueConcurrencyMax: MAX_CONCURRENCY,
        metricsCapacity: MAX_SAMPLES,
      },
    };
  }

  /* ---------------- request plumbing ---------------- */

  function send(res, status, body, extraHeaders = {}) {
    const headers = { ...SECURITY_HEADERS, 'cache-control': 'no-store', ...extraHeaders };
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, headers);
      res.end(body);
      return;
    }
    if (body === undefined || body === null) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = Buffer.byteLength(payload);
    res.writeHead(status, headers);
    res.end(payload);
  }

  function fail(res, status, message) {
    send(res, status, { error: message });
  }

  async function readBody(req, maxBytes = MAX_BODY_BYTES) {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) {
      throw new HttpError(415, '请求必须使用 application/json');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new HttpError(413, `请求内容过大（上限 ${Math.round(maxBytes / 1024 / 1024) || 1}MB）`);
      }
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, '请求内容必须是 JSON 对象');
      }
      return parsed;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, '请求内容不是合法的 JSON');
    }
  }

  /**
   * 读原始请求体（上传用）。
   *
   * 和 `readBody` 分开是必要的：那个强制 `application/json`，而 multipart 的
   * 正文是二进制，连 `content-type` 都带着 boundary，套不进去。这里只做一件事
   * ——把字节读全、卡住上限，解析交给 lib/multipart.mjs。
   */
  async function readRawBody(req, maxBytes) {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, `请求内容过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new HttpError(413, `请求内容过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
      }
      chunks.push(chunk);
    }
    if (!size) throw new HttpError(400, '请求内容为空');
    return Buffer.concat(chunks);
  }

  function sameOrigin(req) {
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site === 'cross-site') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function clientKey(req) {
    return req.socket.remoteAddress || 'unknown';
  }

  function rateLimit(req, bucket, limit, windowMs) {
    const key = `${bucket}:${clientKey(req)}`;
    const now = Date.now();
    const entry = rateBuckets.get(key);
    if (!entry || entry.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      const seconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      throw new HttpError(429, `尝试过于频繁，请等 ${seconds} 秒后重试`);
    }
  }

  function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of String(header).split(';')) {
      const index = part.indexOf('=');
      if (index === -1) continue;
      out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
    return out;
  }

  function currentSession(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const key = sha256(token);
    const expiry = sessions.get(key);
    if (!expiry) return null;
    if (expiry <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return key;
  }

  function issueSession(res) {
    const token = randomBytes(32).toString('base64url');
    sessions.set(sha256(token), Date.now() + SESSION_TTL_MS);
    res.setHeader(
      'set-cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    );
  }

  function requireAuth(req) {
    if (!currentSession(req)) throw new HttpError(401, '请先登录管理者账号');
  }

  /* ---------------- static files ---------------- */

  /**
   * 资源版本号：内容指纹的替身。
   *
   * 文件名里没有指纹，而前面很可能还挂着一层反向代理 / CDN——nginx 的 `expires 4h`
   * 会把响应头改写成 `max-age=14400`（**覆盖**我们发的 `no-cache`），Cloudflare 的
   * 「浏览器缓存 TTL」同理。于是发布后浏览器会拿旧脚本配新 HTML：按钮点了没反应、
   * 布局错位、下拉箭头不见，而且怎么刷新都不一定好。
   *
   * 把版本号写进 URL 是唯一不依赖中间层配置的解法：换了内容就是换了 URL，
   * 代理只能换一个 key 缓存，串不了版本。
   */
  const versionCache = new Map();

  async function assetVersion(absolutePath) {
    const stat = await fsp.stat(absolutePath).catch(() => null);
    if (!stat || !stat.isFile()) return '';
    const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const cached = versionCache.get(absolutePath);
    if (cached && cached.stamp === stamp) return cached.version;
    const version = createHash('sha1').update(stamp).digest('hex').slice(0, 8);
    versionCache.set(absolutePath, { stamp, version });
    return version;
  }

  /** HTML 的 href/src、JS 的相对 import，都补上 `?v=`。 */
  async function withAssetVersions(source, { ext, absolutePath }) {
    if (ext === '.html') {
      let out = source;
      for (const [full, ref] of source.matchAll(/(?:href|src)="(\/[^"?#]+\.(?:css|js))"/g)) {
        const target = resolveInside(publicDir, ref.replace(/^\//, ''));
        if (!target) continue;
        const version = await assetVersion(target);
        if (version) out = out.replaceAll(full, full.replace(`${ref}"`, `${ref}?v=${version}"`));
      }
      return out;
    }
    if (ext === '.js') {
      let out = source;
      for (const [full, ref] of source.matchAll(/from\s+'(\.\/[^']+\.js)'/g)) {
        const version = await assetVersion(path.resolve(path.dirname(absolutePath), ref));
        if (version) out = out.replaceAll(full, full.replace(`'${ref}'`, `'${ref}?v=${version}'`));
      }
      return out;
    }
    return source;
  }

  async function serveFile(res, absolutePath, { download = false } = {}) {
    let stat;
    try {
      stat = await fsp.stat(absolutePath);
    } catch {
      fail(res, 404, '资源不存在');
      return;
    }
    if (!stat.isFile()) {
      fail(res, 404, '资源不存在');
      return;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    /**
     * 资源名里没有内容指纹，所以**不能给长缓存**：发布新版本后浏览器会拿旧的
     * admin.js / styles.css 去配新 HTML，症状是「按钮点了没反应、布局错位」。
     *
     * 统一 `no-cache` + ETag：每次回来问一句，没变就 304。既不会用错版本，
     * 也不会重复传字节。真正的保险是上面的 `?v=`。
     */
    const cacheControl = ext === '.html' ? 'no-store' : 'no-cache';

    // 需要改写的两个类型都不大（HTML 36K、admin.js 116K），读进内存比边流边改简单。
    let body = null;
    if (ext === '.html' || ext === '.js') {
      const source = await fsp.readFile(absolutePath, 'utf8').catch(() => null);
      if (source !== null) {
        body = Buffer.from(await withAssetVersions(source, { ext, absolutePath }), 'utf8');
      }
    }

    // 改写后的字节才是真正要发的字节，ETag 必须跟着它走，否则换版本后还会命中旧 304。
    const etag = body
      ? `W/"${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`
      : `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const inm = String(res.req?.headers?.['if-none-match'] || '');
    const fresh = inm === '*' || inm.split(',').some((tag) => tag.trim() === etag);
    if (fresh) {
      res.writeHead(304, { ...SECURITY_HEADERS, etag, 'cache-control': cacheControl });
      res.end();
      return;
    }
    const headers = {
      ...SECURITY_HEADERS,
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body ? body.length : stat.size,
      'last-modified': stat.mtime.toUTCString(),
      etag,
      'cache-control': cacheControl,
    };
    if (download) headers['content-disposition'] = `attachment; filename="${path.basename(absolutePath)}"`;
    res.writeHead(200, headers);
    if (res.req.method === 'HEAD') {
      res.end();
      return;
    }
    if (body) {
      res.end(body);
      return;
    }
    await new Promise((resolve) => {
      const stream = fs.createReadStream(absolutePath);
      stream.on('error', () => {
        res.destroy();
        resolve();
      });
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }

  function resolveInside(baseDir, relative) {
    const decoded = decodeURIComponent(relative);
    if (decoded.includes('\0')) return null;
    const target = path.resolve(baseDir, `.${path.posix.normalize(`/${decoded}`)}`);
    const prefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
    if (target !== baseDir && !target.startsWith(prefix)) return null;
    return target;
  }

  /* ---------------- route handlers ---------------- */

  function listImages() {
    return images
      .slice()
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map(sanitizeImage);
  }

  /** Write a downloaded bitmap to disk and append its record atomically. */
  async function persistDownloaded(meta, downloaded) {
    const filename = `${randomUUID()}${downloaded.ext}`;
    const absolute = path.join(uploadsDir, filename);
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      ...meta,
      imageUrl: `/uploads/${filename}`,
      sourceUrl: downloaded.sourceUrl,
      bytes: downloaded.bytes,
      mime: downloaded.mime,
      createdAt: now,
      updatedAt: now,
      demo: false,
    };

    await fsp.writeFile(absolute, downloaded.buffer);
    try {
      await withLock(async () => {
        images.push(record);
        await persistImages();
      });
    } catch (error) {
      await fsp.rm(absolute, { force: true });
      throw error;
    }
    return record;
  }

  async function importImage(req, res) {
    const body = await readBody(req);
    const meta = cleanMeta(body);
    if (!body.url || typeof body.url !== 'string') throw new HttpError(400, '图片地址不能为空');

    let downloaded;
    try {
      downloaded = await fetchImage(body.url.trim());
    } catch (error) {
      if (error instanceof DownloadError) throw new HttpError(error.status, error.message);
      throw new HttpError(502, `下载图片失败：${error.message}`);
    }

    const record = await persistDownloaded(meta, downloaded);
    send(res, 201, { image: sanitizeImage(record) });
  }

  async function patchImage(req, res, id) {
    const body = await readBody(req);
    const meta = cleanMeta(body);
    const updated = await withLock(async () => {
      const index = images.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, '图片不存在');
      const current = images[index];

      // Echoing the existing identifiers back is harmless; changing them is not.
      if (body.id !== undefined && body.id !== current.id) {
        throw new HttpError(400, '图片标识不可修改');
      }
      const immutable = [
        ['url', current.sourceUrl],
        ['imageUrl', current.imageUrl],
        ['sourceUrl', current.sourceUrl],
      ];
      for (const [key, expected] of immutable) {
        if (body[key] !== undefined && String(body[key]) !== String(expected)) {
          throw new HttpError(400, '图片地址不可通过此接口修改，请删除后重新导入');
        }
      }

      const next = { ...current, ...meta, updatedAt: new Date().toISOString() };
      images[index] = next;
      await persistImages();
      return next;
    });
    send(res, 200, { image: sanitizeImage(updated) });
  }

  async function deleteImage(req, res, id) {
    const removed = await withLock(async () => {
      const index = images.findIndex((item) => item.id === id);
      if (index === -1) throw new HttpError(404, '图片不存在');
      const [record] = images.splice(index, 1);
      await persistImages();
      return record;
    });
    if (typeof removed.imageUrl === 'string' && removed.imageUrl.startsWith('/uploads/')) {
      const target = resolveInside(uploadsDir, removed.imageUrl.slice('/uploads/'.length));
      if (target) await fsp.rm(target, { force: true });
    }
    send(res, 200, { ok: true });
  }

  /**
   * Bulk delete / bulk tagging over the library.
   *
   * The route that reaches this is registered *before* `/api/images/:id` on
   * purpose: that pattern is `^/api/images/([^/]+)$`, so `POST /api/images/batch`
   * would otherwise be captured with id="batch" and answered with 405.
   */
  const BATCH_MAX_IDS = 200;

  async function batchImages(req, res) {
    const body = await readBody(req);
    const action = String(body.action || '').trim();
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
    if (!ids.length) throw new HttpError(400, '请至少选择一张图片');
    if (ids.length > BATCH_MAX_IDS) {
      throw new HttpError(400, `单次最多处理 ${BATCH_MAX_IDS} 张图片`);
    }
    const wanted = new Set(ids);

    if (action === 'delete') {
      const removed = await withLock(async () => {
        const gone = [];
        for (let index = images.length - 1; index >= 0; index -= 1) {
          if (wanted.has(images[index].id)) gone.push(images.splice(index, 1)[0]);
        }
        if (!gone.length) throw new HttpError(404, '选中的图片都不存在');
        await persistImages();
        return gone;
      });

      // Unlink the bitmaps only after the record write has committed. If
      // persistImages throws, the records survive and must keep pointing at
      // files that actually exist.
      for (const record of removed) {
        if (typeof record.imageUrl === 'string' && record.imageUrl.startsWith('/uploads/')) {
          const target = resolveInside(uploadsDir, record.imageUrl.slice('/uploads/'.length));
          if (target) await fsp.rm(target, { force: true });
        }
      }
      send(res, 200, { ok: true, action, affected: removed.length, images: listImages() });
      return;
    }

    if (action === 'tag') {
      const tags = cleanTags(body.tags);
      if (!tags.length) throw new HttpError(400, '请至少提供一个要添加的标签');

      // Plan every mutation before touching `images`, so a rejection part-way
      // through cannot leave the in-memory store diverged from what is on disk.
      const planned = [];
      let truncated = 0;
      images.forEach((item, index) => {
        if (!wanted.has(item.id)) return;
        const existing = Array.isArray(item.tags) ? item.tags.slice() : [];
        for (const tag of tags) {
          if (!existing.some((have) => have.toLowerCase() === tag.toLowerCase())) existing.push(tag);
        }
        if (existing.length > MAX_TAGS_PER_IMAGE) {
          truncated += 1;
          existing.length = MAX_TAGS_PER_IMAGE;
        }
        planned.push([index, existing]);
      });
      if (!planned.length) throw new HttpError(404, '选中的图片都不存在');

      await withLock(async () => {
        const now = new Date().toISOString();
        for (const [index, merged] of planned) {
          images[index] = { ...images[index], tags: merged, updatedAt: now };
        }
        await persistImages();
      });
      send(res, 200, {
        ok: true,
        action,
        affected: planned.length,
        truncated,
        images: listImages(),
      });
      return;
    }

    throw new HttpError(400, '不支持的批量操作，只能是 delete 或 tag');
  }

  /* ---------------- 后台图库（私有） ---------------- */

  /**
   * 列表。`q` 搜标题 / 提示词 / 标签；`limit` 上限 200，`offset` 分页。
   * 顺带把配额一起返回，前端能直接显示「已用 x / 上限 y」。
   */
  async function vaultListRequest(req, res, url) {
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset'));
    const result = await vault.list({
      q: url.searchParams.get('q') || '',
      sort: url.searchParams.get('sort') || 'newest',
      limit: Number.isFinite(limit) && limit > 0 ? limit : 60,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    });
    send(res, 200, { ...result, stats: await vault.stats() });
  }

  /**
   * 上传本地图片。
   *
   * 只信**字节本身**：`content-type` 是客户端说了算的，一张 `.exe` 改名成 `.png`
   * 也能带着 `image/png` 提交。所以每个分段都过一遍 `sniffImage`，认不出魔数的
   * 直接拒掉；落盘扩展名也用魔数推出来的那个，不用文件名里的。
   *
   * 部分失败不回滚已成功的：一次传 5 张、坏了 1 张，另外 4 张没有理由一起作废。
   * 响应里 `added` / `failed` 分开返回，前端逐条显示。
   */
  async function vaultUploadRequest(req, res) {
    const boundary = boundaryOf(req.headers['content-type']);
    if (!boundary) throw new HttpError(415, '上传必须使用 multipart/form-data');

    const raw = await readRawBody(req, MAX_VAULT_UPLOAD_BYTES);
    const parts = parseMultipart(raw, boundary, { maxParts: MAX_VAULT_UPLOAD_FILES + 8 });
    if (!parts.length) throw new HttpError(400, '没有解析到任何上传内容');

    const fields = {};
    const files = [];
    for (const part of parts) {
      if (part.filename) files.push(part);
      else if (part.name) fields[part.name] = part.data.toString('utf8');
    }
    if (!files.length) throw new HttpError(400, '请选择要上传的图片');
    if (files.length > MAX_VAULT_UPLOAD_FILES) {
      throw new HttpError(400, `单次最多上传 ${MAX_VAULT_UPLOAD_FILES} 张图片`);
    }

    const title = String(fields.title || '').trim();
    const prompt = String(fields.prompt || '').trim();
    const tags = String(fields.tags || '').trim();

    const added = [];
    const failed = [];
    for (const file of files) {
      const sniffed = sniffImage(file.data);
      if (!sniffed) {
        failed.push({
          filename: file.filename,
          error: '不是可识别的图片（支持 PNG / JPEG / GIF / WebP / AVIF）',
        });
        continue;
      }
      try {
        added.push(
          await vault.add({
            buffer: file.data,
            ext: sniffed.ext,
            mime: sniffed.mime,
            // 批量上传时共用一个标题会把它们全变成同名；单张才用统一标题。
            title: files.length === 1 && title ? title : titleFromFilename(file.filename) || title || '未命名',
            prompt,
            tags,
            source: 'upload',
          }),
        );
      } catch (error) {
        if (!(error instanceof VaultError)) throw error;
        failed.push({ filename: file.filename, error: error.message });
      }
    }

    if (!added.length) throw new HttpError(400, failed[0]?.error || '没有图片被导入');
    events.info(
      'vault',
      `后台图库新增 ${added.length} 张（本地上传）${failed.length ? `，${failed.length} 张被拒` : ''}`,
    );
    send(res, 201, { added, failed, stats: await vault.stats() });
  }

  /**
   * 从 24 小时生成记录导入一张。
   *
   * 字节走 `generationBytes()`，和「导入公开图库」是同一条路：预览缓存命中就不
   * 再回源，没命中才用受信源站去下载。这样网关回传本机地址的老问题不需要在这里
   * 再修一次。
   */
  async function vaultImportGenerationRequest(req, res) {
    const body = await readBody(req);
    const id = cleanString(body.id, { field: '生成记录 ID', max: 64, required: true });
    const raw = await generations.raw(id);
    if (!raw) throw new HttpError(404, '生成记录不存在或已超过 24 小时');

    const bytes = await generationBytes(id);
    const sniffed = sniffImage(bytes.buffer);
    if (!sniffed) throw new HttpError(415, '这条记录里的内容不是可识别的图片');

    const fallback = String(raw.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const item = await vault.add({
      buffer: bytes.buffer,
      ext: sniffed.ext,
      mime: sniffed.mime,
      title: String(body.title || '').trim() || fallback || '生成图片',
      prompt: raw.prompt || '',
      tags: body.tags,
      source: 'generation',
      sourceId: id,
    });
    events.info('vault', `后台图库新增 1 张（来自生成记录 ${id.slice(0, 8)}）`);
    send(res, 201, { item, stats: await vault.stats() });
  }

  async function vaultPatchRequest(req, res, id) {
    const body = await readBody(req);
    const item = await vault.patch(id, {
      title: body.title === undefined ? undefined : body.title,
      prompt: body.prompt === undefined ? undefined : body.prompt,
      tags: body.tags === undefined ? undefined : body.tags,
    });
    send(res, 200, { item });
  }

  async function vaultDeleteRequest(req, res, id) {
    await vault.remove(id);
    events.info('vault', '后台图库删除 1 张');
    send(res, 200, { ok: true, stats: await vault.stats() });
  }

  async function vaultBatchRequest(req, res) {
    const body = await readBody(req);
    const action = String(body.action || '').trim();
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
    if (!ids.length) throw new HttpError(400, '请至少选择一张图片');
    if (ids.length > 200) throw new HttpError(400, '单次最多处理 200 张图片');
    if (action !== 'delete') throw new HttpError(400, '不支持的批量操作，只能是 delete');

    const result = await vault.removeMany(ids);
    events.info('vault', `后台图库批量删除 ${result.removed} 张`);
    send(res, 200, { ok: true, affected: result.removed, stats: await vault.stats() });
  }

  /** 取原图。**必须登录**——这是私有图库和公开 `/uploads/` 的根本区别。 */
  async function serveVaultFile(req, res, id) {
    const target = await vault.absolutePath(id);
    if (!target) throw new HttpError(404, '图片不存在');
    await serveFile(res, target);
  }

  /**
   * 批量下载：把选中的图片打成一个 zip 流回去。
   *
   * 不用「前端逐个 `<a download>`」：同一个用户手势里连开多个下载，浏览器通常只放行
   * 第一个，用户会以为丢图了。打包还有一个好处——文件名带着标题，解压出来就是可读的。
   *
   * 流式写，长度未知，所以不设 `content-length`（走 chunked）。**头一旦发出去就无法
   * 再回 JSON**，中途失败只能断开连接让下载标红；因此所有可能拒绝的条件都在写头之前
   * 判定完（选中为空、超上限、一张都不存在）。
   */
  async function vaultArchiveRequest(req, res) {
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : [];
    if (!ids.length) throw new HttpError(400, '请至少选择一张图片');
    if (ids.length > ZIP_MAX_ENTRIES) throw new HttpError(400, `一次最多打包 ${ZIP_MAX_ENTRIES} 张图片`);

    const files = await vault.filesFor(ids);
    if (!files.length) throw new HttpError(404, '选中的图片都不存在');

    // 文件名用**本地时间**：`toISOString()` 是 UTC，晚上 11 点下载会得到第二天的日期，
    // 用户看到的和文件名对不上。
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="still-gallery-vault-${stamp}.zip"`,
      'cache-control': 'no-store',
    });

    // 背压：res.write 返回 false 说明内核缓冲满了，继续写只会把整个包堆进内存。
    const write = (chunk) =>
      new Promise((resolve) => {
        if (res.write(chunk)) resolve();
        else res.once('drain', resolve);
      });

    try {
      const result = await writeZip({
        entries: files,
        readFile: fsp.readFile,
        write,
        nameFor: (entry, index) => safeEntryName(entry.title, entry.ext, index),
      });
      events.info(
        'vault',
        `打包下载 ${result.count} 张（${Math.round(result.bytes / 1024 / 1024)}MB）${result.skipped ? `，跳过 ${result.skipped} 张丢失的文件` : ''}`,
      );
      res.end();
    } catch (error) {
      // 响应头已经发出去了，没法再换成 JSON。断开是唯一诚实的做法。
      events.error('vault', `打包下载失败：${error.message}`);
      res.destroy();
    }
  }

  /* ---------------- 后台剪贴板（私有，先进先出） ---------------- */

  /**
   * 列表。`q` 在文字里做子串匹配。
   *
   * 没有分页：上限就是 100 条，翻页只会让人多点一次「下一页」。
   */
  async function clipboardListRequest(req, res, url) {
    const result = await clipboard.list({ q: url.searchParams.get('q') || '' });
    send(res, 200, { ...result, stats: await clipboard.stats() });
  }

  /** 存一条纯文字（Markdown 源码）。带图片的走 /api/clipboard/upload。 */
  async function clipboardCreateRequest(req, res) {
    const body = await readBody(req, MAX_CLIPBOARD_BODY_BYTES);
    const text = cleanString(body.text, { field: '内容', max: CLIPBOARD_MAX_TEXT_CHARS, required: true });
    const result = await clipboard.add({ text, images: [], source: 'text' });
    // 只记条数和字数。**绝不记内容**——剪贴板里可能有密码、令牌，运行日志是
    // 页面上一眼可见的东西。
    events.info('clipboard', `剪贴板新增 1 条（文字 ${text.length} 字）${result.evicted ? `，挤出最早 ${result.evicted} 条` : ''}`);
    send(res, 201, result);
  }

  /**
   * 存一条图文。图片同样只信字节：每张都过 `sniffImage`，认不出魔数的整条拒掉。
   *
   * 这里和「后台图库上传」不同——那边坏一张、好的照进，因为每张是独立作品；
   * 而一条剪贴板是一个整体，缺一张图就变成残的，不如直接告诉用户哪一张有问题。
   */
  async function clipboardUploadRequest(req, res) {
    const boundary = boundaryOf(req.headers['content-type']);
    if (!boundary) throw new HttpError(415, '上传必须使用 multipart/form-data');

    const raw = await readRawBody(req, MAX_VAULT_UPLOAD_BYTES);
    const parts = parseMultipart(raw, boundary, { maxParts: CLIPBOARD_MAX_IMAGES + 4 });
    if (!parts.length) throw new HttpError(400, '没有解析到任何上传内容');

    const fields = {};
    const files = [];
    for (const part of parts) {
      if (part.filename) files.push(part);
      else if (part.name) fields[part.name] = part.data.toString('utf8');
    }
    if (files.length > CLIPBOARD_MAX_IMAGES) {
      throw new HttpError(400, `一条最多带 ${CLIPBOARD_MAX_IMAGES} 张图片`);
    }

    const text = String(fields.text || '').replace(/\r\n?/g, '\n');
    if (!text.trim() && !files.length) throw new HttpError(400, '内容不能为空');

    const images = [];
    for (const file of files) {
      const sniffed = sniffImage(file.data);
      if (!sniffed) {
        throw new HttpError(
          415,
          `「${file.filename || '未命名'}」不是可识别的图片（支持 PNG / JPEG / GIF / WebP / AVIF）`,
        );
      }
      if (file.data.length > CLIPBOARD_MAX_FILE_BYTES) {
        throw new HttpError(
          413,
          `「${file.filename || '未命名'}」超过 ${Math.round(CLIPBOARD_MAX_FILE_BYTES / 1024 / 1024)}MB`,
        );
      }
      images.push({ buffer: file.data, ext: sniffed.ext, mime: sniffed.mime });
    }

    const result = await clipboard.add({ text, images, source: 'upload' });
    events.info(
      'clipboard',
      `剪贴板新增 1 条（文字 ${text.trim().length} 字、图片 ${images.length} 张）${result.evicted ? `，挤出最早 ${result.evicted} 条` : ''}`,
    );
    send(res, 201, result);
  }

  async function clipboardPatchRequest(req, res, id) {
    const body = await readBody(req, MAX_CLIPBOARD_BODY_BYTES);
    const text = cleanString(body.text, { field: '内容', max: CLIPBOARD_MAX_TEXT_CHARS });
    const item = await clipboard.patch(id, { text });
    send(res, 200, { item });
  }

  async function clipboardDeleteRequest(req, res, id) {
    await clipboard.remove(id);
    events.info('clipboard', '剪贴板删除 1 条');
    send(res, 200, { ok: true, stats: await clipboard.stats() });
  }

  async function clipboardClearRequest(req, res) {
    const removed = await clipboard.clear();
    events.info('clipboard', `剪贴板已清空（${removed} 条）`);
    send(res, 200, { ok: true, removed, stats: await clipboard.stats() });
  }

  /** 取第 N 张图。**必须登录**，和后台图库同一个理由。 */
  async function serveClipboardImage(req, res, id, index) {
    const target = await clipboard.absoluteImagePath(id, index);
    if (!target) throw new HttpError(404, '图片不存在');
    await serveFile(res, target);
  }

  /* ---------------- agent log ingestion ---------------- */

  const LOG_BODY_BYTES = MAX_LOG_BYTES + 1024 * 1024;

  function readLogRequest(body) {
    const logText = typeof body.logText === 'string' ? body.logText : '';
    if (!logText.trim()) throw new HttpError(400, '日志内容为空');
    if (Buffer.byteLength(logText, 'utf8') > MAX_LOG_BYTES) {
      throw new HttpError(413, `日志超过 ${Math.round(MAX_LOG_BYTES / 1024 / 1024)}MB 上限`);
    }
    const rawLimit = Number(body.limit);
    return {
      logText,
      fileName: cleanString(body.fileName, { field: '日志文件名', max: 200 }) || 'uploaded.log',
      tags: cleanTags(body.tags),
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0,
      sessionIndexes: Array.isArray(body.sessionIndexes)
        ? body.sessionIndexes.map(Number).filter(Number.isFinite)
        : null,
    };
  }

  /**
   * Turn a parsed log into a dry-run plan. Nothing is downloaded here, so the
   * admin can see exactly what an import would do before committing to it.
   */
  function planFromLog(parsed, options) {
    const knownUrls = new Set(images.map((item) => item.sourceUrl).filter(Boolean));
    const sessions = options.limit > 0 ? parsed.sessions.slice(0, options.limit) : parsed.sessions;
    const selected = options.sessionIndexes
      ? sessions.filter((session) => options.sessionIndexes.includes(session.index))
      : sessions;

    const plan = [];
    const skipped = [];
    for (const session of selected) {
      if (session.status !== 'ok' || !session.imageUrl) {
        skipped.push({
          index: session.index,
          sessionId: session.sessionId,
          title: session.title,
          reason: '该会话未产出图片，仅返回了文字回复',
        });
        continue;
      }
      const expiresAt = session.imageUrlExpiresAt ? Date.parse(session.imageUrlExpiresAt) : null;
      plan.push({
        session,
        entry: sessionToEntry(session, { tags: options.tags, source: options.fileName }),
        urlExpired: expiresAt !== null && expiresAt <= Date.now(),
        alreadyImported: knownUrls.has(session.imageUrl),
      });
    }
    return { plan, skipped };
  }

  function planToResponse(plan) {
    return plan.map(({ session, urlExpired, alreadyImported }) => ({
      index: session.index,
      sessionId: session.sessionId,
      title: session.title,
      mode: session.mode,
      imageModel: session.imageModel,
      size: session.size,
      latencySeconds: session.totalSeconds,
      generatedAt: session.startedAt,
      promptLength: session.prompt.length,
      promptTruncated: session.promptTruncated,
      promptPreview: session.prompt.slice(0, 160),
      imageUrl: session.imageUrl,
      urlExpiresAt: session.imageUrlExpiresAt,
      urlExpired,
      alreadyImported,
    }));
  }

  async function runLogImport(options) {
    const parsed = parseWhiteboardLog(options.logText, { fileName: options.fileName });
    const { plan, skipped } = planFromLog(parsed, options);

    const imported = [];
    const failed = [];
    const skippedOut = skipped.map((item) => ({ ...item }));

    for (const item of plan) {
      const { session, entry } = item;
      if (item.alreadyImported) {
        skippedOut.push({ index: session.index, title: entry.title, reason: '该图片地址已在库中' });
        continue;
      }
      try {
        const downloaded = await fetchImage(session.imageUrl);
        const record = await persistDownloaded(entry, downloaded);
        imported.push({
          index: session.index,
          id: record.id,
          title: record.title,
          imageUrl: record.imageUrl,
          bytes: record.bytes,
        });
      } catch (error) {
        failed.push({
          index: session.index,
          title: entry.title,
          reason: error instanceof DownloadError ? error.message : `下载失败：${error.message}`,
        });
      }
    }

    return { fileName: options.fileName, stats: parsed.stats, imported, skipped: skippedOut, failed };
  }

  async function parseLogRequest(req, res) {
    const options = readLogRequest(await readBody(req, LOG_BODY_BYTES));
    const parsed = parseWhiteboardLog(options.logText, { fileName: options.fileName });
    const { plan, skipped } = planFromLog(parsed, options);
    send(res, 200, {
      fileName: options.fileName,
      stats: parsed.stats,
      warnings: parsed.warnings,
      plan: planToResponse(plan),
      skipped,
    });
  }

  async function importLogRequest(req, res) {
    const options = readLogRequest(await readBody(req, LOG_BODY_BYTES));
    send(res, 200, await runLogImport(options));
  }

  /* ---------------- image generation ---------------- */

  function rethrowGeneration(error) {
    if (error instanceof GenerationError) throw new HttpError(error.status, error.message);
    throw error;
  }

  /**
   * Normalise the request body into the input shape the client takes.
   *
   * The model is resolved here, *before* validation, because the size rules are
   * per family: validating against `ARK_DEFAULT_MODEL` and then calling the
   * operator's configured default would let `4K` pass the local check on the
   * way to a model that rejects it.
   */
  function buildGenerationInput(body, defaultModel) {
    return {
      mode: body.mode,
      prompt: body.prompt,
      model: body.model || defaultModel,
      size: body.size,
      // 只有 01ai 网关用得上：它没有尺寸像素，唯一的画幅开关就是 aspect。
      aspect: body.aspect,
      watermark: body.watermark,
      optimizeMode: body.optimizeMode,
      outputFormat: body.outputFormat,
      background: body.background,
      webSearch: body.webSearch,
      group: body.group,
      maxImages: body.maxImages,
      referenceImages: body.referenceImages,
    };
  }

  function requireGenerationKey(provider = currentProvider()) {
    if (provider === 'relay') {
      const relay = effectiveRelayConfig();
      if (!relay.token) {
        throw new HttpError(503, '尚未配置 01ai 网关口令，请先在「生成接口设置」中填写');
      }
      // 网关没有模型概念，保留一个默认值只是为了 meta 的形状一致。
      return { provider: 'relay', relay, defaultModel: ARK_DEFAULT_MODEL };
    }
    const config = effectiveArkConfig();
    if (!config.apiKey) {
      throw new HttpError(503, '尚未配置生图接口的 API Key，请先在「生成接口设置」中填写');
    }
    return { provider: 'ark', ark: config, defaultModel: config.defaultModel };
  }

  /**
   * 按上游校验并解析出 meta。直连和队列两条路径都必须走这里，否则两边会
   * 对同一份输入给出不同的判断。
   */
  function resolveGenerationMeta(input, provider) {
    if (provider !== 'relay') return buildGenerationPayload(input).meta;

    if (input.mode === 'text2group') {
      throw new GenerationError('01ai 网关不支持组图，请切换到方舟，或改用文生图 / 图生图', 400);
    }
    const references = Array.isArray(input.referenceImages)
      ? input.referenceImages.filter((item) => String(item ?? '').trim())
      : [];
    if (input.mode === 'image2image' && !references.length) {
      throw new GenerationError('图生图至少需要一张参考图片', 400);
    }
    return buildRelayPayload({
      prompt: input.prompt,
      aspect: input.aspect,
      referenceImages: references,
    }).meta;
  }

  /**
   * Perform one generation and time it.
   *
   * Shared by the direct route and the queue worker on purpose: both must return
   * the same shape *and* feed the same metrics, otherwise a queued run would be
   * invisible to the averages — and queued runs are exactly the ones an operator
   * wants timed.
   *
   * `meta` is the payload builder's resolved view of the request. It is only
   * consulted when the call *fails*: a failed attempt has no response to read
   * the model and size back out of, so the sample would otherwise claim the
   * request was against an unknown model.
   */
  async function runGeneration(input, { source, meta, provider } = {}) {
    // provider 由调用方在入队时捕获：队列里排着的任务不能因为操作者中途切了
    // 上游就改投另一家（那会静默改变计费方和参数含义）。
    const config = requireGenerationKey(provider);
    const startedAt = Date.now();
    const providerLabel = config.provider === 'relay' ? '01ai 网关' : '方舟';
    let result;

    try {
      result =
        config.provider === 'relay'
          ? await fetchRelayGeneration(input, {
              token: config.relay.token,
              baseUrl: config.relay.baseUrl,
              // 本机优先：先打 127.0.0.1:4399，连不上再退回上面的地址。
              localBaseUrl: config.relay.localBaseUrl,
              // 网关只认 data URL，远程参考图得先下载转 base64；复用带 SSRF
              // 防护的下载器，别再写一份。
              downloadImpl: fetchImage,
            })
          : await fetchGeneration(input, { apiKey: config.ark.apiKey, baseUrl: config.ark.baseUrl });
    } catch (error) {
      // A failed attempt is still a data point: it burns the same wall clock and
      // a model that keeps timing out should show up as such, not be averaged
      // away by its own successes.
      recordSample({
        model:
          (meta && meta.model) ||
          input.model ||
          (config.provider === 'relay' ? RELAY_MODEL_LABEL : config.defaultModel),
        mode: (meta && meta.mode) || input.mode,
        size: (meta && meta.size) || input.size,
        group: meta ? Boolean(meta.group) : Boolean(input.group),
        maxImages: meta ? meta.maxImages : input.maxImages,
        referenceCount: meta
          ? meta.referenceCount
          : Array.isArray(input.referenceImages)
            ? input.referenceImages.length
            : 0,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: generationMessage(error),
        source,
      });
      events.error('generate', `${providerLabel} 生成失败：${generationMessage(error)}`, {
        provider: config.provider,
        mode: (meta && meta.mode) || input.mode,
        ms: Date.now() - startedAt,
      });
      rethrowGeneration(error);
    }

    const durationMs = Date.now() - startedAt;
    const model = result.model || result.request.model;
    recordSample({
      model,
      mode: result.request.mode,
      size: result.request.size,
      group: Boolean(result.request.group),
      maxImages: result.request.maxImages,
      referenceCount: result.request.referenceCount,
      durationMs,
      ok: true,
      imageCount: result.images.length,
      source,
    });
    events.info('generate', `${providerLabel} 生成成功：${model} / ${result.images.length} 张 / ${durationMs}ms`, {
      provider: config.provider,
      mode: result.request.mode,
      size: result.request.size,
      ms: durationMs,
    });

    // 24 小时记录：只登记元数据，不在这里下载（见 lib/generation-store.mjs 顶部
    // 的三条约束）。内联（base64）结果已经在内存里，顺手落盘。
    const recorded = await recordGeneratedImages(result, input, config.provider, result.origin);

    return {
      request: result.request,
      model,
      generatedAt: result.generatedAt,
      durationMs,
      usage: result.usage,
      images: result.images.map((image, index) => ({
        index: index + 1,
        url: image.url,
        // Same-origin handle for the <img> tag; `url` stays the raw signed link
        // so "复制地址" and the importer keep working exactly as before.
        previewUrl: image.url ? mintPreview(image.url, result.origin) : '',
        b64: image.b64 ? true : false,
        size: image.size,
        expiresAt: image.expiresAt,
        // 「生成记录」里的 id，前端可以据此标记「已导入」而不必重新拉列表。
        recordId: recorded[index] ? recorded[index].id : '',
      })),
    };
  }

  /**
   * 把本次生成的每张图登记进 24 小时记录。
   *
   * 记录失败绝不能让一次已经计费的生成变成错误响应，所以整段吞掉异常，只留一条
   * warn 日志——最坏情况是这张图不出现在「生成记录」里，而生成结果本身照常返回。
   *
   * `origin` 是网关源站，随记录一起存：之后回源取原图时要靠它放行本机/内网的
   * 网关，见 `trustedOriginsOf`。
   */
  async function recordGeneratedImages(result, input, provider, origin = '') {
    const out = [];
    for (const image of result.images) {
      try {
        const inline = !image.url && image.b64 ? Buffer.from(String(image.b64), 'base64') : null;
        const sniffed = inline ? sniffImage(inline) : null;
        out.push(
          await generations.add({
            model: result.model || result.request.model,
            mode: result.request.mode,
            size: image.size || result.request.size,
            provider,
            group: Boolean(result.request.group),
            prompt: String(input.prompt ?? ''),
            url: image.url || '',
            sourceOrigin: origin,
            buffer: sniffed ? inline : null,
            ext: sniffed ? sniffed.ext : '',
            mime: sniffed ? sniffed.mime : '',
          }),
        );
      } catch (error) {
        out.push(null);
        events.warn('generate', `生成记录登记失败：${error.message}`);
      }
    }
    return out;
  }

  function getGenerateConfigRequest(req, res) {
    send(res, 200, describeGenerationConfig());
  }

  async function putGenerateConfigRequest(req, res) {
    const body = await readBody(req);
    const envLocked = Boolean(String(process.env.ARK_API_KEY || '').trim());
    const next = { ...settings };

    if (body.apiKey !== undefined) {
      if (envLocked) throw new HttpError(409, '已通过 ARK_API_KEY 环境变量配置密钥，界面上的修改不会生效');
      const key = cleanString(body.apiKey, { field: 'API Key', max: 400 });
      next.arkApiKey = key;
    }
    if (body.clearApiKey === true) {
      if (envLocked) throw new HttpError(409, '已通过 ARK_API_KEY 环境变量配置密钥，无法在此清除');
      next.arkApiKey = '';
    }
    if (body.baseUrl !== undefined) {
      const raw = cleanString(body.baseUrl, { field: '接口地址', max: 300 });
      if (!raw) {
        next.arkBaseUrl = ARK_DEFAULT_BASE_URL;
      } else {
        try {
          next.arkBaseUrl = normalizeBaseUrl(raw);
        } catch (error) {
          rethrowGeneration(error);
        }
      }
    }
    if (body.defaultModel !== undefined) {
      const raw = cleanString(body.defaultModel, { field: '默认模型', max: 120 });
      if (!raw) {
        next.defaultModel = ARK_DEFAULT_MODEL;
      } else {
        try {
          next.defaultModel = normalizeModel(raw);
        } catch (error) {
          rethrowGeneration(error);
        }
      }
    }

    // 上游切换。只接受这两个值，其余一律拒绝——静默回落到 ark 会让操作者
    // 以为已经切过去了，然后按网关的参数去请求方舟。
    if (body.provider !== undefined) {
      const raw = cleanString(body.provider, { field: '上游', max: 20 }).toLowerCase();
      if (raw !== 'ark' && raw !== 'relay') throw new HttpError(400, '上游只能是 ark 或 relay');
      next.provider = raw;
    }

    if (body.relayToken !== undefined) {
      if (String(process.env.IMAGE_RELAY_TOKEN || '').trim()) {
        throw new HttpError(409, '已通过 IMAGE_RELAY_TOKEN 环境变量配置口令，界面上的修改不会生效');
      }
      next.relayToken = cleanString(body.relayToken, { field: '网关口令', max: 400 });
    }
    if (body.clearRelayToken === true) {
      if (String(process.env.IMAGE_RELAY_TOKEN || '').trim()) {
        throw new HttpError(409, '已通过 IMAGE_RELAY_TOKEN 环境变量配置口令，无法在此清除');
      }
      next.relayToken = '';
    }
    if (body.relayBaseUrl !== undefined) {
      const raw = cleanString(body.relayBaseUrl, { field: '网关地址', max: 300 });
      if (!raw) {
        next.relayBaseUrl = RELAY_DEFAULT_BASE_URL;
      } else {
        try {
          next.relayBaseUrl = normalizeRelayBaseUrl(raw);
        } catch (error) {
          rethrowGeneration(error);
        }
      }
    }

    if (body.queueConcurrency !== undefined) {
      // 明确拒绝而不是静默钳制：填 64 被悄悄改成 32，操作者会以为设置没生效。
      const raw = Number(body.queueConcurrency);
      if (!Number.isInteger(raw) || raw < 1 || raw > MAX_CONCURRENCY) {
        throw new HttpError(400, `并发数必须是 1–${MAX_CONCURRENCY} 的整数`);
      }
      next.queueConcurrency = raw;
    }

    next.updatedAt = new Date().toISOString();
    settings = next;
    await persistSettings();
    // 改完立刻生效：调大就马上多起几个，调小只影响还没开始的任务。
    queue.setConcurrency(settings.queueConcurrency);
    send(res, 200, describeGenerationConfig());
  }

  /**
   * Register a generated image for same-origin preview and return its handle.
   * Only the URL the upstream just handed us is ever stored, so a client cannot
   * ask this process to fetch an arbitrary address.
   *
   * `origin` 是生图时真正回了话的网关源站。本机/内网部署的网关（例如
   * `http://127.0.0.1:4399`）吐回来的图片地址会被下载器当成保留地址拒掉，
   * 所以这里把源站一并记下，取图时只放行这一个来源。
   */
  function mintPreview(url, origin = '') {
    const token = randomUUID();
    previews.set(token, { url, origin: String(origin || ''), buffer: null, mime: '' });
    trimPreviews(token);
    return `/api/generate/preview/${token}`;
  }

  /** 把一条记录的源站转成下载器的白名单；没有源站就是空集（走完整校验）。 */
  function trustedOriginsOf(origin) {
    const value = String(origin || '').trim();
    return value ? [value] : [];
  }

  /**
   * 配置里声明的网关源站。
   *
   * 用来兜住**老记录**：`sourceOrigin` 是随这次修复才写进索引的，在那之前登记的
   * 记录没有这个字段，取原图时本机/内网网关的地址会被当成攻击拒掉（400 端口不被
   * 允许），表现成「生成成功、图也在，就是导不进来」。
   *
   * 这样放行是安全的：下载器只在「图片地址的 origin **恰好等于**白名单里的某一项」
   * 时才跳过端口与保留地址校验，而这几项全部来自运维自己写的配置，不是请求里带来的。
   * 把本机网关从配置里关掉（`IMAGE_RELAY_LOCAL_BASE=off`），这条路也就跟着关了。
   */
  function relayOrigins() {
    try {
      const relay = effectiveRelayConfig();
      const origins = new Set();
      for (const value of [relay.baseUrl, relay.localBaseUrl]) {
        try {
          origins.add(new URL(String(value || '')).origin);
        } catch {
          /* 配置里写错的候选直接忽略 */
        }
      }
      return [...origins];
    } catch {
      return [];
    }
  }

  /**
   * 预览缓存里有没有这张图的字节。
   *
   * 生成结果一贴出来，浏览器就会去 `/api/generate/preview/<token>` 取图——那一步
   * 已经把这批字节下载、验过魔数、放进了 `previews`。导入时再回源一次是**第二次**
   * 网络依赖，而这次依赖可能单独失败：网关前面挂了反代但 `/files/` 前缀没跟着转发、
   * 网关重启后端口变了、或者那个地址只对某个 Host 头有效。表现出来就是
   * 「预览看得见图，导入却 502」。
   *
   * 同一批字节已经在进程里了，就别再要一次。
   */
  function previewEntryFor(url) {
    if (!url) return null;
    for (const entry of previews.values()) {
      if (entry.url === url && entry.buffer && entry.buffer.length) return entry;
    }
    return null;
  }

  /** Stream a generated bitmap through this process, fetching it at most once. */
  async function servePreview(req, res, token) {
    const entry = previews.get(token);
    if (!entry) throw new HttpError(404, '预览已失效，请重新生成');

    if (!entry.buffer) {
      try {
        const downloaded = await fetchImage(entry.url, {
          trustedOrigins: trustedOriginsOf(entry.origin),
        });
        entry.buffer = downloaded.buffer;
        entry.mime = downloaded.mime;
        previewBytes += downloaded.buffer.length;
      } catch (error) {
        const message =
          error instanceof DownloadError ? error.message : '预览图片下载失败，请重新生成';
        throw new HttpError(502, message);
      }
    }

    // 触摸一次：正在被页面显示的图不应该因为「铸得早」而被淘汰。删掉再插回去，
    // Map 的插入顺序就成了 LRU 顺序。
    previews.delete(token);
    previews.set(token, entry);
    trimPreviews(token);

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': entry.mime || 'application/octet-stream',
      'content-length': entry.buffer.length,
      // Private: these are unimported generations, not public gallery assets.
      'cache-control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(entry.buffer);
  }

  /* ---------------- 24 小时生成记录 ---------------- */

  /**
   * 取一张生成记录的原图字节。
   *
   * 优先用预览缓存：那张图刚刚才在页面上显示过，字节就在进程里（见
   * `previewEntryFor`）。缓存里没有才回源下载并落盘（生成时不下载，理由见
   * `lib/generation-store.mjs`），之后同一张图直接读磁盘。回源失败时这里会 502，
   * 并把原因记在记录上，列表里就能直接看到「原图取不回来了」而不是一张永远
   * 转圈的灰图。
   */
  async function generationBytes(id) {
    const cached = await generations.read(id);
    if (cached) return cached;

    const raw = await generations.raw(id);
    if (!raw) throw new HttpError(404, '生成记录不存在或已超过 24 小时');
    if (!raw.url) throw new HttpError(410, '这张图没有可回源的地址');

    const preview = previewEntryFor(raw.url);
    let downloaded;
    if (preview) {
      downloaded = { buffer: preview.buffer, mime: preview.mime, ext: extForMime(preview.mime) };
    } else {
      try {
        downloaded = await fetchImage(raw.url, {
          trustedOrigins: [...trustedOriginsOf(raw.sourceOrigin), ...relayOrigins()],
        });
      } catch (error) {
        const message = error instanceof DownloadError ? error.message : '下载原图失败';
        await generations.markUnavailable(id, message).catch(() => {});
        throw new HttpError(502, `原图已经取不回来了：${message}`);
      }
    }

    // 落盘只是给「以后再取」省一次回源，失败不该让手里已有的字节作废。否则一次
    // 磁盘写入错误会被报成「原图取不回来了」，把排查一路引到网络上去。
    await generations.attach(id, downloaded).catch(() => {});
    return { buffer: downloaded.buffer, mime: downloaded.mime };
  }

  async function listGenerationsRequest(req, res, url) {
    const limit = Number(url.searchParams.get('limit'));
    const entries = await generations.list({
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(400, Math.floor(limit)) : 200,
    });
    send(res, 200, { entries, stats: await generations.stats(), keepHours: GENERATION_KEEP_MS / 3_600_000 });
  }

  async function serveGenerationFile(req, res, id) {
    const { buffer, mime } = await generationBytes(id);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': mime || 'application/octet-stream',
      'content-length': buffer.length,
      // 未导入的生成结果不是公开资产，和预览句柄同一个口径。
      'cache-control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(buffer);
  }

  async function importGenerationRequest(req, res, id) {
    const raw = await generations.raw(id);
    if (!raw) throw new HttpError(404, '生成记录不存在或已超过 24 小时');

    // 已经导入过、而且那张图还在库里，就不重复入库（否则同一张图会出现两份，
    // 提示词关联也会分叉）。库里删掉了的话允许重新导入。
    if (raw.importedId && images.some((item) => item.id === raw.importedId)) {
      throw new HttpError(409, '这张图已经导入过了');
    }

    const body = await readBody(req);
    const { buffer, mime } = await generationBytes(id);
    const prompt = String(body.prompt ?? raw.prompt ?? '');
    const title =
      cleanString(body.title, { field: '标题', max: 120 }) || autoTitle(prompt, 1, 1);

    const record = await persistDownloaded(
      {
        title,
        prompt,
        negativePrompt: '',
        model: raw.model,
        aspectRatio: raw.size,
        seed: '',
        steps: '',
        guidance: '',
        tags: cleanTags(body.tags),
        provenance: {
          source: 'AI 生成',
          mode: raw.mode,
          model: raw.model,
          size: raw.size,
          generatedAt: raw.createdAt,
          groupIndex: 1,
          groupTotal: 1,
          urlExpiresAt: '',
        },
      },
      { buffer, ext: extForMime(mime), bytes: buffer.length, mime, sourceUrl: raw.url || '' },
    );

    await generations.markImported(id, record.id);
    events.info('generate', `从生成记录导入：${record.title}`, { recordId: id });
    send(res, 201, { image: sanitizeImage(record) });
  }

  /** mime → 后缀。只有四种，写死比再引一张表省事。 */
  function extForMime(mime) {
    const key = String(mime || '').toLowerCase();
    if (key.includes('jpeg') || key.includes('jpg')) return '.jpg';
    if (key.includes('webp')) return '.webp';
    if (key.includes('gif')) return '.gif';
    if (key.includes('avif')) return '.avif';
    return '.png';
  }

  async function deleteGenerationRequest(req, res, id) {
    const removed = await generations.remove(id);
    if (!removed) throw new HttpError(404, '生成记录不存在或已超过 24 小时');
    send(res, 200, { ok: true });
  }

  async function clearGenerationsRequest(req, res) {
    const removed = await generations.clear();
    events.info('generate', `清空生成记录：${removed} 张`);
    send(res, 200, { ok: true, removed });
  }

  /**
   * Proxy one generation request. The browser never sees the API key, and the
   * upstream response is reduced to the fields the console actually needs.
   */
  async function generateRequest(req, res) {
    const config = requireGenerationKey();
    const body = await readBody(req, MAX_GENERATE_BODY_BYTES);
    const input = buildGenerationInput(body, config.defaultModel);

    // Validate here, at the trust boundary, rather than relying on the client to
    // do it: a malformed mode, an oversized reference or a `file:` URL must be
    // refused before anything is spent upstream. The client re-validates, which
    // costs nothing because the payload builder is pure.
    let meta;
    try {
      meta = resolveGenerationMeta(input, config.provider);
    } catch (error) {
      rethrowGeneration(error);
    }

    send(res, 200, await runGeneration(input, { source: 'direct', meta, provider: config.provider }));
  }

  /* ---------------- queued generation ---------------- */

  /**
   * Generation worker. `run` is the same function the direct route uses; the
   * parallelism comes from settings and is applied in `init()` (which runs
   * after this factory returns, so the persisted value is not known yet here).
   * Every call costs money and occupies an upstream slot, so the knob exists to
   * stay inside the account's quota rather than to go as fast as possible.
   */
  const queue = createJobQueue({
    concurrency: QUEUE_CONCURRENCY_DEFAULT,
    maxPending: QUEUE_MAX_PENDING,
    maxHistory: QUEUE_HISTORY_MAX,
    // The job's label is exactly the resolved meta a failed run needs.
    run: (job) =>
      runGeneration(job.input, {
        source: 'queue',
        meta: job.label,
        provider: job.label.provider,
      }),
  });

  async function enqueueGeneration(req, res) {
    const config = requireGenerationKey();
    const body = await readBody(req, MAX_GENERATE_BODY_BYTES);
    const input = buildGenerationInput(body, config.defaultModel);

    // Validate *now*, not when the job reaches the front of the queue: a job
    // that can never succeed must be refused while the operator is still
    // looking at the form.
    let meta;
    try {
      meta = resolveGenerationMeta(input, config.provider);
    } catch (error) {
      rethrowGeneration(error);
    }

    try {
      const job = queue.enqueue(input, {
        provider: config.provider,
        model: meta.model,
        mode: meta.mode,
        size: meta.size,
        group: meta.group,
        maxImages: meta.maxImages,
        referenceCount: meta.referenceCount,
        prompt: String(input.prompt || ''),
        promptPreview: String(input.prompt || '').replace(/\s+/g, ' '),
      });
      send(res, 202, { job, queue: queue.snapshot() });
    } catch (error) {
      if (error instanceof QueueError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }

  /** Shared plumbing for the per-job queue actions. */
  function queueAction(action) {
    return async (req, res) => {
      const body = await readBody(req);
      const id = cleanString(body.id, { field: '任务 ID', max: 64, required: true });
      try {
        if (action === 'cancel') send(res, 200, { job: queue.cancel(id), queue: queue.snapshot() });
        else send(res, 200, { job: queue.remove(id), queue: queue.snapshot() });
      } catch (error) {
        if (error instanceof QueueError) throw new HttpError(error.status, error.message);
        throw error;
      }
    };
  }

  async function queuePauseRequest(req, res) {
    const body = await readBody(req);
    // Absent flag means "pause"; an explicit false resumes.
    send(res, 200, { paused: queue.setPaused(body.paused !== false), queue: queue.snapshot() });
  }

  function queueClearRequest(req, res) {
    send(res, 200, { ok: true, removed: queue.clearFinished(), queue: queue.snapshot() });
  }

  function metricsRequest(req, res) {
    send(res, 200, { ...buildReport(samples), queue: queue.snapshot() });
  }

  async function handleApi(req, res, url) {
    const route = url.pathname;

    if (route === '/api/images' && req.method === 'GET') {
      send(res, 200, { images: listImages() });
      return true;
    }

    if (route === '/api/auth/status' && req.method === 'GET') {
      send(res, 200, { configured: Boolean(authRecord), authenticated: Boolean(currentSession(req)) });
      return true;
    }

    if (route === '/api/export' && req.method === 'GET') {
      requireAuth(req);
      send(res, 200, {
        version: 1,
        exportedAt: new Date().toISOString(),
        images: listImages(),
      });
      return true;
    }

    if (route === '/api/auth/setup' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      rateLimit(req, 'setup', 5, 10 * 60 * 1000);
      const body = await readBody(req);
      const password = cleanString(body.password, { field: '管理密码', max: 256, required: true });
      if (password.length < 10) throw new HttpError(400, '管理密码至少需要 10 个字符');
      if (authRecord) throw new HttpError(409, '管理者账户已存在，请直接登录');
      const salt = randomBytes(16).toString('hex');
      authRecord = { salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
      await writeJsonAtomic(authFile, authRecord);
      issueSession(res);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/auth/login' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      rateLimit(req, 'login', 8, 10 * 60 * 1000);
      const body = await readBody(req);
      const password = cleanString(body.password, { field: '管理密码', max: 256, required: true });
      if (!authRecord) throw new HttpError(409, '尚未设置管理者密码');
      if (!verifyPassword(password, authRecord)) throw new HttpError(401, '密码不正确');
      issueSession(res);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/auth/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      const key = currentSession(req);
      if (key) sessions.delete(key);
      res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      send(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/images' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'import', 30, 60 * 1000);
      await importImage(req, res);
      return true;
    }

    if (route === '/api/logs/parse' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'logparse', 30, 60 * 1000);
      await parseLogRequest(req, res);
      return true;
    }

    if (route === '/api/logs/import' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'logimport', 20, 60 * 1000);
      await importLogRequest(req, res);
      return true;
    }

    // Must be matched before the plain `/api/generate` route below; the token is
    // an opaque handle minted by this process, never a client-supplied URL.
    const previewRoute = /^\/api\/generate\/preview\/([A-Za-z0-9-]+)$/.exec(route);
    if (previewRoute && (req.method === 'GET' || req.method === 'HEAD')) {
      requireAuth(req);
      await servePreview(req, res, previewRoute[1]);
      return true;
    }

    /* ---------- 24 小时生成记录 ---------- */

    if (route === '/api/generations' && req.method === 'GET') {
      requireAuth(req);
      await listGenerationsRequest(req, res, url);
      return true;
    }

    if (route === '/api/generations' && req.method === 'DELETE') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'genclear', 6, 60 * 1000);
      await clearGenerationsRequest(req, res);
      return true;
    }

    const generationRoute = /^\/api\/generations\/([A-Za-z0-9-]+)(\/[a-z]+)?$/.exec(route);
    if (generationRoute) {
      const [, id, action] = generationRoute;
      if (action === '/file' && (req.method === 'GET' || req.method === 'HEAD')) {
        requireAuth(req);
        await serveGenerationFile(req, res, id);
        return true;
      }
      if (action === '/import' && req.method === 'POST') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'genimport', 60, 60 * 1000);
        await importGenerationRequest(req, res, id);
        return true;
      }
      if (!action && req.method === 'DELETE') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'gendelete', 60, 60 * 1000);
        await deleteGenerationRequest(req, res, id);
        return true;
      }
    }

    /* ---------- 后台图库（私有，只有管理员可见） ---------- */

    if (route === '/api/vault' && req.method === 'GET') {
      requireAuth(req);
      await vaultListRequest(req, res, url);
      return true;
    }

    // 这几条必须排在 `/api/vault/:id` 的正则之前，否则 "upload" / "batch" /
    // "from-generation" 会被当成 id 吃掉，回一个莫名其妙的 405。
    if (route === '/api/vault/upload' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'vaultupload', 120, 60 * 1000);
      await vaultUploadRequest(req, res);
      return true;
    }

    if (route === '/api/vault/from-generation' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'vaultgen', 60, 60 * 1000);
      await vaultImportGenerationRequest(req, res);
      return true;
    }

    if (route === '/api/vault/batch' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'vaultbatch', 30, 60 * 1000);
      await vaultBatchRequest(req, res);
      return true;
    }

    if (route === '/api/vault/archive' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      // 打包是 CPU + 磁盘顺序读，额度不需要很大；但也不能太小，用户会连点几次。
      rateLimit(req, 'vaultzip', 12, 60 * 1000);
      await vaultArchiveRequest(req, res);
      return true;
    }

    const vaultRoute = /^\/api\/vault\/([A-Za-z0-9-]+)(\/file)?$/.exec(route);
    if (vaultRoute) {
      const [, id, filePart] = vaultRoute;
      if (filePart && (req.method === 'GET' || req.method === 'HEAD')) {
        requireAuth(req);
        await serveVaultFile(req, res, id);
        return true;
      }
      if (!filePart && req.method === 'PATCH') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'vaultpatch', 60, 60 * 1000);
        await vaultPatchRequest(req, res, id);
        return true;
      }
      if (!filePart && req.method === 'DELETE') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'vaultdelete', 60, 60 * 1000);
        await vaultDeleteRequest(req, res, id);
        return true;
      }
      throw new HttpError(405, '不支持的请求方法');
    }

    /* ---------- 后台剪贴板（私有，先进先出） ---------- */

    if (route === '/api/clipboard' && req.method === 'GET') {
      requireAuth(req);
      await clipboardListRequest(req, res, url);
      return true;
    }

    if (route === '/api/clipboard' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'clippost', 120, 60 * 1000);
      await clipboardCreateRequest(req, res);
      return true;
    }

    if (route === '/api/clipboard' && req.method === 'DELETE') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'clipclear', 6, 60 * 1000);
      await clipboardClearRequest(req, res);
      return true;
    }

    // 和 /api/vault 一样，`upload` 必须排在 `:id` 的正则之前，否则它会被当成
    // 一条记录的 id，回一个莫名其妙的 405。
    if (route === '/api/clipboard/upload' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'clipupload', 60, 60 * 1000);
      await clipboardUploadRequest(req, res);
      return true;
    }

    const clipboardRoute = /^\/api\/clipboard\/([A-Za-z0-9-]+)(\/file\/(\d+))?$/.exec(route);
    if (clipboardRoute) {
      const [, id, filePart, imageIndex] = clipboardRoute;
      if (filePart && (req.method === 'GET' || req.method === 'HEAD')) {
        requireAuth(req);
        await serveClipboardImage(req, res, id, imageIndex);
        return true;
      }
      if (!filePart && req.method === 'PATCH') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'clippatch', 120, 60 * 1000);
        await clipboardPatchRequest(req, res, id);
        return true;
      }
      if (!filePart && req.method === 'DELETE') {
        if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
        requireAuth(req);
        rateLimit(req, 'clipdelete', 120, 60 * 1000);
        await clipboardDeleteRequest(req, res, id);
        return true;
      }
      throw new HttpError(405, '不支持的请求方法');
    }

    if (route === '/api/metrics' && req.method === 'GET') {
      requireAuth(req);
      metricsRequest(req, res);
      return true;
    }

    if (route === '/api/metrics' && req.method === 'DELETE') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'metrics', 10, 60 * 1000);
      samples = [];
      await persistMetrics();
      send(res, 200, { ok: true, ...buildReport(samples), queue: queue.snapshot() });
      return true;
    }

    if (route === '/api/logs' && req.method === 'GET') {
      requireAuth(req);
      const rawLimit = Number(url.searchParams.get('limit'));
      const take = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(events.limit, Math.floor(rawLimit)) : 200;
      const wanted = url.searchParams.get('level');
      const level = isLogLevel(wanted) ? String(wanted).toLowerCase() : 'debug';
      send(res, 200, { entries: events.list({ limit: take, level }), ...events.stats() });
      return true;
    }

    if (route === '/api/logs' && req.method === 'DELETE') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'logs', 10, 60 * 1000);
      const removed = events.clear();
      events.info('log', `清空了 ${removed} 条运行日志`);
      send(res, 200, { ok: true, removed, entries: events.list({ limit: 1 }), ...events.stats() });
      return true;
    }

    if (route === '/api/generate/queue' && req.method === 'GET') {
      requireAuth(req);
      send(res, 200, queue.snapshot());
      return true;
    }

    if (route === '/api/generate/queue' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      // Looser than direct generation on purpose: the queue is what keeps the
      // upstream from being hammered, so the real throttle is the worker.
      rateLimit(req, 'genqueue', 60, 60 * 1000);
      await enqueueGeneration(req, res);
      return true;
    }

    if (route === '/api/generate/queue/cancel' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      await queueAction('cancel')(req, res);
      return true;
    }

    if (route === '/api/generate/queue/remove' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      await queueAction('remove')(req, res);
      return true;
    }

    if (route === '/api/generate/queue/clear' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      queueClearRequest(req, res);
      return true;
    }

    if (route === '/api/generate/queue/pause' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      await queuePauseRequest(req, res);
      return true;
    }

    if (route === '/api/generate/config' && req.method === 'GET') {
      requireAuth(req);
      getGenerateConfigRequest(req, res);
      return true;
    }

    if (route === '/api/generate/config' && req.method === 'PUT') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'genconfig', 20, 60 * 1000);
      await putGenerateConfigRequest(req, res);
      return true;
    }

    if (route === '/api/generate' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      // Each call costs money upstream, so the ceiling is deliberately low.
      rateLimit(req, 'generate', 20, 10 * 60 * 1000);
      await generateRequest(req, res);
      return true;
    }

    // Registered ahead of the `/api/images/:id` pattern below, which would
    // otherwise capture "batch" as an id and answer 405.
    if (route === '/api/images/batch' && req.method === 'POST') {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      rateLimit(req, 'batch', 30, 60 * 1000);
      await batchImages(req, res);
      return true;
    }

    const match = route.match(/^\/api\/images\/([^/]+)$/);
    if (match) {
      if (!sameOrigin(req)) throw new HttpError(403, '请求来源不被信任');
      requireAuth(req);
      const id = decodeURIComponent(match[1]);
      if (req.method === 'PATCH') {
        await patchImage(req, res, id);
        return true;
      }
      if (req.method === 'DELETE') {
        await deleteImage(req, res, id);
        return true;
      }
      throw new HttpError(405, '不支持的请求方法');
    }

    if (route.startsWith('/api/')) {
      throw new HttpError(404, '接口不存在');
    }
    return false;
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持的请求方法');
    const route = url.pathname;

    if (route === '/admin' || route === '/admin/' || route === '/admin.html') {
      await serveFile(res, path.join(publicDir, 'admin.html'));
      return;
    }
    if (route === '/' || route === '/index.html') {
      await serveFile(res, path.join(publicDir, 'index.html'));
      return;
    }
    if (route.startsWith('/uploads/')) {
      const target = resolveInside(uploadsDir, route.slice('/uploads/'.length));
      if (!target) throw new HttpError(400, '非法路径');
      await serveFile(res, target);
      return;
    }
    const target = resolveInside(publicDir, route.replace(/^\//, ''));
    if (!target) throw new HttpError(400, '非法路径');
    await serveFile(res, target);
  }

  /**
   * 记一条请求日志。
   * - 静态资源不记：一次页面加载就是十几个请求，会把有用的行冲掉。
   * - `/api/logs` 不记：面板轮询自己，会自我放大。
   * - 成功的 GET 不记：画廊和队列都在轮询，成功的 GET 没有信息量。
   *
   * `reason` 是这次失败的原因，会跟在耗时后面。**这不是装饰**：线上前面通常挂着
   * CDN，5xx 的响应体会被换成一张通用错误页，前端 `api()` 只拿到「请求失败（502）」，
   * 真正的原因就这么丢了——而日志是唯一一定到得了运维眼前的通道。
   */
  function noteRequest(req, res, url, startedAt, reason = '') {
    if (!url || !url.pathname.startsWith('/api/')) return;
    if (url.pathname === '/api/logs') return;
    const status = Number(res.statusCode) || 0;
    if (req.method === 'GET' && status < 400) return;
    const ms = Date.now() - startedAt;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    // 401 不带原因：没登录这件事没有信息量，而且会把「哪些路径存在」写进日志。
    const detail = status >= 400 && status !== 401 ? summarizeReason(reason) : '';
    events[level]('http', `${req.method} ${url.pathname} → ${status}（${ms}ms）${detail}`, {
      status,
      ms,
    });
  }

  /** 压成一行、截断：一条错误不该把整个日志面板刷满。 */
  function summarizeReason(reason) {
    const text = String(reason || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return `：${text.length > 160 ? `${text.slice(0, 160)}…` : text}`;
  }

  const handler = async (req, res) => {
    const startedAt = Date.now();
    let url = null;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, url);
        if (handled) {
          noteRequest(req, res, url, startedAt);
          return;
        }
      }
      await handleStatic(req, res, url);
    } catch (error) {
      if (res.headersSent) {
        noteRequest(req, res, url, startedAt);
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        // 先 fail 再记账：noteRequest 读的是 res.statusCode，顺序反了会把 4xx 记成 200。
        fail(res, error.status, error.message);
        noteRequest(req, res, url, startedAt, error.message);
        return;
      }
      // 存储层的领域错误（配额满、标题为空、图片不存在）自带状态码。在这里统一
      // 翻译，比在每个 handler 里各包一次 try/catch 更难漏——漏了就会变成 500，
      // 而 500 会把「你选的那张图已经删了」误导成服务器崩了。
      if (error instanceof VaultError) {
        fail(res, error.status, error.message);
        noteRequest(req, res, url, startedAt, error.message);
        return;
      }
      // 剪贴板的领域错误同理（内容为空、条数/体积越界、记录不存在）。
      if (error instanceof ClipboardError) {
        fail(res, error.status, error.message);
        noteRequest(req, res, url, startedAt, error.message);
        return;
      }
      console.error('[still-gallery] unexpected error:', error);
      events.error('server', `未预期的异常：${error?.message || error}`);
      fail(res, 500, '服务器内部错误');
      noteRequest(req, res, url, startedAt, error?.message || '未预期的异常');
    }
  };

  const server = createServer(handler);

  return {
    server,
    handler,
    init,
    dataDir,
    publicDir,
    uploadsDir,
    /**
     * The live queue. Exposed so a caller with filesystem access — the test
     * suite, mainly — can await `queue.whenIdle()` instead of polling the HTTP
     * snapshot. It grants no reachability the HTTP API does not already have.
     */
    queue,
    /**
     * 运行日志。暴露给测试用来断言「失败被记下来了」，也方便常驻脚本自查。
     * 和 queue 一样，它不提供 HTTP 之外的任何新能力。
     */
    events,
    /** 24 小时生成记录。同样只为测试与自查暴露，不额外增加可达性。 */
    generations,
    /** 后台图库（私有）。同上：只为测试断言存储副作用，不增加 HTTP 可达性。 */
    vault,
    /** 后台剪贴板（私有）。同上。 */
    clipboard,
    listen({ port = 4317, host = '127.0.0.1' } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
    /**
     * Resolve once every queued store write has landed.
     *
     * Some writes are deliberately fire-and-forget — a slow disk must not fail
     * an already-billed generation — which means "the response came back" does
     * not imply "the file is on disk". Anything that needs that guarantee (the
     * test suite tearing a data directory down, a script about to read
     * metrics.json) should await this first.
     */
    flush() {
      return writeChain;
    },
    /**
     * Import path for callers that already have filesystem access — used by
     * `scripts/parse-log.mjs --local`, which skips HTTP and the admin password
     * entirely. Anyone able to call this could equally edit data/images.json by
     * hand, so it adds no reachability; it just reuses the same code path.
     * Stop the server first: it caches the store in memory and would otherwise
     * overwrite these writes on its next mutation.
     */
    async importLogLocally(logText, options = {}) {
      if (typeof logText !== 'string' || !logText.trim()) throw new Error('日志内容为空');
      if (Buffer.byteLength(logText, 'utf8') > MAX_LOG_BYTES) throw new Error('日志超过体积上限');
      return runLogImport({
        logText,
        fileName: options.fileName || 'uploaded.log',
        tags: cleanTags(options.tags || []),
        limit: Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 0,
        sessionIndexes: Array.isArray(options.sessionIndexes)
          ? options.sessionIndexes.map(Number).filter(Number.isFinite)
          : null,
      });
    },
    async planLogLocally(logText, options = {}) {
      const parsed = parseWhiteboardLog(logText, { fileName: options.fileName || '' });
      const { plan, skipped } = planFromLog(parsed, {
        fileName: options.fileName || '',
        tags: cleanTags(options.tags || []),
        limit: Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 0,
        sessionIndexes: null,
      });
      return { fileName: options.fileName || '', stats: parsed.stats, warnings: parsed.warnings, plan: planToResponse(plan), skipped };
    },
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT || 4317);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  await app.init();
  const address = await app.listen({ port, host });
  console.log(`Still Gallery 已启动 → http://${host}:${address.port}`);
  console.log(`画廊首页: http://${host}:${address.port}/`);
  console.log(`管理后台: http://${host}:${address.port}/admin`);

  /**
   * Graceful shutdown, for the process managers in `scripts/service/`
   * (systemd sends `KillSignal=SIGTERM`, launchd sends SIGTERM on
   * `launchctl kickstart -k` / `bootout`). Two reasons it is worth handling:
   *
   *  1. Metrics writes are fire-and-forget, so a hard kill can drop the last
   *     sample. `flush()` awaits the write chain.
   *  2. We exit **0** on an intentional stop. Both supervisors are configured to
   *     restart on *failure* only (`Restart=on-failure` / `SuccessfulExit=false`),
   *     so a zero exit is what keeps a clean stop from being immediately undone.
   *
   * A second signal while draining forces the exit instead of hanging. Note this
   * does not wait for in-flight generation: `close()` drops live connections, and
   * the queue is memory-only by design, so a restart clears it either way.
   */
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      console.error(`再次收到 ${signal}，强制退出。`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`收到 ${signal}，正在停止…`);
    let failed = false;
    try {
      await app.close();
      await app.flush();
    } catch (error) {
      failed = true;
      console.error(`停止过程中出错：${error?.message || error}`);
    }
    console.log('Still Gallery 已停止。');
    process.exit(failed ? 1 : 0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}
