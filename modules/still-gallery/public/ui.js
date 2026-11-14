/** Shared UI utilities: toasts, clipboard with fallback, tiny DOM helpers. */

const stack = () => document.getElementById('toastStack');

/* ------------------------------------------------------------------ *
 * 提示词字数预算
 * ------------------------------------------------------------------ */

/**
 * 手册 1 节：中文不超过 300 字、英文不超过 600 词。
 *
 * 这是**建议**不是硬限制（上游不会因为 301 个字就报错），所以这里只负责数，
 * 拦不拦由调用方决定——我们只在界面上提示，不挡用户提交。
 */
export const PROMPT_BUDGET = Object.freeze({ chars: 300, words: 600 });

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** 一个「词」至少要含一个字母或数字，纯标点不算。 */
const WORDISH_RE = /[0-9A-Za-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff]/;

/**
 * 中文字数 / 英文词数。混排时两个都算，因为手册给的是两条独立的建议上限。
 * 纯函数，不碰 DOM——前端用它渲染，测试直接 import 断言。
 */
export function promptBudget(text) {
  const raw = String(text ?? '');
  const cjk = (raw.match(CJK_RE) || []).length;
  const words = raw
    .replace(CJK_RE, ' ')
    .split(/\s+/)
    .filter((token) => WORDISH_RE.test(token)).length;
  return {
    cjk,
    words,
    overChars: cjk > PROMPT_BUDGET.chars,
    overWords: words > PROMPT_BUDGET.words,
    over: cjk > PROMPT_BUDGET.chars || words > PROMPT_BUDGET.words,
  };
}

/* ------------------------------------------------------------------ *
 * 交互编辑的坐标换算
 * ------------------------------------------------------------------ */

/**
 * `object-fit: contain` 时，图片在容器里实际画在哪。
 *
 * 交互编辑必须走这一步：把「屏幕上的框」直接当成原图坐标，插进提示词的
 * `<bbox>` 会整体偏移（容器有留白、图片可能被缩小），而上游是按原图像素
 * 理解这四个数的——错一点就框到别的地方。
 */
export function containRect({ boxWidth, boxHeight, naturalWidth, naturalHeight }) {
  if (!boxWidth || !boxHeight || !naturalWidth || !naturalHeight) return null;
  const scale = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return { scale, width, height, offsetX: (boxWidth - width) / 2, offsetY: (boxHeight - height) / 2 };
}

/** 屏幕坐标 → 原图像素（已钳进图片范围）。rect 是图片元素的 getBoundingClientRect()。 */
export function pointerToImagePixel({ clientX, clientY, rect, naturalWidth, naturalHeight }) {
  const fit = containRect({
    boxWidth: rect.width,
    boxHeight: rect.height,
    naturalWidth,
    naturalHeight,
  });
  if (!fit) return null;
  const x = (clientX - rect.left - fit.offsetX) / fit.scale;
  const y = (clientY - rect.top - fit.offsetY) / fit.scale;
  return {
    x: Math.min(naturalWidth, Math.max(0, Math.round(x))),
    y: Math.min(naturalHeight, Math.max(0, Math.round(y))),
  };
}

/** 两个角点 → `<bbox>x1 y1 x2 y2</bbox>`，左上角在前（上游按这个顺序读）。 */
export function bboxTag(start, end) {
  const x1 = Math.min(start.x, end.x);
  const y1 = Math.min(start.y, end.y);
  const x2 = Math.max(start.x, end.x);
  const y2 = Math.max(start.y, end.y);
  return `<bbox>${x1} ${y1} ${x2} ${y2}</bbox>`;
}

/** 单个点 → `<point>x y</point>`。 */
export function pointTag(point) {
  return `<point>${point.x} ${point.y}</point>`;
}

export function toast(message, variant = 'info', duration = 2600) {
  const host = stack();
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${variant}`;
  el.textContent = message;
  host.appendChild(el);
  window.setTimeout(() => {
    el.classList.add('leaving');
    window.setTimeout(() => el.remove(), 220);
  }, duration);
}

/**
 * Copy text to the clipboard. Uses the async Clipboard API when the page is a
 * secure context, and falls back to a hidden textarea + execCommand otherwise
 * (e.g. plain http://127.0.0.1 in some browsers).
 */
export async function copyText(text) {
  if (!text) throw new Error('empty');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (!ok) throw new Error('copy-failed');
  return true;
}

/**
 * Read text from the clipboard. Only works in a secure context (https or
 * localhost) and only from inside a user gesture — every browser rejects it
 * otherwise, and there is no legacy fallback (execCommand has no "paste").
 * The caller must therefore offer a manual-paste hint.
 */
export async function readText() {
  if (!window.isSecureContext || !navigator.clipboard || !navigator.clipboard.readText) {
    throw new Error('clipboard-unavailable');
  }
  return navigator.clipboard.readText();
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function api(path, options = {}) {
  /**
   * 只有「有 body 且不是 FormData」时才声明 JSON。
   *
   * 上传图片走的是 `FormData`，浏览器必须自己写 `content-type`——那里带着
   * 随机生成的 boundary，手写成 `application/json` 会让服务端一个分段都切不出来，
   * 表现为一个毫无线索的 400。
   */
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = options.body && !isFormData ? { 'content-type': 'application/json' } : undefined;
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers,
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    // 会话过期是全局事件，不是某个面板的私事：每个调用点各自处理只会变成
    // 一片「加载失败」，界面却还停在控制台上。抛事件让上层统一回到登录页。
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('sg:unauthorized', { detail: { path } }));
    }
    throw new Error((payload && payload.error) || `请求失败（${response.status}）`);
  }
  return payload;
}
