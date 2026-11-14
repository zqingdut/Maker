/**
 * 最小 ZIP 写入器（store 模式，不压缩）。
 *
 * 后台图库要支持「勾选若干张 → 一次下载」。逐个触发 `<a download>` 会被浏览器拦
 * （同一手势内的多次下载通常只放行第一个），所以正确的做法是服务端打成一个包。
 *
 * 三条实现约束：
 *
 * 1. **不压缩。** PNG / JPEG / WebP 本来就是压缩过的，deflate 一遍只能省 0–2%，
 *    却要为此引入一个压缩实现（零依赖项目没有 zlib 的流式封装可用在任意 Buffer 上，
 *    而 `zlib.deflateRawSync` 会同步阻塞事件循环）。store 模式只需要 CRC32。
 * 2. **流式写，不把整个包读进内存。** 单张 15MB、一次最多 200 张，攒成一个大 Buffer
 *    峰值能到 GB 级。所以用 **data descriptor**（标志位 bit 3）：本地头里的 crc 和
 *    长度先写 0，正文边读边写边算 CRC，写完再补一个描述符。代价是中央目录必须最后写。
 * 3. **文件名只用于显示，且必须安全。** 标题是用户输入的，可能带 `/`、`..`、控制字符；
 *    这里一律剥掉，并加序号前缀保证唯一——否则同名两张在解压时会互相覆盖。
 *
 * 不支持 ZIP64：单文件 4GB / 总包 4GB 以上会直接拒绝，而不是生成一个坏包。
 */

/** 一次打包最多多少张。和 `/api/vault/batch` 的上限保持一致。 */
export const ZIP_MAX_ENTRIES = 200;
/** 总字节上限。超过就拒绝，避免解压方和本机都难受。 */
export const ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），ZIP 每个条目都要。 */
export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

/** JS 的 Date → DOS 时间戳（ZIP 里没有别的格式，1980 年之前会被钳到 1980）。 */
function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, date.getFullYear());
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * 把标题变成安全的包内文件名。
 *
 * 剥掉路径分隔符、Windows 保留字符和控制字符；空白压成一个空格；过长截断。
 * 真正的防重复靠调用方传进来的 `index` 前缀，这里只保证「单个名字是干净的」。
 */
export function safeEntryName(title, ext, index) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const suffix = String(ext || '').startsWith('.') ? String(ext) : `.${ext || 'png'}`;
  const prefix = String(index + 1).padStart(2, '0');
  return `${prefix}-${cleaned || 'image'}${suffix}`;
}

function localHeader(nameBuffer, { time, day, flags }) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // 解压所需版本
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(0, 8); // 0 = store
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  // crc / 压缩后 / 原始长度都留 0：真实值在 data descriptor 里。
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function dataDescriptor(size, crc) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(size, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(nameBuffer, { time, day, flags, size, crc, offset }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(0, 10); // store
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk start
  header.writeUInt16LE(0, 36); // internal attrs
  header.writeUInt32LE(0, 38); // external attrs
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory({ count, size, offset }) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(size, 12);
  record.writeUInt32LE(offset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

/**
 * 写一个 zip。
 *
 * @param {object} options
 * @param {Array<{name?: string, path: string, mtime?: Date|string}>} options.entries
 * @param {(path: string) => Promise<Buffer>} options.readFile
 * @param {(chunk: Buffer) => Promise<void>|void} options.write  必须正确处理背压
 * @param {(entry: object, index: number) => string} [options.nameFor] 覆盖默认命名
 * @returns {Promise<{count: number, bytes: number, skipped: number}>}
 */
export async function writeZip({ entries, readFile, write, nameFor } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('writeZip 需要至少一个条目');
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error(`一个包最多 ${ZIP_MAX_ENTRIES} 个文件`);

  // bit 3 = 长度与 CRC 在 data descriptor 里；bit 11 = 文件名是 UTF-8（中文标题必须）。
  const flags = 0x0008 | 0x0800;
  const central = [];
  let offset = 0;
  let total = 0;
  let count = 0;
  let skipped = 0;

  for (const [index, entry] of entries.entries()) {
    let buffer;
    try {
      buffer = await readFile(entry.path);
    } catch {
      // 文件被外部删了：跳过它，不要让整包失败——其余几十张没有理由一起丢。
      skipped += 1;
      continue;
    }
    if (total + buffer.length > ZIP_MAX_TOTAL_BYTES) {
      throw new Error(`打包体积超过 ${Math.round(ZIP_MAX_TOTAL_BYTES / 1024 / 1024 / 1024)}GB 上限`);
    }

    const name = nameFor ? nameFor(entry, index) : entry.name || `image-${index + 1}`;
    const nameBuffer = Buffer.from(name, 'utf8');
    const stamp = dosDateTime(entry.mtime instanceof Date ? entry.mtime : new Date(entry.mtime || Date.now()));
    const crc = crc32(buffer);

    const header = localHeader(nameBuffer, { ...stamp, flags });
    await write(header);
    await write(nameBuffer);
    await write(buffer);
    const descriptor = dataDescriptor(buffer.length, crc);
    await write(descriptor);

    central.push({ nameBuffer, stamp, size: buffer.length, crc, offset });
    offset += header.length + nameBuffer.length + buffer.length + descriptor.length;
    total += buffer.length;
    count += 1;
  }

  if (!count) throw new Error('没有可打包的文件');

  const centralOffset = offset;
  let centralSize = 0;
  for (const item of central) {
    const header = centralHeader(item.nameBuffer, { ...item.stamp, flags, size: item.size, crc: item.crc, offset: item.offset });
    await write(header);
    await write(item.nameBuffer);
    centralSize += header.length + item.nameBuffer.length;
  }
  await write(endOfCentralDirectory({ count, size: centralSize, offset: centralOffset }));

  return { count, bytes: total, skipped };
}

/** 测试与小数据量用：把所有分片收成一个 Buffer。 */
export async function buildZip(options) {
  const chunks = [];
  const result = await writeZip({ ...options, write: (chunk) => chunks.push(chunk) });
  return { ...result, buffer: Buffer.concat(chunks) };
}
