/**
 * 后台图库（私有图库）的存储层。
 *
 * 和公开图库（`images.json` + `uploads/`）**完全分开**：公开图库的每一张都会出现在
 * 首页，而这里的每一张只对已登录的管理员可见。分成两个存储而不是给 `images` 加一个
 * `visibility` 字段，是因为「过滤条件写漏一次」的代价是私有图片直接上首页——用两个
 * 文件、两个目录、两条 API 前缀，漏不掉。
 *
 * 生命周期也不同：公开图库是作品集，生成记录只有 24 小时，而这里的东西是**长期
 * 资产**——没有过期时间，只有管理员主动删除和总量配额。
 *
 * 数据布局：
 *
 *   data/vault/          图片本体，文件名由服务端生成（`<uuid>.<ext>`）
 *   data/vault.json      索引（原子写，保留一份 .bak）
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MAX_IMAGE_BYTES } from './downloader.mjs';

/** 单张图片上限。和下载器共用同一个常量，避免两处各自漂移。 */
export const VAULT_MAX_FILE_BYTES = MAX_IMAGE_BYTES;
/** 索引条数上限。超过后拒绝新增，而不是悄悄删旧的——私有图库不该自己丢东西。 */
export const VAULT_MAX_ITEMS = 5000;
/** 总量配额，默认 4GB。磁盘写满会连带把公开图库和生成记录一起搞坏。 */
export const VAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

/** 合法来源。'upload' 本地文件，'generation' 从生成记录导入，'url' 由地址导入。 */
const SOURCES = new Set(['upload', 'generation', 'url']);

