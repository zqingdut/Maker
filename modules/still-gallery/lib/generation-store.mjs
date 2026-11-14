/**
 * 生成记录的 24 小时暂存区。
 *
 * 后台点「开始生成」之后，图片默认还留在上游（方舟 / 01ai 网关）的临时地址上：
 * 关掉页面就再也找不回来，队列里的结果重启即失，内联（base64）返回的那种连
 * 预览都做不了。这里给每次生成留一条记录，24 小时内可以随时回看、放大、导入。
 *
 * 三条设计约束：
 *
 * 1. **生成时不下载。** `runGeneration` 只写一条元数据（含上游地址），真正的
 *    字节在第一次「查看 / 导入」时才拉取并落盘。理由是生成路径已经在等上游出图，
 *    再串行下载 N 张会把「出图了没有」的反馈推迟好几秒；而且上游地址本身就有
 *    24 小时有效期，按需拉取和它天然对齐。落盘之后同一张图不再回源。
 * 2. **内联结果立刻落盘。** base64 已经在内存里，没有额外请求，顺手存下来才能
 *    让「内联返回的结果不能导入」这个老限制消失。
 * 3. **过期即删文件。** 24 小时是硬上限，剪枝时连字节一起删，不靠人工清理。
 *    提示词也只在这个窗口内留在磁盘上。
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 记录保留时长：24 小时，从生成成功那一刻算起。 */
export const GENERATION_KEEP_MS = 24 * 60 * 60 * 1000;
/** 条数上限，防止无人值守时把磁盘写满（24 小时内正常用不到）。 */
export const GENERATION_MAX = 400;
/** 提示词在列表里截断到这么长；完整提示词只用于导入。 */
export const PROMPT_PREVIEW_MAX = 200;

/** 原子写：先写临时文件再 rename，进程被杀不会留下半个 JSON。 */
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, file);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {object} options
 * @param {string} options.dir       图片落盘目录（data/generations）
 * @param {string} options.indexFile 索引文件（data/generations.json）
 * @param {number} [options.keepMs]  保留时长
 * @param {number} [options.max]     条数上限
 * @param {() => number} [options.now] 时钟，测试用
 */
