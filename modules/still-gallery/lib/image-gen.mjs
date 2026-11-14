/**
 * Doubao Seedream image generation client (Volcengine Ark protocol).
 *
 * Three request shapes, all on one endpoint:
 *   text2image   — prompt only, one image
 *   text2group   — prompt only, `sequential_image_generation: "auto"`, up to 15 images
 *   image2image  — one to fourteen reference images + prompt, one image
 *                  (optionally also a group, when `group` is set)
 *
 * The API key is never stored here and never appears in an error message. Callers
 * pass it in per request; `server.mjs` is the only place that knows where it
 * comes from (environment variable first, then data/settings.json).
 */
import { extractUrlExpiry } from './signed-url.mjs';

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_DEFAULT_MODEL = 'doubao-seedream-4-0-20260415';

// Size suggestions used to live here as one global list. That list is what made
// `4K` offerable to Seedream 5.0 pro, which rejects it — see `sizeSuggestionsFor`
// below, which derives the options from each family's own limits.

export const MODES = ['text2image', 'text2group', 'image2image'];
export const MODE_LABELS = {
  text2image: '文生图',
  text2group: '文生组图',
  image2image: '图生图',
};

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp'];
export const BACKGROUNDS = ['opaque', 'transparent'];

export const MAX_PROMPT_CHARS = 8000;
export const MAX_MODEL_CHARS = 120;
/** Ceiling across all families; the per-model limit below is usually lower. */
export const MAX_REFERENCE_IMAGES = 14;
export const MAX_GROUP_IMAGES = 15;
/** Ark rejects base64 reference images above ~10MB; we hold the line one byte under. */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_URL_CHARS = 2048;
/** Generation is slow: a 4K group of fifteen can legitimately run for minutes. */
export const GENERATION_TIMEOUT_MS = 180_000;

/**
 * `size` is NOT uniform across families, and this is the single easiest way to get
 * an opaque `InvalidParameter` 400 back from Ark:
 *
 *   Seedream 5.0 pro / flash  presets 1K / 1.5K / 2K (default 2K) — no 4K.
 *                             Explicit WxH must land in 921600–4624220 total pixels
 *                             (1280x720 … 2048x2048×1.1025), aspect ratio 1/16–16.
 *   Seedream 5.0 lite         presets 2K / 3K / 4K.
 *   Seedream 4.5              presets 2K / 4K.
 *   Seedream 4.0              presets 1K / 2K / 4K.
 *
 * The preset form and the explicit `WIDTHxHEIGHT` form cannot be mixed, but either
 * is accepted on its own. Both are validated per model below.
 *
 * `1.5K` is not a fifth rung on the same ladder: for 5.0 pro/flash it costs the
 * same as 1K and looks better, which is why the doc recommends it. It is also why
 * dropping it (as this file used to) silently removes the best value for money.
 */
export const SIZE_ASPECT_MIN = 1 / 16;
export const SIZE_ASPECT_MAX = 16;
/** Side bounds for the explicit form, shared by every family. */
export const SIZE_MIN_SIDE = 512;
export const SIZE_MAX_SIDE = 4096;
/** Every preset keyword any family understands; each family allows a subset. */
export const SIZE_PRESET_KEYWORDS = ['1K', '1.5K', '2K', '3K', '4K'];

/**
 * 5.0 pro / flash 的显式像素区间，来自《Doubao-Seedream 5.0 使用手册》3.1 节：
 * `1280x720`(921600) ～ `2048x2048×1.1025`(4624220)。上限不是 2048×2048，
 * 卡在 4194304 会把一批上游本来接受的尺寸判成非法。
 */
const PIXELS_5_0_PRO = Object.freeze({ min: 921600, max: 4624220 });


