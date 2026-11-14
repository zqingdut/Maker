/**
 * Image downloader with SSRF protection.
 *
 * The guard works in three layers:
 *   1. the URL itself must be plain http/https, credential-free, on a common port
 *   2. every DNS answer is validated, and only public addresses are accepted
 *   3. the validated IP is pinned into the socket lookup, so the hostname cannot
 *      be re-resolved into a private address between the check and the connect
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isBlockedAddress } from './address-guard.mjs';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const REQUEST_TIMEOUT_MS = 15000;
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export class DownloadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DownloadError';
    this.status = status;
  }
}

/**
 * 「操作者自己配置的网关」的来源白名单。
 *
 * 这是给上游返回的图片地址用的，**不是**给请求里带来的地址用的：生图网关在
 * 本机或内网部署时，它吐回来的 `http://127.0.0.1:4399/files/x.png` 在我们的
 * 网络里完全合法，但通用 SSRF 规则会把它当攻击拦掉（端口不在白名单、地址是
 * 保留段）。白名单只由服务端从配置里算出来，永远不从请求里推导。
 */
function trustedOriginSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  const out = new Set();
  for (const item of value) {
    try {
      out.add(new URL(String(item)).origin);
    } catch {
      /* 配置写错的候选直接忽略，不影响其它候选 */
    }
  }
  return out;
}

export function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buffer.length >= 6) {
    const head = buffer.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return { ext: '.gif', mime: 'image/gif' };
  }
  if (buffer.length >= 12) {
    if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
      return { ext: '.webp', mime: 'image/webp' };
    }
    if (buffer.toString('latin1', 4, 8) === 'ftyp') {
      const brand = buffer.toString('latin1', 8, 12);
      if (brand === 'avif' || brand === 'avis') return { ext: '.avif', mime: 'image/avif' };
    }
  }
  return null;
}

export function parseImageUrl(raw, { trustedOrigins } = {}) {
  const trusted = trustedOriginSet(trustedOrigins);
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new DownloadError('图片地址不是合法的 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError('图片地址必须使用 http 或 https 协议');
  }
  if (url.username || url.password) {
    throw new DownloadError('图片地址不允许携带用户名或密码');
  }
  // 端口白名单只对「外来的」地址生效。配置里的网关可能跑在 4399 这类非常规
  // 端口上，那是操作者的选择，不是攻击面。
  if (!ALLOWED_PORTS.has(url.port) && !trusted.has(url.origin)) {
    throw new DownloadError('图片地址使用了不被允许的端口');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new DownloadError('图片地址缺少主机名');
  return { url, host };
}

export async function resolvePublicAddress(host) {
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isBlockedAddress(host)) throw new DownloadError('该地址指向内网或保留地址，已被拒绝');
    return { address: host, family: literalFamily };
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new DownloadError('无法解析该域名', 502);
  }
  if (!records.length) throw new DownloadError('无法解析该域名', 502);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new DownloadError('该域名解析到内网或保留地址，已被拒绝');
    }
  }
  return { address: records[0].address, family: records[0].family };
}

function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    if (options && options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };
}

function requestOnce(url, { address, family, headers }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        lookup: pinnedLookup(address, family),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            res.destroy();
            finish(reject, new DownloadError('图片体积超过 15MB 限制', 413));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(resolve, { status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', (error) => finish(reject, new DownloadError(`读取图片数据失败：${error.message}`, 502)));
      },
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      finish(reject, new DownloadError('下载图片超时', 504));
    });
    req.on('error', (error) => finish(reject, new DownloadError(`下载图片失败：${error.message}`, 502)));
    req.end();
  });
}

/**
 * 信任来源的地址解析：不做「只准公网」的判定。
 *
 * 仍然返回 `{address, family}`，因为后面要把它钉进 socket 的 lookup——白名单
 * 只是放行私有地址，不是放弃「校验过的 IP 才用于连接」这条防线。
 */
async function resolveTrustedAddress(host) {
  const literalFamily = net.isIP(host);
  if (literalFamily) return { address: host, family: literalFamily };
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new DownloadError('无法解析该域名', 502);
  }
  if (!records.length) throw new DownloadError('无法解析该域名', 502);
  return { address: records[0].address, family: records[0].family };
}

/**
 * @param {string} rawUrl
 * @param {{ fetchImpl?: (url: URL, ctx: object) => Promise<{status:number, headers:object, body:Buffer}>, resolveImpl?: (host:string)=>Promise<{address:string,family:number}>, trustedOrigins?: Iterable<string> }} [deps]
 *   `fetchImpl` exists purely so tests can exercise the post-download pipeline
 *   without touching the network. Production never injects it.
 *   `trustedOrigins` 只由服务端从配置算出（见 `trustedOriginSet`），用于放行
 *   部署在本机/内网的生图网关；外来地址永远走完整校验。
 */
export async function downloadImage(rawUrl, deps = {}) {
  const trusted = trustedOriginSet(deps.trustedOrigins);
  const resolveImpl = deps.resolveImpl || resolvePublicAddress;
  const fetchImpl = deps.fetchImpl || ((url, ctx) => requestOnce(url, ctx));

  let current = parseImageUrl(rawUrl, { trustedOrigins: trusted }).url;
  let redirects = 0;

  for (;;) {
    const host = current.hostname.replace(/^\[|\]$/g, '');
    // 信任按**每一跳**重新判定：重定向到别的源站就自动退回完整校验。
    const trustedHop = trusted.has(current.origin);
    const { address, family } = trustedHop
      ? await resolveTrustedAddress(host)
      : await resolveImpl(host);
    if (!trustedHop && isBlockedAddress(address)) {
      throw new DownloadError('该地址指向内网或保留地址，已被拒绝');
    }

    const response = await fetchImpl(current, {
      address,
      family,
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1',
        'user-agent': 'StillGallery/1.0 (+image-import)',
      },
    });

    if (REDIRECT_CODES.has(response.status)) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new DownloadError('图片地址重定向次数过多', 502);
      const location = response.headers && response.headers.location;
      if (!location) throw new DownloadError('图片地址重定向缺少目标地址', 502);
      const next = new URL(String(location), current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new DownloadError('重定向目标不是 http/https 地址', 502);
      }
      if (current.protocol === 'https:' && next.protocol === 'http:') {
        throw new DownloadError('拒绝从 https 降级到 http 的重定向', 502);
      }
      current = next;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new DownloadError(`图片来源返回状态码 ${response.status}`, 502);
    }

    const contentType = String((response.headers && response.headers['content-type']) || '').toLowerCase();
    if (/text\/html|image\/svg|application\/xml|text\/xml/.test(contentType)) {
      throw new DownloadError('该地址返回的不是可用的位图图片');
    }
    if (!response.body || !response.body.length) {
      throw new DownloadError('图片来源返回了空内容', 502);
    }
    if (response.body.length > MAX_IMAGE_BYTES) {
      throw new DownloadError('图片体积超过 15MB 限制', 413);
    }

    const sniffed = sniffImage(response.body);
    if (!sniffed) {
      throw new DownloadError('无法识别的图片格式（仅支持 PNG / JPEG / GIF / WebP / AVIF）');
    }

    return {
      buffer: response.body,
      ext: sniffed.ext,
      mime: sniffed.mime,
      sourceUrl: rawUrl,
      finalUrl: current.toString(),
      bytes: response.body.length,
    };
  }
}