export function createGenerationStore({
  dir,
  indexFile,
  keepMs = GENERATION_KEEP_MS,
  max = GENERATION_MAX,
  now = () => Date.now(),
} = {}) {
  if (!dir || !indexFile) throw new Error('createGenerationStore 需要 dir 与 indexFile');

  /** @type {Array<object>} 旧的在前，新的在后。 */
  let entries = [];
  let loaded = false;

  const absolute = (entry) => (entry.file ? path.join(dir, entry.file) : '');

  async function dropFile(entry) {
    if (!entry.file) return;
    await fsp.rm(path.join(dir, entry.file), { force: true }).catch(() => {});
  }

  /** 过期 + 超量，两把剪刀一起剪。返回是否有变化。 */
  async function prune() {
    const deadline = now() - keepMs;
    const keep = [];
    const dropped = [];
    for (const entry of entries) {
      const createdAt = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < deadline) dropped.push(entry);
      else keep.push(entry);
    }
    // 条数上限按时间倒着砍：entries 是旧的在前，所以从头部删。
    while (keep.length > max) dropped.unshift(keep.shift());
    if (!dropped.length) return false;
    entries = keep;
    await Promise.all(dropped.map(dropFile));
    return true;
  }

  async function persist() {
    await fsp.mkdir(dir, { recursive: true });
    await writeJsonAtomic(indexFile, { version: 1, entries });
  }

  /** 内部取原始记录；对外方法一律走这里，避免 `this` 绑定问题。 */
  function rawEntry(id) {
    return entries.find((item) => item.id === id) || null;
  }

  async function init() {
    if (loaded) return;
    await fsp.mkdir(dir, { recursive: true });
    let parsed = null;
    try {
      parsed = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
    } catch {
      // 文件不存在或损坏都按空处理：这是可再生的缓存，不是唯一副本。
    }
    const raw = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
    entries = raw
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
      .map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt || new Date(0).toISOString(),
        model: String(entry.model || ''),
        mode: String(entry.mode || ''),
        size: String(entry.size || ''),
        provider: String(entry.provider || ''),
        group: Boolean(entry.group),
        prompt: String(entry.prompt || ''),
        url: String(entry.url || ''),
        // 生成这张图时真正回了话的网关源站。下载原图时据此放行本机/内网的网关，
        // 见 server.mjs 的 trustedOrigins 用法。老记录没有这个字段，空串即「不信任」。
        sourceOrigin: String(entry.sourceOrigin || ''),
        file: String(entry.file || ''),
        mime: String(entry.mime || ''),
        bytes: Number(entry.bytes) || 0,
        importedId: String(entry.importedId || ''),
        unavailable: String(entry.unavailable || ''),
      }));
    loaded = true;
    if (await prune()) await persist();
  }

  /** 列表用的公开形状：不外泄上游签名地址，只说明「还在不在」。 */
  function publicEntry(entry) {
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      expiresAt: new Date(Date.parse(entry.createdAt) + keepMs).toISOString(),
      model: entry.model,
      mode: entry.mode,
      size: entry.size,
      provider: entry.provider,
      group: entry.group,
      prompt: entry.prompt,
      promptPreview:
        entry.prompt.length > PROMPT_PREVIEW_MAX
          ? `${entry.prompt.slice(0, PROMPT_PREVIEW_MAX)}…`
          : entry.prompt,
      bytes: entry.bytes,
      mime: entry.mime,
      stored: Boolean(entry.file),
      inline: !entry.url,
      importedId: entry.importedId,
      unavailable: entry.unavailable,
      fileUrl: `/api/generations/${entry.id}/file`,
    };
  }

  return {
    async init() {
      await init();
    },

    /**
     * 登记一张生成结果。`buffer` 存在时（内联结果）顺手落盘。
     * 返回公开形状；落盘失败不抛给调用方，只是这张图后面要看时会回源。
     */
    async add(record = {}) {
      await init();
      const id = crypto.randomUUID();
      const createdAt = new Date(now()).toISOString();
      const entry = {
        id,
        createdAt,
        model: cleanText(record.model, 120),
        mode: cleanText(record.mode, 32),
        size: cleanText(record.size, 32),
        provider: cleanText(record.provider, 16),
        group: Boolean(record.group),
        prompt: String(record.prompt ?? '').slice(0, 8000),
        url: String(record.url || ''),
        sourceOrigin: String(record.sourceOrigin || ''),
        file: '',
        mime: '',
        bytes: 0,
        importedId: '',
        unavailable: '',
      };

      if (Buffer.isBuffer(record.buffer) && record.buffer.length) {
        const ext = record.ext || '.png';
        const file = `${id}${ext}`;
        try {
          await fsp.mkdir(dir, { recursive: true });
          await fsp.writeFile(path.join(dir, file), record.buffer);
          entry.file = file;
          entry.mime = record.mime || 'image/png';
          entry.bytes = record.buffer.length;
        } catch {
          // 写不进去就退化成「按需回源」，不能因此让生成失败。
        }
      }

      entries.push(entry);
      if (await prune()) {
        /* prune 已经删过文件，这里只需要落索引 */
      }
      await persist();
      return publicEntry(entry);
    },

    async list({ limit = 200 } = {}) {
      await init();
      if (await prune()) await persist();
      const take = Math.max(1, Math.floor(Number(limit) || 200));
      // 按时间排而不是按数组顺序：正常情况下两者一致，但索引被手工改过（或系统
      // 时钟回拨）时，只有时间戳是可信的。
      return entries
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, take)
        .map(publicEntry);
    },

    async get(id) {
      await init();
      const entry = entries.find((item) => item.id === id);
      return entry ? publicEntry(entry) : null;
    },

    /** 原始记录（含上游地址），只给服务端自己用。 */
    async raw(id) {
      await init();
      return rawEntry(id);
    },

    /** 读已落盘的字节；没落盘返回 null，让调用方决定要不要回源。 */
    async read(id) {
      await init();
      const entry = rawEntry(id);
      if (!entry || !entry.file) return null;
      try {
        const buffer = await fsp.readFile(absolute(entry));
        return { buffer, mime: entry.mime || 'application/octet-stream' };
      } catch {
        return null;
      }
    },

    /** 把下载到的字节补写进磁盘，之后这张图不再回源。 */
    async attach(id, { buffer, ext = '.png', mime = 'image/png' } = {}) {
      await init();
      const entry = rawEntry(id);
      if (!entry) return null;
      if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
      const file = `${entry.id}${ext}`;
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, file), buffer);
      // 旧文件后缀可能不同，先删掉再记新的，避免孤儿。
      if (entry.file && entry.file !== file) await dropFile(entry);
      entry.file = file;
      entry.mime = mime;
      entry.bytes = buffer.length;
      entry.unavailable = '';
      await persist();
      return publicEntry(entry);
    },

    /** 回源失败就记下来，列表里直接说明原因，不再每次点都重试一遍。 */
    async markUnavailable(id, message) {
      await init();
      const entry = rawEntry(id);
      if (!entry) return;
      entry.unavailable = cleanText(message, 200);
      await persist();
    },

    async markImported(id, imageId) {
      await init();
      const entry = rawEntry(id);
      if (!entry) return;
      entry.importedId = String(imageId || '');
      await persist();
    },

    async remove(id) {
      await init();
      const index = entries.findIndex((item) => item.id === id);
      if (index === -1) return false;
      const [entry] = entries.splice(index, 1);
      await dropFile(entry);
      await persist();
      return true;
    },

    async clear() {
      await init();
      const removed = entries.length;
      const all = entries;
      entries = [];
      await Promise.all(all.map(dropFile));
      await persist();
      return removed;
    },

    async stats() {
      await init();
      return {
        count: entries.length,
        bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
        keepMs,
        max,
      };
    },
  };
}