/**
 * Per-family limits, transcribed from the 模型能力 section of the official API doc
 * (图片生成 API · 82379/1541523). They differ per family, and getting them wrong
 * means the upstream API rejects the request instead of us explaining why:
 *
 *   Seedream 5.0 pro      2–10 reference images, single image only (no group),
 *                         no web search, supports layer decomposition.
 *   Seedream 5.0 lite     2–14 reference images, group supported, web search,
 *                         no layer decomposition.
 *   Seedream 4.5 / 4.0    2–14 reference images, group supported, no web search.
 *
 * The shared group rule is "reference images + generated images ≤ 15".
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  maxReferences: MAX_REFERENCE_IMAGES,
  groupCeiling: MAX_GROUP_IMAGES,
  supportsGroup: true,
  supportsWebSearch: false,
  supportsLayerDecomposition: false,
  // 手册明确「fast 仅 pro」；未收录的模型按宽松处理，由上游裁判。
  supportsFastMode: true,
  // 透明背景需要输入本身带 alpha 通道，只有 5.0 pro / flash 支持。
  supportsTransparentBackground: true,
  // 交互编辑（prompt 里的 <bbox> / <point> 定位标签）。
  supportsInteractiveEdit: true,
  // Permissive fallback for an unrecognised id (a custom gateway, or a model
  // released after this code was written): accept every preset we know of and
  // leave the ceiling to the shared side bounds. Blocking a size we merely have
  // not heard of would be worse than letting Ark be the final authority.
  sizePresets: [...SIZE_PRESET_KEYWORDS],
  sizePixels: null,
  label: '',
  note: '',
});

/* One frozen capability object per family. FAMILY_MATCHERS references these
 * constants directly — never by index — so inserting or reordering catalogue
 * entries can't silently re-point a family at another family's limits. */
const CAP_4_0 = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  sizePresets: ['1K', '2K', '4K'],
  note: '支持文生图、组图与图生图（参考图最多 14 张）；尺寸支持 1K / 2K / 4K；不支持联网搜索。',
});

const CAP_4_5 = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  sizePresets: ['2K', '4K'],
  // 手册 1 节：fast 模式「仅 pro 支持；flash/lite/4.5 不支持」。
  supportsFastMode: false,
  note: '支持文生图、组图与图生图（参考图最多 14 张）；尺寸支持 2K / 4K；不支持联网搜索与 fast 模式。',
});

const CAP_5_0_LITE = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  sizePresets: ['2K', '3K', '4K'],
  supportsWebSearch: true,
  // 手册 1 节的对照表：lite 不支持 fast、透明背景、图层拆分、交互编辑。
  supportsFastMode: false,
  supportsTransparentBackground: false,
  supportsInteractiveEdit: false,
  note: '支持文生图、组图、图生图与联网搜索（参考图最多 14 张）；尺寸支持 2K / 3K / 4K；不支持 fast、透明背景与交互编辑。',
});

/** 5.0 pro / flash 的共用部分：单图、10 张参考图、1K–2K、交互编辑。
 *  图层拆分只写进能力矩阵（`supportsLayerDecomposition`），不进 UI 文案——
 *  控制台没有图层查看器，文案里许诺一个按钮会落空（见 README「未实现的能力」）。 */
const CAP_5_0_SINGLE = Object.freeze({
  ...DEFAULT_CAPABILITIES,
  maxReferences: 10,
  groupCeiling: 1,
  supportsGroup: false,
  supportsWebSearch: false,
  supportsLayerDecomposition: true,
  supportsTransparentBackground: true,
  supportsInteractiveEdit: true,
  // 手册 3.1：pro / flash 默认 2K，可选 1K / 1.5K / 2K；1.5K 与 1K 同价但效果更好。
  sizePresets: ['1K', '1.5K', '2K'],
  sizePixels: PIXELS_5_0_PRO,
});

const CAP_5_0_PRO = Object.freeze({
  ...CAP_5_0_SINGLE,
  // 手册 1 节：fast 仅 pro 支持。
  supportsFastMode: true,
  note: '只支持生成单图：参考图最多 10 张，尺寸支持 1K / 1.5K / 2K（不支持 4K），不支持组图与联网搜索；支持 fast、透明背景与交互编辑。',
});

