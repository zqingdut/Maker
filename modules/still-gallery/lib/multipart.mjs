/**
 * 最小 `multipart/form-data` 解析器。
 *
 * 这个项目没有依赖，也没有 `formidable` / `busboy` 可用，而后台图库必须能接收
 * 浏览器 `<input type="file">` 直接提交的表单——那是唯一不需要用户先把图片传到
 * 别处的上传方式。所以这里手写一个**只做一件事**的解析器。
 *
 * 三条实现约束：
 *
 * 1. **按 Buffer 切，不先转字符串。** 图片字节里出现 `0x0d 0x0a` 是常态，先
 *    `toString()` 再按行切会把二进制内容改坏（非法 UTF-8 会被替换成 U+FFFD）。
 *    这里全部用 `Buffer.indexOf` 定位分隔符，`data` 直接是原 Buffer 的视图。
 * 2. **不猜边界。** boundary 只从 `content-type` 里取，取不到就返回空数组——绝不
 *    用一个「看起来像」的默认值，那会把畸形请求解析成一堆垃圾数据。
 * 3. **有上限。** 一个请求最多解析 `maxParts` 个分段，防止构造一个几十万段的
 *    表单把内存和 CPU 拖死。总字节上限由调用方在读取阶段就卡住（见 server.mjs）。
 */

/** 单个请求最多解析多少个分段。20 张图 + 几个文本字段，留足余量。 */
export const MAX_MULTIPART_PARTS = 40;

const CRLF = Buffer.from('\r\n');

/**
 * 从 `content-type` 里取 boundary。
 *
 * 只接受 `multipart/form-data`；boundary 按 RFC 2046 校验（1–70 字符、不含空白），
 * 不合规一律返回空串，让调用方回 400 而不是拿一个可疑的值去切字节。
 */
export function boundaryOf(contentType) {
  const value = String(contentType || '');
  if (!/^multipart\/form-data\b/i.test(value)) return '';
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(value);
  const boundary = String((match && (match[1] || match[2])) || '').trim();
  if (!boundary || boundary.length > 70 || /\s/.test(boundary)) return '';
  return boundary;
}

/** `Name: value` 行解析成小写键的对象。重复键后者覆盖前者，够用。 */
function parseHeaders(block) {
  const out = {};
  for (const line of block.split('\r\n')) {
    if (!line) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    out[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return out;
}

/** 取 `name="x"` 这类参数；未加引号的值也认。 */
function dispositionParam(header, key) {
  const pattern = new RegExp(`(?:^|;)\\s*${key}=(?:"([^"]*)"|([^;\\s]*))`, 'i');
  const match = pattern.exec(header);
  if (!match) return '';
  return match[1] !== undefined ? match[1] : match[2] || '';
}

/** `filename*=UTF-8''%E4%B8%AD.png` → 中文.png。只认 UTF-8。 */
function decodeExtendedValue(value) {
  const match = /^([\w-]+)''(.*)$/.exec(String(value || ''));
  if (!match) return '';
  const charset = match[1].toLowerCase();
  if (charset !== 'utf-8' && charset !== 'utf8') return '';
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return '';
  }
}

/**
 * 解析一个 multipart 请求体。
 *
 * @param {Buffer} body
 * @param {string} boundary
 * @param {{maxParts?: number}} [options]
 * @returns {Array<{name: string, filename: string, contentType: string, data: Buffer}>}
 */
export function parseMultipart(body, boundary, { maxParts = MAX_MULTIPART_PARTS } = {}) {
  if (!Buffer.isBuffer(body) || !body.length || !boundary) return [];

  const delimiter = Buffer.from(`--${boundary}`);
  // 段与段之间的分隔符前面一定有一个 CRLF；用它定位，切出来的 data 才不含尾巴。
  const separator = Buffer.concat([CRLF, delimiter]);

  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return [];
  cursor += delimiter.length;

  const parts = [];
  while (parts.length < maxParts) {
    // 结束标记是 `--boundary--`；紧跟着的不是 CRLF 就是畸形，两种情况都停。
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) break;
    cursor += 2;

    const next = body.indexOf(separator, cursor);
    if (next === -1) break;

    const chunk = body.subarray(cursor, next);
    const split = chunk.indexOf('\r\n\r\n');
    cursor = next + separator.length;
    // 没有空行就没有正文，这个分段直接跳过，但不能因此中断后面的分段。
    if (split === -1) continue;

    const headers = parseHeaders(chunk.subarray(0, split).toString('utf8'));
    const disposition = headers['content-disposition'] || '';
    const extended = decodeExtendedValue(dispositionParam(disposition, 'filename\\*'));
    parts.push({
      name: dispositionParam(disposition, 'name'),
      // 浏览器把 UTF-8 文件名原样放进 `filename=`；`filename*` 出现时优先用它。
      filename: extended || dispositionParam(disposition, 'filename'),
      contentType: headers['content-type'] || '',
      data: chunk.subarray(split + 4),
    });
  }
  return parts;
}

/**
 * 从上传的文件名里提炼一个可读标题：去掉路径（含 Windows 反斜杠）、去掉扩展名。
 * 只用于显示，**绝不会**拿它当磁盘文件名——落盘名一律由服务端生成。
 */
export function titleFromFilename(filename) {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return base.slice(0, 120);
}
