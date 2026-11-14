/**
 * 运行日志：固定容量的内存环形缓冲。
 *
 * 只解决一件事——后台出问题时（网关连不上、上游 4xx、密钥没配、队列任务失败）
 * 用户能在页面上看到「刚才到底发生了什么」，而不是只能翻 ssh 或浏览器控制台。
 *
 * 因此它**刻意不落盘**：进程重启即清空。没有轮转、没有保留策略，也就没有
 * 「日志里躺着别人的提示词和上游地址」这类隐私存量需要单独治理。
 *
 * 上限按条数而不是字节算：单条 message 已经截到 2000 字符，最坏情况下的内存
 * 占用是可推算的（limit × 2KB 量级），不需要再做字节计量。
 */

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

const RANK = new Map(LOG_LEVELS.map((level, index) => [level, index]));

export function isLogLevel(value) {
  return RANK.has(String(value ?? '').trim().toLowerCase());
}

/** 把外部传入的级别收敛成合法值；不认识的一律当 info，不抛错。 */
function normalizeLevel(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return RANK.has(raw) ? raw : 'info';
}

export function createEventLog({ limit = 500 } = {}) {
  const capacity = Math.max(1, Math.floor(Number(limit) || 500));
  const entries = [];
  let seq = 0;
  let dropped = 0;

  function push(level, scope, message, meta) {
    seq += 1;
    const entry = {
      id: seq,
      at: new Date().toISOString(),
      level: normalizeLevel(level),
      scope: String(scope || 'app').slice(0, 40),
      message: String(message ?? '').slice(0, 2000),
    };
    if (meta && typeof meta === 'object') entry.meta = meta;
    entries.push(entry);
    while (entries.length > capacity) {
      entries.shift();
      dropped += 1;
    }
    return entry;
  }

  return {
    limit: capacity,
    push,
    debug: (scope, message, meta) => push('debug', scope, message, meta),
    info: (scope, message, meta) => push('info', scope, message, meta),
    warn: (scope, message, meta) => push('warn', scope, message, meta),
    error: (scope, message, meta) => push('error', scope, message, meta),
    /**
     * 最新的在前——日志面板总是先看最后发生的事。
     * `level` 是**下限**（warn 表示只要 warn + error）。
     */
    list({ limit: take = 200, level = 'debug' } = {}) {
      const floor = RANK.get(String(level ?? '').trim().toLowerCase()) ?? 0;
      const want = Math.max(1, Math.floor(Number(take) || 200));
      const out = [];
      for (let index = entries.length - 1; index >= 0 && out.length < want; index -= 1) {
        if (RANK.get(entries[index].level) >= floor) out.push(entries[index]);
      }
      return out;
    },
    clear() {
      const removed = entries.length;
      entries.length = 0;
      dropped = 0;
      return removed;
    },
    stats() {
      return { size: entries.length, limit: capacity, dropped, total: seq };
    },
  };
}