const CAP_5_0_FLASH = Object.freeze({
  ...CAP_5_0_SINGLE,
  // flash 更快更便宜，但没有极速提示词优化（它本身就是快的那一档）。
  supportsFastMode: false,
  note: '只支持生成单图：参考图最多 10 张，尺寸支持 1K / 1.5K / 2K，不支持组图、联网搜索与 fast；支持透明背景与交互编辑。',
});

const MODEL_CATALOG = [
  { id: 'doubao-seedream-4-0-20260415', label: 'Seedream 4.0', capabilities: CAP_4_0 },
  { id: 'doubao-seedream-4-5', label: 'Seedream 4.5', capabilities: CAP_4_5 },
  { id: 'doubao-seedream-5-0-lite', label: 'Seedream 5.0 lite', capabilities: CAP_5_0_LITE },
  { id: 'doubao-seedream-5-0-flash-260915', label: 'Seedream 5.0 flash', capabilities: CAP_5_0_FLASH },
  { id: 'doubao-seedream-5-0-pro', label: 'Seedream 5.0 pro', capabilities: CAP_5_0_PRO },
  { id: 'doubao-seedream-5-0-pro-260628', label: 'Seedream 5.0 pro（260628）', capabilities: CAP_5_0_PRO },
];

export const ARK_MODEL_SUGGESTIONS = MODEL_CATALOG.map((model) => model.id);

/** Family limits keyed by substring, so dated ids like `...-pro-260628` match. */
const FAMILY_MATCHERS = [
  { pattern: /seedream-?5-?0-?pro/, capabilities: CAP_5_0_PRO },
  { pattern: /seedream-?5-?0-?flash/, capabilities: CAP_5_0_FLASH },
  { pattern: /seedream-?5-?0-?lite/, capabilities: CAP_5_0_LITE },
  { pattern: /seedream-?4-?5/, capabilities: CAP_4_5 },
  { pattern: /seedream-?4-?0/, capabilities: CAP_4_0 },
];

function modelKey(model) {
  return String(model || '').toLowerCase().replace(/[._\s]/g, '-');
}

/**
 * Capabilities for a model id. An unrecognised id (a custom gateway, or a model
 * released after this code was written) gets the permissive general limits rather
 * than being blocked — the upstream API is still the final authority, and the
 * error mapping below turns its rejection into a readable message.
 */
export function modelCapabilities(model) {
  const key = modelKey(model);
  for (const entry of FAMILY_MATCHERS) {
    if (entry.pattern.test(key)) return { ...entry.capabilities };
  }
  return { ...DEFAULT_CAPABILITIES };
}

/** The catalogue the admin UI uses to prefill limits when a suggestion is picked. */
export function modelCatalog() {
  return MODEL_CATALOG.map(({ id, label, capabilities }) => ({
    id,
    label,
    maxReferences: capabilities.maxReferences,
    groupCeiling: capabilities.groupCeiling,
    supportsGroup: capabilities.supportsGroup,
    supportsWebSearch: capabilities.supportsWebSearch,
    // 控制台按这几个开关决定「能点 / 置灰 / 隐藏」，规则仍然只有本文件一份。
    supportsFastMode: capabilities.supportsFastMode,
    supportsTransparentBackground: capabilities.supportsTransparentBackground,
    supportsInteractiveEdit: capabilities.supportsInteractiveEdit,
    supportsLayerDecomposition: capabilities.supportsLayerDecomposition,
    // Carried per model so the console can swap the size datalist when the
    // operator changes the model, instead of offering one global list that is
    // wrong for most families (4K is valid on 4.0 and invalid on 5.0 pro).
    sizePresets: [...(capabilities.sizePresets || DEFAULT_CAPABILITIES.sizePresets)],
    sizeSuggestions: sizeSuggestionsFor(id),
    note: capabilities.note,
  }));
}

const ALLOWED_REFERENCE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
]);

