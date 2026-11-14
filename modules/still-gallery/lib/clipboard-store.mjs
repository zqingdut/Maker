/**
 * 后台剪贴板：最近 100 条「图文」内容的先进先出记录。
 *
 * 和后台图库的区别只在语义，不在信任级别：两个都是私有数据，都只对已登录的
 * 管理员可见。但生命周期正好相反——图库是长期资产（满了拒绝新增，绝不自己丢），
 * 剪贴板是**流水**（满了挤掉最旧的，这是需求本身）。所以这里没有任何配额报错，
 * 只有淘汰。
 *
 * 数据布局：
 *
 *   data/clipboard/        图片本体，文件名由服务端生成（`<uuid>.<ext>`）
 *   data/clipboard.json    索引（原子写，保留一份 .bak）
 *
 * 为什么不放 localStorage：图片塞不进去（5MB 配额），而且换台设备就没了。
 * 「本地持久化」在这个项目里的意思一直是「落在自己的 data/ 目录里」。
 *
 * 索引里**不存**图片字节，只存文件名和大小；文字原样存（Markdown 源码，不做
 * 渲染——渲染是前端的事，存下来的是用户复制的那份原文）。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMAGE_BYTES } from './downloader.mjs';

/** 保留多少条。超出后从最旧的开始挤掉。 */
export const CLIPBOARD_MAX_ITEMS = 100;
/** 单条文字上限。够放一整篇 Markdown 文档，又不至于把索引撑成几十 MB。 */
export const CLIPBOARD_MAX_TEXT_CHARS = 100_000;
/** 单条最多带几张图。 */
export const CLIPBOARD_MAX_IMAGES = 8;
/** 单张图片上限，和下载器/图库共用一个常量。 */
export const CLIPBOARD_MAX_FILE_BYTES = MAX_IMAGE_BYTES;
/**
 * 总字节上限。100 条 × 8 张 × 15MB 理论上能到 12GB，磁盘会先撑爆公开图库和
 * 生成记录，所以除了条数还要按字节卡一道，同样按先进先出淘汰。
 */
export const CLIPBOARD_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export class ClipboardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ClipboardError';
    this.status = status;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 文字只做最小规整：统一换行、去掉首尾空白。
 *
 * **不做** `\s+ → ' '` 那种压缩——那是图库标题用的规则。剪贴板里存的是 Markdown，
 * 换行和缩进就是语法本身，压平了代码块和列表全废。
 */
function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, CLIPBOARD_MAX_TEXT_CHARS);
}

/**
 * @param {object} options
 * @param {string} options.dir        图片落盘目录（data/clipboard）
 * @param {string} options.indexFile  索引文件（data/clipboard.json）
 * @param {number} [options.maxItems]
 * @param {number} [options.maxBytes]
 * @param {() => number} [options.now]
 */
