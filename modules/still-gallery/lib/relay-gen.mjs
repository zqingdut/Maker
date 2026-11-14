/**
 * 01ai 网关（api.01ai.fun）生图客户端。
 *
 * 和 `image-gen.mjs` 是**两个不同的上游协议**，不要合并：
 *
 *   方舟 Seedream   POST {base}/images/generations
 *                   {model, prompt, size, image[], sequential_image_generation…}
 *                   返回 data[]，每项是 24 小时后过期的 TOS 签名 URL
 *
 *   01ai 网关        POST {base}/v1/images
 *                   {mode:'image', prompt, aspect?, image?}
 *                   返回单张图，URL 内容寻址、不可变
 *
 * 网关刻意只实现四个字段，其余静默忽略（`model` / `seed` / `style` /
 * `negativePrompt` / `width` 传了也不生效）。所以这里**不提供**模型、种子、
 * 负向提示词、尺寸像素等参数——假装它们有用比不支持更糟。唯一能改画幅的是
 * `aspect`，而且网关自己不校验取值，未知比例会静默回落 4:3。
 *
 * 口令只经手于 `server.mjs`，本模块从参数里拿，不读环境、不落盘、不进日志。
 *
 * 地址是**本机优先的候选链**：先打 `http://127.0.0.1:4399`（本机网关 / 代理），
 * 连不上或那个地址上根本没有网关路由（404 / 405）才退回配置里的域名地址。
 * 回退只发生在「请求肯定没被网关处理过」的情况下——见 `isConnectFailure` 与 `isRouteMiss`。
 */
import { GenerationError } from './image-gen.mjs';
import { isPrivateHostname } from './address-guard.mjs';

export const RELAY_DEFAULT_BASE_URL = 'https://api.01ai.fun';
export const RELAY_DEFAULT_ASPECT = '4:3';

/**
 * 本机网关优先尝试的地址。设成 `off` / `none` / `0` 可以关掉本机优先。
 *
 * 4399 是本机 image-gateway 的默认端口（`outputs/image-gateway` 也监听这里），
 * 所以正常情况下这个候选就是「直连本机网关」。本机没起网关时它要么直接
 * `ECONNREFUSED`，要么被别的服务接住回 404 / 405——两种都必须退回域名地址，
 * 这正是 `isConnectFailure` 与 `isRouteMiss` 存在的意义。
 *
 * 别写成 still-gallery 自己的 4317：那个端口上永远只有画廊自己，网关模式
 * 会永远走不到本机网关。
 */
export const RELAY_LOCAL_BASE_URL = 'http://127.0.0.1:4399';

/** 关掉本机优先的取值。 */
const LOCAL_DISABLED = /^(off|none|false|no|0)$/i;

/**
 * 能确定「请求还没被网关收到」的 socket 错误。只认这些，因为生图是付费操作：
 * 读超时 / 连接被重置都可能已经出图计费，重试等于再付一次钱。
 */
const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 这个地址上有没有网关路由。404 / 405 说明没有：请求被别的东西接住了，
 * 不可能产生费用，可以换下一个候选。本机 4399 被别的服务占住时，它对
 * 未知路径的 POST 通常正是回 404 或 405。
 */
export function isRouteMiss(status) {
  return status === 404 || status === 405;
}

/** 只判断 socket 层的连接失败（含 undici 的 `cause` 链）。 */
export function isConnectFailure(error) {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return false;
  let node = error;
  const seen = new Set();
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    if (typeof node.code === 'string' && CONNECT_ERROR_CODES.has(node.code)) return true;
    node = node.cause;
  }
  return false;
}

/**
 * 网关文档里实测过的画幅。**这不是白名单**：网关刻意不校验 aspect，本地校验
 * 一旦比上游严格，就会把本来能成功的请求判成失败。这里只用来填下拉框。
 */
export const RELAY_ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