const SIZE_KEYWORD = /^(1k|1\.5k|2k|3k|4k)$/i;
const SIZE_EXPLICIT = /^(\d{3,5})x(\d{3,5})$/i;

export class GenerationError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'GenerationError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Input normalisation
 * ------------------------------------------------------------------ */

function fail(message) {
  throw new GenerationError(message, 400);
}

/** Accepts the canonical mode name plus the Chinese labels and common shorthands. */
export function normalizeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return 'text2image';
  if (MODES.includes(raw)) return raw;
  const aliases = {
    t2i: 'text2image',
    文生图: 'text2image',
    text2img: 'text2image',
    'text-to-image': 'text2image',
    t2g: 'text2group',
    文生组图: 'text2group',
    组图: 'text2group',
    text2images: 'text2group',
    i2i: 'image2image',
    图生图: 'image2image',
    img2img: 'image2image',
    'image-to-image': 'image2image',
    参考图: 'image2image',
  };
  if (aliases[raw]) return aliases[raw];
  fail('生成模式不正确，只能是文生图 / 文生组图 / 图生图');
}

/**
 * Validate `size` against the limits of the model that will actually receive it.
 *
 * The model argument is what makes this correct: `4K` is a legal preset for
 * Seedream 4.0 / 4.5 / 5.0 lite and an instant 400 from Seedream 5.0 pro, so a
 * single global check cannot be right for both. Rejecting locally also turns an
 * opaque upstream `InvalidParameter` into a message naming the alternatives.
 */
export function normalizeSize(value, capabilities = DEFAULT_CAPABILITIES) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (SIZE_KEYWORD.test(raw)) {
    const preset = raw.toUpperCase();
    const allowed = capabilities.sizePresets || DEFAULT_CAPABILITIES.sizePresets;
    if (!allowed.includes(preset)) {
      fail(
        `当前模型不支持 ${preset} 尺寸，可选档位：${allowed.join(' / ')}；` +
          '也可以直接填「宽x高」，例如 1024x1024',
      );
    }
    return preset;
  }

  const match = raw.match(SIZE_EXPLICIT);
  if (!match) {
    const allowed = capabilities.sizePresets || DEFAULT_CAPABILITIES.sizePresets;
    fail(`尺寸格式不正确，请填 ${allowed.join(' / ')} 或「宽x高」（例如 2048x2048）`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < SIZE_MIN_SIDE || height < SIZE_MIN_SIDE) {
    fail(`尺寸的每一边都不能小于 ${SIZE_MIN_SIDE} 像素`);
  }
  if (width > SIZE_MAX_SIDE || height > SIZE_MAX_SIDE) {
    fail(`尺寸的每一边都不能大于 ${SIZE_MAX_SIDE} 像素`);
  }

  const ratio = width / height;
  if (ratio < SIZE_ASPECT_MIN || ratio > SIZE_ASPECT_MAX) {
    fail(`宽高比需要在 1:16 到 16:1 之间（当前 ${width}x${height}）`);
  }

  const pixels = capabilities.sizePixels;
  if (pixels) {
    const total = width * height;
    if (total < pixels.min || total > pixels.max) {
      fail(
        `当前模型的总像素需要在 ${pixels.min} 到 ${pixels.max} 之间` +
          `（当前 ${width}x${height} 共 ${total} 像素），例如 1024x1024 或 2048x2048`,
      );
    }
  }

  return `${width}x${height}`;
}

/** Explicit WxH values worth advertising, before per-model filtering. */
const EXPLICIT_SIZE_PRESETS = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  // 手册 3.1 的 1.5K 行：与 1K 同价，但这两档是最常用的横/竖版输出。
  '1792x1344',
  '2048x1152',
  '1152x2048',
  '2048x2048',
  '2304x1728',
  '1728x2304',
];

/**
 * The size datalist for one model: its preset ladder plus every explicit value it
 * accepts. Derived by running each candidate through `normalizeSize`, so the
 * suggestions can never drift away from what validation actually permits.
 */