export class VaultError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'VaultError';
    this.status = status;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  const out = [];
  for (const item of raw) {
    const tag = cleanText(item, 24);
    if (!tag) continue;
    if (out.some((have) => have.toLowerCase() === tag.toLowerCase())) continue;
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.dir        图片落盘目录（data/vault）
 * @param {string} options.indexFile  索引文件（data/vault.json）
 * @param {number} [options.maxItems]
 * @param {number} [options.maxBytes] 总量配额
 * @param {() => number} [options.now]
 */
export function createVaultStore({
  dir,
  indexFile,
  maxItems = VAULT_MAX_ITEMS,
  maxBytes = VAULT_MAX_TOTAL_BYTES,
  now = () => Date.now(),
} = {}) {
  if (!dir || !indexFile) throw new Error('createVaultStore 需要 dir 与 indexFile');

  /** @type {Array<object>} 旧的在前。 */
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

  const filePathOf = (entry) => path.join(dir, entry.file);

  async function persist() {
    await fsp.mkdir(dir, { recursive: true });
    // 索引丢了就是「图还在、名字没了」，所以留一份上一版。
    await fsp.copyFile(indexFile, `${indexFile}.bak`).catch(() => {});
    await writeJsonAtomic(indexFile, { version: 1, entries });
  }

  function find(id) {
    return entries.find((item) => item.id === id) || null;
  }

  function totalBytes() {
    return entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  }

  async function init() {
    if (loaded) return;
    await fsp.mkdir(dir, { recursive: true });
    let parsed = null;
    try {
      parsed = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    } catch {
      // 不存在或损坏都按空处理：图片文件还在，索引可以重建（见 repair）。
    }
    const raw = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    entries = raw
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id && entry.file)
      .map((entry) => ({
        id: entry.id,
        title: cleanText(entry.title, 120),
        prompt: String(entry.prompt || '').slice(0, 8000),
        tags: cleanTags(entry.tags),
        source: SOURCES.has(entry.source) ? entry.source : 'upload',
        sourceId: String(entry.sourceId || ''),
        file: String(entry.file),
        mime: String(entry.mime || ''),
        bytes: Number(entry.bytes) || 0,
        createdAt: entry.createdAt || new Date(0).toISOString(),
        updatedAt: entry.updatedAt || entry.createdAt || new Date(0).toISOString(),
      }));
    loaded = true;
  }

  /** 对外形状。磁盘文件名不出门——它只在本模块内部用来拼路径。 */
  function publicEntry(entry) {
    return {
      id: entry.id,
      title: entry.title,
      prompt: entry.prompt,
      tags: entry.tags,
      source: entry.source,
      sourceId: entry.sourceId,
      mime: entry.mime,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      fileUrl: `/api/vault/${entry.id}/file`,
    };
  }

  return {
    dir,
    indexFile,

    async init() {
      await init();
    },

    /**
     * 收一张图。字节已经验过魔数，这里只负责配额、落盘、写索引。
     * 索引写失败会把刚落盘的文件删掉，不留孤儿。
     */
    async add({
      buffer,
      ext = '.png',
      mime = 'image/png',
      title = '',
      prompt = '',
      tags = [],
      source = 'upload',
      sourceId = '',
    } = {}) {
      await init();
      if (!Buffer.isBuffer(buffer) || !buffer.length) throw new VaultError('图片内容为空');
      if (buffer.length > VAULT_MAX_FILE_BYTES) {
        throw new VaultError(`单张图片不能超过 ${Math.round(VAULT_MAX_FILE_BYTES / 1024 / 1024)}MB`, 413);
      }
      if (entries.length >= maxItems) {
        throw new VaultError(`后台图库最多 ${maxItems} 张，请先删掉一些再上传`, 507);
      }
      if (totalBytes() + buffer.length > maxBytes) {
        throw new VaultError(
          `后台图库总容量已满（上限 ${Math.round(maxBytes / 1024 / 1024 / 1024)}GB），请先删除一些图片`,
          507,
        );
      }

      const id = crypto.randomUUID();
      const file = `${id}${ext}`;
      const createdAt = new Date(now()).toISOString();
      const entry = {
        id,
        title: cleanText(title, 120),
        prompt: String(prompt || '').slice(0, 8000),
        tags: cleanTags(tags),
        source: SOURCES.has(source) ? source : 'upload',
        sourceId: String(sourceId || ''),
        file,
        mime: String(mime || ''),
        bytes: buffer.length,
        createdAt,
        updatedAt: createdAt,
      };

      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, file), buffer);
      try {
        await withLock(async () => {
          entries.push(entry);
          await persist();
        });
      } catch (error) {
        await fsp.rm(path.join(dir, file), { force: true }).catch(() => {});
        throw error;
      }
      return publicEntry(entry);
    },

    /** 列表。`q` 搜标题 / 提示词 / 标签，排序只支持 newest / oldest / title。 */
    async list({ q = '', sort = 'newest', limit = 60, offset = 0 } = {}) {
      await init();
      const needle = cleanText(q, 120).toLowerCase();
      const matched = needle
        ? entries.filter((entry) =>
            [entry.title, entry.prompt, entry.tags.join(' ')]
              .join('\n')
              .toLowerCase()
              .includes(needle),
          )
        : entries.slice();

      if (sort === 'oldest') matched.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      else if (sort === 'title') matched.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
      else matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      const take = Math.min(Math.max(Math.floor(limit) || 60, 1), 200);
      const skip = Math.max(Math.floor(offset) || 0, 0);
      return {
        total: matched.length,
        items: matched.slice(skip, skip + take).map(publicEntry),
      };
    },

    async get(id) {
      await init();
      const entry = find(String(id || ''));
      return entry ? publicEntry(entry) : null;
    },

    /** 读字节。文件被外部删掉时返回 null，由调用方回 404。 */
    async read(id) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) return null;
      const buffer = await fsp.readFile(filePathOf(entry)).catch(() => null);
      if (!buffer) return null;
      return { buffer, mime: entry.mime || 'application/octet-stream' };
    },

    /** 绝对路径，给 `serveFile` 用（它自己处理 404 / ETag / HEAD）。 */
    async absolutePath(id) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) return null;
      return filePathOf(entry);
    },

    async patch(id, { title, prompt, tags } = {}) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) throw new VaultError('图片不存在', 404);
      if (title !== undefined) {
        const next = cleanText(title, 120);
        if (!next) throw new VaultError('标题不能为空');
        entry.title = next;
      }
      if (prompt !== undefined) entry.prompt = String(prompt || '').slice(0, 8000);
      if (tags !== undefined) entry.tags = cleanTags(tags);
      entry.updatedAt = new Date(now()).toISOString();
      await withLock(persist);
      return publicEntry(entry);
    },

    async remove(id) {
      await init();
      const entry = find(String(id || ''));
      if (!entry) throw new VaultError('图片不存在', 404);
      await withLock(async () => {
        entries = entries.filter((item) => item.id !== entry.id);
        await persist();
      });
      // 索引先落盘再删文件：反过来的话，索引写失败会留下一条指向空文件的记录。
      await fsp.rm(filePathOf(entry), { force: true }).catch(() => {});
      return publicEntry(entry);
    },

    async removeMany(ids) {
      await init();
      const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
      if (!wanted.size) throw new VaultError('请至少选择一张图片');
      const gone = entries.filter((entry) => wanted.has(entry.id));
      if (!gone.length) throw new VaultError('选中的图片都不存在', 404);
      await withLock(async () => {
        entries = entries.filter((entry) => !wanted.has(entry.id));
        await persist();
      });
      await Promise.all(gone.map((entry) => fsp.rm(filePathOf(entry), { force: true }).catch(() => {})));
      return { removed: gone.length, items: gone.map(publicEntry) };
    },

    /**
     * 批量取「打包下载」需要的信息：路径 + 标题 + 扩展名。
     *
     * 只返回磁盘上确实还有文件的那几条——索引和文件可能因为外部误删而不同步，
     * 让 zip 里出现一条 0 字节的条目比直接少一张更糟。
     */
    async filesFor(ids) {
      await init();
      const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
      const picked = entries.filter((entry) => wanted.has(entry.id));
      const out = [];
      for (const entry of picked) {
        const target = filePathOf(entry);
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        out.push({
          id: entry.id,
          title: entry.title,
          path: target,
          ext: path.extname(entry.file) || '.png',
          bytes: stat.size,
          mtime: stat.mtime,
        });
      }
      return out;
    },

    async stats() {
      await init();
      return { count: entries.length, bytes: totalBytes(), maxItems, maxBytes };
    },
  };
}