/** 实测像素，只用于在界面上标注「大概多大」，绝不用来反算请求参数。 */
export const RELAY_ASPECT_PIXELS = Object.freeze({
  '1:1': '1024×1024',
  '4:3': '1184×864',
  '3:4': '864×1184',
  '16:9': '1344×768',
  '9:16': '768×1344',
});

/** `GET /v1/config` 实测值，写在这里是为了在本地就给出可读的报错。 */
export const RELAY_MAX_PROMPT_CHARS = 4000;
export const RELAY_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** base64 膨胀 4/3，16MB 请求体反推约 11MB 原图，留一点余量。 */
export const RELAY_MAX_REFERENCE_BYTES = 11 * 1024 * 1024;
/** 网关一次只出一张，且 `image` 是单值字段，不是数组。 */
export const RELAY_MAX_REFERENCE_IMAGES = 1;
export const RELAY_TIMEOUT_MS = 180_000;

/** 指标按 model 聚合，网关没有模型概念，用一个固定标签代替。 */
export const RELAY_MODEL_LABEL = 'mago-relay';

/** 网关的语义错误码 → 给操作者看的中文。 */
const RELAY_ERRORS = {
  bad_mode: '网关只接受 mode=image',
  empty_prompt: '提示词不能为空',
  missing_token: '没有携带网关口令',
  invalid_token: '网关口令无效或已轮换',
  rate_limited: '网关限流了（每分钟 20 次）',
  upstream_error: '网关无法使用这张参考图',
  upstream: '网关背后的上游图像服务失败',
};

function fail(message) {
  throw new GenerationError(message, 400);
}

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

/**
 * 接受 base 地址或完整的 `/v1/images` 地址，返回要 POST 的 URL。
 *
 * 技能文档里的 `127.0.0.1:4399` 是原说明书的本地网关示例，不是真实地址；
 * 这里不做自动改写（改写等于替用户猜），但会拒绝非 https 的非本机地址，
 * 免得口令明文传输。
 */
export function resolveRelayEndpoint(baseUrl) {
  const raw = String(baseUrl ?? '').trim() || RELAY_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GenerationError('网关地址不是合法的 URL', 400);
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new GenerationError('网关地址必须使用 https（本机地址除外），以免口令以明文传输', 400);
  }
  if (url.username || url.password) {
    throw new GenerationError('网关地址不允许携带用户名或密码', 400);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1/images')) return url.toString();
  // 允许粘贴成 `https://host/api` 这种带前缀的地址。
  if (/\/v1$/.test(path)) return `${url.origin}${path}/images`;
  return `${url.origin}${path}/v1/images`;
}

/**
 * 要依次尝试的候选地址：本机优先，然后是配置里的地址。
 *
 * 本机地址与配置地址指向同一处时只留一个，免得对同一台机器发两遍请求。
 * `localBaseUrl` 传 `off` / `none` / `0` 可关掉本机优先（此时只剩配置地址）。
 */
export function resolveRelayEndpoints(baseUrl, { localBaseUrl = RELAY_LOCAL_BASE_URL } = {}) {
  const configured = resolveRelayEndpoint(baseUrl);
  const localRaw = String(localBaseUrl ?? '').trim();
  const candidates = [];
  if (localRaw && !LOCAL_DISABLED.test(localRaw)) {
    const local = resolveRelayEndpoint(localRaw);
    if (local !== configured) candidates.push(local);
  }
  candidates.push(configured);
  return candidates;
}