export function sizeSuggestionsFor(model) {
  const capabilities = modelCapabilities(model);
  const presets = capabilities.sizePresets || DEFAULT_CAPABILITIES.sizePresets;
  const explicit = EXPLICIT_SIZE_PRESETS.filter((candidate) => {
    try {
      normalizeSize(candidate, capabilities);
      return true;
    } catch {
      return false;
    }
  });
  return [...presets, ...explicit];
}

export function normalizeOptimizeMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'standard' || raw === 'fast') return raw;
  fail('提示词优化模式只能是 standard 或 fast');
}

export function normalizeModel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) fail('模型 ID 不能为空');
  if (raw.length > MAX_MODEL_CHARS) fail(`模型 ID 不能超过 ${MAX_MODEL_CHARS} 个字符`);
  if (!/^[\w.:/-]+$/.test(raw)) fail('模型 ID 含有不被允许的字符');
  return raw;
}

export function normalizePrompt(value) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) fail('提示词不能为空');
  if (raw.length > MAX_PROMPT_CHARS) fail(`提示词不能超过 ${MAX_PROMPT_CHARS} 个字符`);
  return raw;
}

/**
 * Validate one reference image: either an http(s) URL, or a `data:` URI carrying
 * a base64 bitmap. Anything else (file:, blob:, javascript:, SVG payloads) is
 * refused before it can reach the upstream API.
 */
export function normalizeReferenceImage(value, index = 0) {
  const label = `第 ${index + 1} 张参考图片`;
  if (typeof value !== 'string') fail(`${label}必须是文本`);
  const raw = value.trim();
  if (!raw) fail(`${label}不能为空`);

  if (raw.startsWith('data:')) {
    const comma = raw.indexOf(',');
    if (comma === -1) fail(`${label}的 data URI 格式不完整`);
    const header = raw.slice(5, comma);
    const parts = header.split(';');
    const mime = (parts.shift() || '').toLowerCase();
    const isBase64 = parts.some((part) => part.trim().toLowerCase() === 'base64');
    if (!isBase64) fail(`${label}必须使用 base64 编码`);
    if (!ALLOWED_REFERENCE_MIME.has(mime)) {
      fail(`${label}的图片格式不受支持（仅支持 PNG / JPEG / WebP / GIF / BMP / TIFF）`);
    }
    const payload = raw.slice(comma + 1).replace(/\s+/g, '');
    if (!payload) fail(`${label}的内容为空`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) fail(`${label}的 base64 内容不合法`);
    // 4 base64 chars encode 3 bytes; the estimate is exact once padding is removed.
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((payload.length * 3) / 4) - padding;
    if (bytes <= 0) fail(`${label}的内容为空`);
    if (bytes > MAX_REFERENCE_BYTES) {
      fail(`${label}超过 ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)}MB 上限`);
    }
    return raw;
  }

  if (raw.length > MAX_REFERENCE_URL_CHARS) {
    fail(`${label}的地址过长（上限 ${MAX_REFERENCE_URL_CHARS} 字符）`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label}既不是合法的 URL，也不是 base64 图片数据`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${label}必须使用 http 或 https 协议`);
  }
  if (url.username || url.password) fail(`${label}不允许携带用户名或密码`);
  return raw;
}

export function normalizeReferenceImages(value, capabilities = DEFAULT_CAPABILITIES) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > capabilities.maxReferences) {
    fail(`参考图片最多 ${capabilities.maxReferences} 张`);
  }
  return list.map((item, index) => normalizeReferenceImage(item, index));
}

/**
 * Reference images plus generated images may not exceed the family ceiling, which
 * collapses every documented limit into one rule: 0 refs → ceiling, 1 ref →
 * ceiling − 1, n refs → ceiling − n. Seedream 5.0 pro has a ceiling of 1 because
 * it cannot produce groups at all.
 */
export function maxGroupImagesFor(referenceCount, capabilities = DEFAULT_CAPABILITIES) {
  return capabilities.groupCeiling - Math.max(0, referenceCount);
}