export function createClipboardStore({
  dir,
  indexFile,
  maxItems = CLIPBOARD_MAX_ITEMS,
  maxBytes = CLIPBOARD_MAX_TOTAL_BYTES,
  now = () => Date.now(),
} = {}) {
  if (!dir || !indexFile) throw new Error('createClipboardStore 需要 dir 与 indexFile');

  /** @type {Array<object>} **新的在前**——列表和淘汰都按这个顺序，不用反复排序。 */
  let entries = [];
  let loaded = false;

  let writeChain = Promise.resolve();
  function withLock(task) {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const imagePath = (file) => path.join(dir, file);

  async function persist() {
    await fsp.mkdir(dir, { recursive: true });
    // 索引丢了就是「图还在、内容没了」，留一份上一版。
    await fsp.copyFile(indexFile, `${indexFile}.bak`).catch(() => {});
    await writeJsonAtomic(indexFile, { version: 1, entries });
  }

  function find(id) {
    return entries.find((item) => item.id === id) || null;
  }

  function totalBytes() {
    return entries.reduce(
      (sum, entry) => sum + entry.images.reduce((inner, image) => inner + (Number(image.bytes) || 0), 0),
      0,
    );
  }

  async function init() {
    if (loaded) return;
    await fsp.mkdir(dir, { recursive: true });
    let parsed = null;
    try {
      parsed = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    } catch {
      // 不存在或损坏都按空处理。图片文件还在，索引重建不了，但至少不会崩。
    }
    const raw = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    const next = [];
    for (const entry of raw) {
      if (next.length >= maxItems) break;
      if (!entry || typeof entry.id !== 'string' || !entry.id) continue;

      // 图片文件可能被外部删掉（手工清理、磁盘迁移）。逐张 stat 一次：留下一条
      // 指向空文件的记录，前端会渲染出一个永远加载失败的缩略图。
      const images = [];
      for (const image of Array.isArray(entry.images) ? entry.images : []) {
        if (!image || typeof image.file !== 'string' || !image.file) continue;
        const stat = await fsp.stat(imagePath(image.file)).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        images.push({
          file: image.file,
          mime: String(image.mime || ''),
          bytes: stat.size,
          key: String(image.key || ''),
        });
      }

      const text = cleanText(entry.text);
      // 文字和图都没了，这条就是空壳。
      if (!text && !images.length) continue;

      next.push({
        id: entry.id,
        text,
        images,
        source: entry.source === 'upload' ? 'upload' : 'text',
        createdAt: entry.createdAt || new Date(0).toISOString(),
      });
    }
    entries = next;
    loaded = true;
  }

  /** 对外形状。磁盘文件名不出门，只给「第几张」的取图地址。 */
  function publicEntry(entry) {
    return {
      id: entry.id,
      text: entry.text,
      chars: entry.text.length,
      images: entry.images.map((image, index) => ({
        index,
        mime: image.mime,
        bytes: image.bytes,
        url: `/api/clipboard/${entry.id}/file/${index}`,
      })),
      source: entry.source,
      createdAt: entry.createdAt,
    };
  }

  /** 同一条内容再存一次不该占两个位置：比较文字 + 每张图的 sha256。 */
  function sameAsNewest(text, imageKeys) {
    const head = entries[0];
    if (!head) return false;
    if (head.text !== text) return false;
    if (head.images.length !== imageKeys.length) return false;
    return head.images.every((image, index) => image.key === imageKeys[index]);
  }

  return {
    dir,
    indexFile,

    async init() {
      await init();
    },

    /**
     * 收一条。`images` 里的字节已经过魔数校验，这里只负责落盘、写索引、淘汰。
     *
     * 返回 `{ item, deduped, evicted }`：`evicted` 是这次被挤掉的条数，前端据此
     * 提示「最早的 N 条已被移出」——静默丢数据比丢数据本身更让人恼火。
     */
    async add({ text = '', images = [], source = 'text' } = {}) {
      await init();
      const body = cleanText(text);
      const files = Array.isArray(images) ? images : [];
      if (!body && !files.length) throw new ClipboardError('内容不能为空');
      if (files.length > CLIPBOARD_MAX_IMAGES) {
        throw new ClipboardError(`一条最多带 ${CLIPBOARD_MAX_IMAGES} 张图片`);
      }
      for (const file of files) {
        if (!Buffer.isBuffer(file?.buffer) || !file.buffer.length) {
          throw new ClipboardError('图片内容为空');
        }
        if (file.buffer.length > CLIPBOARD_MAX_FILE_BYTES) {
          throw new ClipboardError(
            `单张图片不能超过 ${Math.round(CLIPBOARD_MAX_FILE_BYTES / 1024 / 1024)}MB`,
            413,
          );
        }
      }

      const imageKeys = files.map((file) => crypto.createHash('sha256').update(file.buffer).digest('hex'));

      // 和最新一条完全相同：不新增，只把它提到最前面并更新时间。
      if (sameAsNewest(body, imageKeys)) {
        const head = entries[0];
        head.createdAt = new Date(now()).toISOString();
        await withLock(persist);
        return { item: publicEntry(head), deduped: true, evicted: 0 };
      }

      const id = crypto.randomUUID();
      const stored = [];
      await fsp.mkdir(dir, { recursive: true });
      try {
        for (const [index, file] of files.entries()) {
          const name = `${id}-${index}${file.ext || '.png'}`;
          await fsp.writeFile(imagePath(name), file.buffer);
          stored.push({
            file: name,
            mime: String(file.mime || ''),
            bytes: file.buffer.length,
            key: imageKeys[index],
          });
        }
      } catch (error) {
        // 一半图写进去了才失败：把已经落盘的清掉，不留孤儿文件。
        await Promise.all(stored.map((image) => fsp.rm(imagePath(image.file), { force: true }).catch(() => {})));
        throw error;
      }

      const entry = {
        id,
        text: body,
        images: stored,
        source: source === 'upload' ? 'upload' : 'text',
        createdAt: new Date(now()).toISOString(),
      };

      const evicted = [];
      try {
        await withLock(async () => {
          entries.unshift(entry);
          // 先进先出：条数超了挤最旧的；字节超了同样挤，但**永远留住刚进来的
          // 这一条**——单条超大的图片不该让「保存」看起来像没生效。
          while (entries.length > maxItems) evicted.push(entries.pop());
          while (entries.length > 1 && totalBytes() > maxBytes) evicted.push(entries.pop());
          await persist();
        });
      } catch (error) {
        await Promise.all(stored.map((image) => fsp.rm(imagePath(image.file), { force: true }).catch(() => {})));
        throw error;
      }

      // 索引先落盘再删文件：反过来的话，索引写失败会留下一堆指向空文件的记录。
      await Promise.all(
        evicted.flatMap((gone) =>
          gone.images.map((image) => fsp.rm(imagePath(image.file), { force: true }).catch(() => {})),
        ),
      );

      return { item: publicEntry(entry), deduped: false, evicted: evicted.length };
    },

    /**
     * 列表。`q` 在文字里做子串匹配（不区分大小写），没有分页——上限就是 100 条，
     * 翻页只会让人多点击一次。
     */
    async list({ q = '' } = {}) {
      await init();
      const needle = String(q || '').trim().toLowerCase();
      const matched = needle
        ? entries.filter((entry) => entry.text.toLowerCase().includes(needle))
        : entries.slice();
      return { total: matched.length, items: matched.map(publicEntry) };
    },

    async get(id) {
      await init();
      const entry = find(String(id || ''));
      return entry ? publicEntry(entry) : null;
    },

    /** 改文字。图片不动——换图请删了重存，那样才不会出现「索引说 2 张、磁盘 1 张」。 */
    async patch(id, { text } = {}) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) throw new ClipboardError('这条记录不存在', 404);
      const next = cleanText(text);
      if (!next && !entry.images.length) throw new ClipboardError('内容不能为空');
      entry.text = next;
      await withLock(persist);
      return publicEntry(entry);
    },

    async remove(id) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) throw new ClipboardError('这条记录不存在', 404);
      await withLock(async () => {
        entries = entries.filter((item) => item.id !== entry.id);
        await persist();
      });
      await Promise.all(
        entry.images.map((image) => fsp.rm(imagePath(image.file), { force: true }).catch(() => {})),
      );
      return publicEntry(entry);
    },

    /** 清空。返回被清掉的条数，前端用来提示。 */
    async clear() {
      await init();
      const gone = entries.slice();
      await withLock(async () => {
        entries = [];
        await persist();
      });
      await Promise.all(
        gone.flatMap((entry) =>
          entry.images.map((image) => fsp.rm(imagePath(image.file), { force: true }).catch(() => {})),
        ),
      );
      return gone.length;
    },

    /** 第 index 张图的绝对路径。索引和磁盘不同步时返回 null，由调用方回 404。 */
    async absoluteImagePath(id, index) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) return null;
      const image = entry.images[Number(index)];
      if (!image) return null;
      return imagePath(image.file);
    },

    async stats() {
      await init();
      return { count: entries.length, bytes: totalBytes(), maxItems, maxBytes };
    },
  };
}