/** 存回 settings 的基础形式：把 `/v1/images` 拆掉，方便下次编辑。 */
export function normalizeRelayBaseUrl(baseUrl) {
  const url = new URL(resolveRelayEndpoint(baseUrl));
  const path = url.pathname.replace(/\/v1\/images\/?$/, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/* ------------------------------------------------------------------ *
 * 请求体
 * ------------------------------------------------------------------ */

/**
 * 校验并构造网关请求体。
 *
 * 注意这里**不做 aspect 白名单**：未知取值上游会回落 4:3，本地拦下来只会
 * 把能成功的请求变成失败。要提示就提示，不要拦。
 */
export function buildRelayPayload(input = {}) {
  const prompt = String(input.prompt ?? '').replace(/\r\n/g, '\n').trim();
  if (!prompt) fail('提示词不能为空');
  if (prompt.length > RELAY_MAX_PROMPT_CHARS) {
    fail(`网关的提示词上限是 ${RELAY_MAX_PROMPT_CHARS} 个字符（当前 ${prompt.length}）`);
  }

  const aspect = String(input.aspect ?? '').trim();
  const references = Array.isArray(input.referenceImages)
    ? input.referenceImages.filter((item) => String(item ?? '').trim())
    : [];

  if (references.length > RELAY_MAX_REFERENCE_IMAGES) {
    fail(`网关一次只能带 ${RELAY_MAX_REFERENCE_IMAGES} 张参考图`);
  }
  for (const [index, item] of references.entries()) {
    if (!String(item).startsWith('data:')) {
      // 到这一步还不该出现 http 地址：调用方必须先把远程图片转成 data URL。
      fail(`第 ${index + 1} 张参考图必须是 base64 data URL，网关不会替我们下载远程地址`);
    }
  }

  const payload = { mode: 'image', prompt };
  if (aspect) payload.aspect = aspect;
  if (references.length) payload.image = references[0];

  return {
    payload,
    meta: {
      // 复用方舟那套 meta 形状，队列、指标、前端都不用改字段名。
      mode: references.length ? 'image2image' : 'text2image',
      model: RELAY_MODEL_LABEL,
      size: aspect || RELAY_DEFAULT_ASPECT,
      aspect: aspect || RELAY_DEFAULT_ASPECT,
      aspectExplicit: Boolean(aspect),
      optimizeMode: '',
      outputFormat: '',
      background: '',
      webSearch: false,
      group: false,
      watermark: false,
      referenceCount: references.length,
      referenceKind: references.length ? 'base64' : 'none',
      maxImages: 1,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 响应
 * ------------------------------------------------------------------ */

/**
 * 把网关响应摊平成和方舟客户端一样的 `{images, model, ...}`。
 *
 * `url` 是内容寻址的，不会过期；但部分部署会返回 `127.0.0.1:4399/files/...`
 * 这种本地示例地址（说明书遗留），那种情况按 `id` + `mimeType` 用请求时的
 * origin 重建——否则前端拿到一个指向自己机器的死链。
 */
export function parseRelayResponse(body, context = {}) {
  if (!body || typeof body !== 'object') {
    throw new GenerationError('网关返回了无法解析的内容');
  }
  const id = String(body.id || '').trim();
  let url = String(body.url || '').trim();
  const mime = String(body.mimeType || 'image/png').trim();

  if (url) {
    try {
      const parsed = new URL(url);
      // 网关经常把它**自己那台机器**的地址原样吐回来：说明书里的
      // `http://127.0.0.1:4399/files/<id>.png` 示例、或者网关本身就部署在本机。
      // 这个地址在我们这边指向别处甚至根本不存在（下载器还会因为保留地址直接
      // 拒掉），所以要换成真正回了话的那个源站，只保留路径。
      if (isPrivateHostname(parsed.hostname)) {
        const origin = String(context.origin || '').replace(/\/+$/, '');
        const keepPath = /^\/files\/[^/]+$/.test(parsed.pathname);
        if (!origin) url = '';
        else if (keepPath) url = `${origin}${parsed.pathname}`;
        else url = id ? `${origin}/files/${id}.png` : '';
      }
    } catch {
      url = '';
    }
  }
  if (!url && id && context.origin) url = `${context.origin}/files/${id}.png`;
  if (!url) {
    throw new GenerationError('网关没有返回可用的图片地址');
  }

  const width = Number(body.width);
  const height = Number(body.height);
  const size = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? `${width}x${height}`
    : '';

  return {
    model: RELAY_MODEL_LABEL,
    created: null,
    // 网关不出内联 base64，也永远不返回签名过期时间。
    images: [{ url, b64: '', size, expiresAt: null, mime, sha256: String(body.sha256 || '') }],
    usage: null,
    relay: {
      id,
      cached: Boolean(body.cached),
      aspect: String(body.aspect || ''),
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      c2pa: Boolean(body.c2pa),
    },
  };
}

/** 绑定错误是 problem+json，语义错误是扁平 `{error}`，两种都要能读。 */
function relayErrorCode(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    if (parsed && typeof parsed.error === 'string') return parsed.error;
    if (parsed && parsed.errors && typeof parsed.errors === 'object') {
      const first = Object.keys(parsed.errors)[0];
      return first ? `bind:${first}` : '';
    }
  } catch {
    /* 不是 JSON */
  }
  return '';
}

export function describeRelayFailure(status, text) {
  const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  const code = relayErrorCode(text);

  if (status === 401 || status === 403) {
    const known = RELAY_ERRORS[code];
    return `网关口令${code === 'invalid_token' ? '无效或已轮换' : '缺失或无效'}（HTTP ${status}）${
      known && code !== 'invalid_token' && code !== 'missing_token' ? `：${known}` : ''
    }`;
  }
  if (status === 429) {
    return `网关限流了（HTTP 429，上限 20 次/分钟），请稍后再试${detail ? `：${detail}` : ''}`;
  }
  if (status === 502) {
    if (code === 'upstream_error') {
      return `网关无法使用这张参考图（HTTP 502）：网关只认 base64 data URL，且上游不接受该图。${detail ? `原始信息：${detail}` : ''}`;
    }
    return `网关背后的上游图像服务失败（HTTP 502），可以重试${detail ? `：${detail}` : ''}`;
  }
  if (status === 503 || status === 504) {
    return `网关暂时不可用或排队超时（HTTP ${status}），请稍后重试${detail ? `：${detail}` : ''}`;
  }
  if (status === 400) {
    if (code.startsWith('bind:')) {
      const field = code.slice(5);
      return `网关拒绝了请求参数：${field} 的 JSON 类型不对（HTTP 400）。${detail}`;
    }
    const known = RELAY_ERRORS[code];
    if (known) return `网关拒绝了请求（HTTP 400）：${known}`;
    return `网关拒绝了请求（HTTP 400）${detail ? `：${detail}` : ''}`;
  }
  return `网关返回状态码 ${status}${detail ? `：${detail}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * 调用
 * ------------------------------------------------------------------ */

/**
 * 把 http(s) 参考图下载下来转成 data URL。网关不会替我们下载远程地址
 * （传链接直接 502 upstream_error），所以这一步必须在本地做。
 *
 * `downloadImpl` 默认是 `lib/downloader.mjs` 的 `downloadImage`，它自带 SSRF
 * 防护（URL 白名单 → DNS 全量校验 → IP 钉进 socket）和 15MB 上限。
 */
export async function toReferenceDataUrl(value, { downloadImpl, index = 0 } = {}) {
  const raw = String(value ?? '').trim();
  if (raw.startsWith('data:')) return raw;
  if (typeof downloadImpl !== 'function') {
    throw new GenerationError(
      `第 ${index + 1} 张参考图是远程地址，但当前没有可用的下载器；请改用「上传本地图片」`,
      400,
    );
  }
  let downloaded;
  try {
    downloaded = await downloadImpl(raw);
  } catch (error) {
    throw new GenerationError(
      `第 ${index + 1} 张参考图下载失败：${error && error.message ? error.message : '未知错误'}`,
      400,
    );
  }
  if (!downloaded || !downloaded.buffer || !downloaded.buffer.length) {
    throw new GenerationError(`第 ${index + 1} 张参考图下载后为空`, 400);
  }
  if (downloaded.buffer.length > RELAY_MAX_REFERENCE_BYTES) {
    throw new GenerationError(
      `第 ${index + 1} 张参考图超过 ${Math.round(RELAY_MAX_REFERENCE_BYTES / 1024 / 1024)}MB 上限` +
        '（网关请求体上限 16MB，base64 会膨胀约 4/3）',
      400,
    );
  }
  const mime = downloaded.mime || 'image/png';
  return `data:${mime};base64,${downloaded.buffer.toString('base64')}`;
}

/**
 * @param {object} input 见 buildRelayPayload
 * @param {{ token: string, baseUrl?: string, fetchImpl?: Function,
 *           downloadImpl?: Function, timeoutMs?: number }} config
 */
export async function generateViaRelay(input, config = {}) {
  const token = String(config.token ?? '').trim();
  if (!token) {
    throw new GenerationError('尚未配置 01ai 网关口令', 503);
  }

  // 先把远程参考图转成 data URL，再构造请求体（构造时要校验它确实是 data URL）。
  const rawReferences = Array.isArray(input.referenceImages) ? input.referenceImages : [];
  const references = [];
  for (const [index, item] of rawReferences.entries()) {
    references.push(await toReferenceDataUrl(item, { downloadImpl: config.downloadImpl, index }));
  }

  const { payload, meta } = buildRelayPayload({ ...input, referenceImages: references });
  // 本机优先：先打 127.0.0.1:4399，连不上或那个地址没有网关路由时再退回域名地址。
  const endpoints = resolveRelayEndpoints(config.baseUrl, { localBaseUrl: config.localBaseUrl });
  const doFetch = config.fetchImpl || fetch;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : RELAY_TIMEOUT_MS;
  const requestBody = JSON.stringify(payload);

  let response = null;
  let endpoint = null;
  const tried = [];

  for (const [index, candidate] of endpoints.entries()) {
    const hasNext = index + 1 < endpoints.length;
    let attempt;
    try {
      attempt = await doFetch(candidate, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: requestBody,
        // 每次尝试都要一个新的计时器：复用同一个 signal 会让第二次尝试
        // 只剩第一次用剩下的时间。
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        // 超时不能换地址重发：请求可能已经到达上游并出图计费。
        throw new GenerationError(`网关请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`, 504);
      }
      if (isConnectFailure(error)) {
        tried.push(`${candidate}（${error.cause?.code || error.code || error.message}）`);
        if (hasNext) continue;
        // 最后一个候选也连不上：跳出循环，由下面的汇总报错列出所有尝试过的地址。
        break;
      }
      throw new GenerationError(`无法连接网关：${error.message}`, 502);
    }

    if (attempt.ok) {
      response = attempt;
      endpoint = candidate;
      break;
    }

    const text = await attempt.text().catch(() => '');
    // 404 / 405 说明这个地址上没有网关，请求没被处理过，可以换下一个。
    if (hasNext && isRouteMiss(attempt.status)) {
      tried.push(`${candidate}（HTTP ${attempt.status}）`);
      continue;
    }
    // 其余状态码一律不重试：网关已经处理过这次请求，重发就是再花一次钱。
    throw new GenerationError(describeRelayFailure(attempt.status, text), 502);
  }

  if (!response) {
    throw new GenerationError(
      `无法连接网关，已依次尝试：${tried.join(' → ') || endpoints.join(' → ')}`,
      502,
    );
  }

  const origin = new URL(endpoint).origin;
  const text = await response.text().catch(() => '');

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GenerationError('网关返回的不是合法 JSON');
  }

  const parsed = parseRelayResponse(body, { origin });
  return {
    ...parsed,
    // 真正回了话的那个源站。图片地址若被重写成这个源站下的路径，下载时就要
    // 把它当「操作者自己配置的网关」放行（本机部署时它是 127.0.0.1:4399）。
    origin,
    request: meta,
    generatedAt: new Date().toISOString(),
    endpoint,
  };
}