export function normalizeMaxImages(value, referenceCount, capabilities = DEFAULT_CAPABILITIES) {
  const ceiling = maxGroupImagesFor(referenceCount, capabilities);
  if (value === undefined || value === null || value === '') return Math.min(4, ceiling);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.floor(number) !== number) fail('生成张数必须是整数');
  if (number < 1) fail('生成张数至少为 1');
  if (number > ceiling) {
    fail(referenceCount ? `参考图 ${referenceCount} 张时最多只能再生成 ${ceiling} 张` : `生成张数最多为 ${ceiling}`);
  }
  return number;
}

export function normalizeOutputFormat(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (OUTPUT_FORMATS.includes(raw)) return raw;
  fail(`输出格式只能是 ${OUTPUT_FORMATS.join(' / ')}`);
}

export function normalizeBackground(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (BACKGROUNDS.includes(raw)) return raw;
  fail(`透明通道只能是 ${BACKGROUNDS.join(' / ')}`);
}

/* ------------------------------------------------------------------ *
 * Payload construction
 * ------------------------------------------------------------------ */

/**
 * Turn validated admin input into the exact JSON body Ark expects.
 * Pure and synchronous, so the shape can be asserted directly in tests.
 *
 * @param {object} input
 * @param {'text2image'|'text2group'|'image2image'} input.mode
 * @param {string} input.prompt
 * @param {string} [input.model]
 * @param {string} [input.size]
 * @param {boolean} [input.watermark]
 * @param {string} [input.optimizeMode]
 * @param {string} [input.outputFormat]  jpeg | png | webp; omitted = API default
 * @param {string} [input.background]    opaque | transparent; omitted = API default
 * @param {boolean} [input.webSearch]    Seedream 5.0 lite only
 * @param {boolean} [input.group]        group output while using reference images
 * @param {number} [input.maxImages]
 * @param {string[]} [input.referenceImages]
 */
export function buildGenerationPayload(input = {}) {
  const mode = normalizeMode(input.mode);
  const prompt = normalizePrompt(input.prompt);
  const model = normalizeModel(input.model || ARK_DEFAULT_MODEL);
  // Resolved before `size` because the size rules are per family.
  const capabilities = modelCapabilities(model);
  const size = normalizeSize(input.size, capabilities);
  const optimizeMode = normalizeOptimizeMode(input.optimizeMode);
  const outputFormat = normalizeOutputFormat(input.outputFormat);
  const background = normalizeBackground(input.background);

  const references =
    mode === 'image2image' ? normalizeReferenceImages(input.referenceImages, capabilities) : [];
  if (mode === 'image2image' && references.length === 0) {
    fail('图生图至少需要一张参考图片');
  }

  const group = mode === 'text2group' ? true : Boolean(input.group);
  if (group && !capabilities.supportsGroup) {
    fail(`${model} 不支持组图生成，请改用 Seedream 5.0 lite / 4.5 / 4.0，或关闭组图`);
  }

  const webSearch = Boolean(input.webSearch);
  if (webSearch && !capabilities.supportsWebSearch) {
    fail(`${model} 不支持联网搜索，请改用 Seedream 5.0 lite`);
  }

  if (optimizeMode === 'fast' && !capabilities.supportsFastMode) {
    fail(`${model} 不支持 fast 极速提示词优化，请改用 standard，或换 Seedream 5.0 pro`);
  }

  // 手册 4.5：透明背景只支持「图生图 + 单张本身带透明通道的图」，输出默认 png。
  // 上游对不符合条件的请求只会报一句 InvalidParameter，所以在本地说清楚。
  if (background === 'transparent') {
    if (!capabilities.supportsTransparentBackground) {
      fail(`${model} 不支持透明背景，请改用 Seedream 5.0 pro / flash`);
    }
    if (mode !== 'image2image' || references.length !== 1) {
      fail('透明背景只支持图生图，且必须正好 1 张带透明通道的参考图（png / webp）');
    }
  }

  // JPEG carries no alpha channel, so a transparent request in JPEG is a
  // contradiction the API would reject — say so here instead.
  if (background === 'transparent' && outputFormat === 'jpeg') {
    fail('透明背景需要 png 或 webp 输出格式，jpeg 不支持透明通道');
  }

  const payload = {
    model,
    prompt,
    response_format: 'url',
    watermark: input.watermark === undefined ? false : Boolean(input.watermark),
  };
  if (size) payload.size = size;
  if (optimizeMode) payload.optimize_prompt_options = { mode: optimizeMode };
  // Both of these default to jpeg / opaque upstream, so they are only sent when
  // the operator explicitly asks for something else.
  if (outputFormat) payload.output_format = outputFormat;
  if (background) payload.background = background;
  if (webSearch) payload.tools = [{ type: 'web_search' }];
  if (references.length === 1) payload.image = references[0];
  else if (references.length > 1) payload.image = references;

  // `disabled` is the server-side default, so single-image requests omit the
  // field entirely. That also keeps Seedream 5.0 pro happy, since it rejects the
  // parameter outright.
  if (group) {
    payload.sequential_image_generation = 'auto';
    payload.sequential_image_generation_options = {
      max_images: normalizeMaxImages(input.maxImages, references.length, capabilities),
    };
  }

  return {
    payload,
    meta: {
      mode,
      model,
      size,
      optimizeMode,
      outputFormat,
      background,
      webSearch,
      group,
      watermark: payload.watermark,
      referenceCount: references.length,
      referenceKind: references.length
        ? references.some((item) => item.startsWith('data:'))
          ? 'base64'
          : 'url'
        : 'none',
      maxImages: group ? payload.sequential_image_generation_options.max_images : 1,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Endpoint helpers
 * ------------------------------------------------------------------ */

/** Accepts a base URL or a full endpoint; returns the URL to POST to. */
export function resolveGenerationEndpoint(baseUrl) {
  const raw = String(baseUrl ?? '').trim() || ARK_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new GenerationError('接口地址不是合法的 URL', 400);
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new GenerationError('接口地址必须使用 https（本机地址除外），以免 API Key 以明文传输', 400);
  }
  if (url.username || url.password) {
    throw new GenerationError('接口地址不允许携带用户名或密码', 400);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/images/generations')) return url.toString();
  return `${url.origin}${path}/images/generations`;
}

/**
 * Store the base form of an endpoint: a pasted full `/images/generations` URL is
 * reduced back to its base so later edits stay predictable.
 */
export function normalizeBaseUrl(baseUrl) {
  const endpoint = resolveGenerationEndpoint(baseUrl);
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/images\/generations\/?$/, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Never reveal more than a recognisable prefix and suffix of a key. */
export function apiKeyHint(key) {
  const raw = String(key ?? '');
  if (!raw) return '';
  if (raw.length <= 10) return `${raw.slice(0, 2)}…`;
  return `${raw.slice(0, 5)}…${raw.slice(-4)}`;
}

/**
 * TOS signed URLs carry their own expiry; surface it so the UI can warn.
 *
 * Re-exported from the shared `signed-url.mjs` — this file used to carry its own
 * copy that misread `X-Tos-Expires` as an absolute timestamp.
 */
export { extractUrlExpiry };

/**
 * Read the non-streaming response body into a flat list of results.
 * `data[]` items carry either a signed `url` or inline `b64_json`.
 */
export function parseGenerationResponse(body) {
  if (!body || typeof body !== 'object') {
    throw new GenerationError('生图接口返回了无法解析的内容');
  }
  if (body.error) {
    const message = typeof body.error === 'string' ? body.error : body.error.message || body.error.code;
    throw new GenerationError(`生图接口返回错误：${message || '未知错误'}`);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  const images = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url : '';
    const b64 = typeof item.b64_json === 'string' ? item.b64_json : '';
    if (!url && !b64) continue;
    images.push({
      url,
      b64,
      size: typeof item.size === 'string' ? item.size : '',
      expiresAt: url ? extractUrlExpiry(url) : null,
    });
  }
  if (!images.length) {
    throw new GenerationError('生图接口没有返回任何图片');
  }
  return {
    model: typeof body.model === 'string' ? body.model : '',
    created: Number.isFinite(Number(body.created)) ? Number(body.created) : null,
    images,
    usage: body.usage && typeof body.usage === 'object' ? body.usage : null,
  };
}

/** Best-effort extraction of the offending field name from an Ark error body. */
function upstreamErrorParam(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    const error = parsed && parsed.error;
    if (error && typeof error === 'object' && typeof error.param === 'string') return error.param;
  } catch {
    /* not JSON, or not the shape we expect — fall through to the generic message */
  }
  return '';
}

/**
 * Map an upstream HTTP status onto something an operator can act on.
 *
 * `context` optionally carries the model that was called and its capabilities, so
 * a rejected `size` can name the presets that model actually accepts instead of
 * relaying Ark's raw `InvalidParameter` payload.
 */
export function describeUpstreamFailure(status, text, context = {}) {
  const detail = String(text || '').replace(/\s+/g, ' ').slice(0, 300);
  if (status === 401 || status === 403) {
    return `API Key 无效或没有该模型的权限（HTTP ${status}）${detail ? `：${detail}` : ''}`;
  }
  if (status === 404) {
    return `模型 ID 不存在，或该模型尚未在方舟控制台开通（HTTP 404）${detail ? `：${detail}` : ''}`;
  }
  if (status === 429) {
    return `调用过于频繁或额度不足，请稍后重试（HTTP 429）${detail ? `：${detail}` : ''}`;
  }
  if (status === 400) {
    if (upstreamErrorParam(text) === 'size') {
      const presets = context.capabilities && context.capabilities.sizePresets;
      const label = context.model ? `模型 ${context.model} ` : '当前模型';
      const hint = Array.isArray(presets) && presets.length
        ? `该${label}支持的尺寸档位是 ${presets.join(' / ')}，也可以直接填「宽x高」（例如 1024x1024）`
        : '请改用「宽x高」形式（例如 1024x1024）';
      return `生图接口不接受这个尺寸（HTTP 400）：${hint}。原始信息：${detail}`;
    }
    return `生图接口拒绝了这次请求（HTTP 400）${detail ? `：${detail}` : ''}`;
  }
  if (status >= 500) {
    return `生图服务暂时不可用（HTTP ${status}），请稍后重试${detail ? `：${detail}` : ''}`;
  }
  return `生图接口返回状态码 ${status}${detail ? `：${detail}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * The call itself
 * ------------------------------------------------------------------ */

/**
 * @param {object} input  see buildGenerationPayload
 * @param {{ apiKey: string, baseUrl?: string, fetchImpl?: Function, timeoutMs?: number }} config
 */
export async function generateImages(input, config = {}) {
  const apiKey = String(config.apiKey ?? '').trim();
  if (!apiKey) {
    throw new GenerationError('尚未配置生图接口的 API Key', 503);
  }
  const { payload, meta } = buildGenerationPayload(input);
  const endpoint = resolveGenerationEndpoint(config.baseUrl);
  const doFetch = config.fetchImpl || fetch;
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : GENERATION_TIMEOUT_MS;

  let response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new GenerationError(`生图请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`, 504);
    }
    throw new GenerationError(`无法连接生图接口：${error.message}`, 502);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new GenerationError(
      describeUpstreamFailure(response.status, text, {
        model: meta.model,
        capabilities: modelCapabilities(meta.model),
      }),
      502,
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GenerationError('生图接口返回的不是合法 JSON');
  }

  const parsed = parseGenerationResponse(body);
  return {
    ...parsed,
    request: meta,
    generatedAt: new Date().toISOString(),
    endpoint,
  };
}
