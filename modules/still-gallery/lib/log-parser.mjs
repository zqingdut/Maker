/**
 * Parser for `whiteboard_agent.log` — the whiteboard agent's runtime log.
 *
 * A log file is a stream of lines shaped like:
 *   `2026-09-17 11:21:46,963 INFO api.whiteboard_app:124(generate_image): <message>`
 *
 * One image generation is bracketed by `GENERATE START` / `GENERATE END`
 * banners. Multi-line messages (the user input, the image API payload) continue
 * across newlines until the next timestamped line, so the parser works on the
 * raw text rather than line by line.
 *
 * Everything here is pure and synchronous so it can be unit tested without a
 * server or a network.
 */
import { extractUrlExpiry } from './signed-url.mjs';

const SESSION_SPLIT = /^.*?GENERATE START.*$/gm;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3})/;

/** `session=123, input=<multi-line>, image_url=X, base64=Y` (input is truncated by the logger) */
const SESSION_HEADER =
  /session=(\d+),\s*input=([\s\S]*?),\s*image_url=([\s\S]*?),\s*base64=([^\n]*)/;

/**
 * The full, untruncated user input lives on the agent's own `user_input:` line,
 * which runs until the next timestamped log line.
 */
const USER_INPUT_BLOCK =
  /\(chat\):\s*user_input:\s*([\s\S]*?)(?=\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} )/;

const IMAGE_API_MARKER = '[生图API入参]';
const GENERATED_URL = /生成图片URL:\s*(https?:\/\/\S+)/;
const DONE_LINE = /\[generate-image\]\s*done,\s*url=(\S+?),\s*elapsed=([\d.]+)s/;

const DURATION = {
  // The agent logs either `[耗时统计]` or a tagged variant such as
  // `[耗时统计-FastPath]`, so keep the tag open.
  total: /\[耗时统计[^\]]*\]\s*总耗时:\s*([\d.]+)秒/,
  llm: /\[耗时统计[^\]]*\]\s*LLM推理:\s*([\d.]+)秒/,
  tools: /\[耗时统计[^\]]*\]\s*工具执行:\s*([\d.]+)秒/,
  imageApi: /\[耗时统计[^\]]*\]\s*生图API耗时:\s*([\d.]+)秒/,
};

const TOKENS = /上下文长度:\s*prompt_tokens=(\d+),\s*completion_tokens=(\d+),\s*total_tokens=(\d+)/;
const LLM_MODEL = /'model_name':\s*'([^']+)'/;

export const MAX_LOG_BYTES = 16 * 1024 * 1024;

function parseLocalTimestamp(text) {
  const match = TIMESTAMP.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, ms] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Decode the escapes the logger leaves inside captured JSON string values. */
export function unescapeJsonString(value) {
  return String(value).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape) => {
    if (escape[0] === 'u') return String.fromCharCode(parseInt(escape.slice(1), 16));
    const table = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    return table[escape] !== undefined ? table[escape] : escape;
  });
}

/**
 * The image API prompt arrives either as plain text or wrapped in a JSON
 * envelope. The logger truncates long values, so a truncated envelope is not
 * valid JSON and needs a lenient fallback.
 */
export function unwrapPromptEnvelope(raw) {
  const text = String(raw).trim();
  if (!text.startsWith('{')) return text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const first = Object.values(parsed).find((value) => typeof value === 'string' && value.trim());
      if (first) return first.trim();
    }
  } catch {
    /* truncated payload — fall through */
  }
  const match = /^\{\s*"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text);
  if (match) return unescapeJsonString(match[1]).trim();
  return text;
}

/** The image API `prompt` is sometimes a JSON envelope `{"content": "..."}`. */
export function extractPromptContent(payload) {
  if (!payload || typeof payload.prompt !== 'string') {
    return { prompt: '', truncated: false };
  }
  const text = unwrapPromptEnvelope(payload.prompt);
  const truncated = /(?:\.\.\.|…)\s*$/.test(text);
  return { prompt: text.replace(/(?:\.\.\.|…)\s*$/, '').trim(), truncated };
}

/** Pull the real requirement out of the templated agent input. */
export function extractUserRequest(input) {
  const text = String(input || '').replace(/\r\n/g, '\n');
  const marker = text.match(/用户需求[：:]\s*([^\n]+)/);
  if (marker && marker[1].trim()) return marker[1].trim().replace(/[。；;]\s*$/, '');

  // Fall back to the first meaningful line, dropping the fixed boilerplate.
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^请根据用户需求生成一张插画/.test(line) && !/^【/.test(line));
  if (!first) return '';
  return first
    .replace(/^你是一名专业插画师[。，,]?/, '')
    .replace(/^基于参考图像图生图编辑[，,]?\s*/, '')
    .replace(/^最高优先级执行[：:]\s*/, '')
    .replace(/[。；;]\s*$/, '')
    .trim();
}

/** The image API `prompt` is sometimes a JSON envelope `{"content": "..."}`. */

/**
 * Signed object-storage URLs carry their own expiry; surface it so imports can
 * warn. Shared with `image-gen.mjs` — the two modules previously held separate
 * copies that disagreed about whether `X-Tos-Expires` was a lifetime or a stamp.
 */
export { extractUrlExpiry } from './signed-url.mjs';

/**
 * Grab a balanced `{...}` JSON value starting at or after `from`, honouring
 * string literals and escapes. The image API payload nests objects and embeds
 * base64 blobs, so a lazy regex would stop at the first inner brace.
 */
export function extractBalancedJson(text, from = 0) {
  const start = text.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseApiPayload(block) {
  const marker = block.indexOf(IMAGE_API_MARKER);
  if (marker === -1) return null;
  const json = extractBalancedJson(block, marker);
  if (!json) return null;
  try {
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function firstMatch(regex, text) {
  const match = regex.exec(text);
  return match ? match[1] : null;
}

/** Parse a single GENERATE START … END block into a normalised session record. */
export function parseSessionBlock(block, index = 0) {
  const warnings = [];
  const startedAt = parseLocalTimestamp(block);

  const header = SESSION_HEADER.exec(block);
  const sessionId = header ? header[1] : null;
  const headerInput = header ? header[2].trim() : '';
  const rawImageUrl = header ? header[3].trim() : '';
  const rawBase64 = header ? header[4].trim() : '';
  if (!header) warnings.push('未能解析会话头部（session / input）');

  // The `[generate-image]` banner truncates its copy of the input; prefer the
  // agent's full `user_input:` line when it is available.
  const fullInputMatch = USER_INPUT_BLOCK.exec(block);
  const fullInput = fullInputMatch ? fullInputMatch[1].trim() : '';
  const userInput = fullInput.length > headerInput.length ? fullInput : headerInput;

  const hasReferenceImage = /^(?!none$)/i.test(rawImageUrl) || /^yes/i.test(rawBase64);
  const referenceChars = (() => {
    const match = /\((\d+)\s*字符\)/.exec(rawBase64);
    return match ? Number(match[1]) : 0;
  })();

  const payload = parseApiPayload(block);
  if (!payload) warnings.push('未找到可解析的生图 API 入参');

  const { prompt, truncated } = extractPromptContent(payload);
  if (truncated) warnings.push('日志中的提示词被截断');

  const imageUrl = firstMatch(GENERATED_URL, block) || '';
  const doneMatch = DONE_LINE.exec(block);
  const doneUrl = doneMatch ? doneMatch[1] : null;

  const status = imageUrl ? 'ok' : 'no-image';
  if (status === 'no-image') warnings.push('该会话未产出图片（仅返回文字回复）');

  const userRequest = extractUserRequest(userInput);
  const mode = hasReferenceImage ? 'image2image' : 'text2image';

  return {
    index: index + 1,
    sessionId,
    startedAt,
    status,
    mode,
    title: userRequest.slice(0, 120),
    userRequest,
    userInput,
    inputWasTruncated: Boolean(headerInput && fullInput.length > headerInput.length),
    prompt,
    promptTruncated: truncated,
    negativePrompt: '',
    imageModel: payload && typeof payload.model === 'string' ? payload.model : '',
    llmModel: firstMatch(LLM_MODEL, block) || '',
    size: payload && typeof payload.size === 'string' ? payload.size : '',
    responseFormat: payload && typeof payload.response_format === 'string' ? payload.response_format : '',
    watermark: Boolean(payload && payload.extra_body && payload.extra_body.watermark),
    promptOptimizeMode:
      payload && payload.extra_body && payload.extra_body.optimize_prompt_options
        ? String(payload.extra_body.optimize_prompt_options.mode || '')
        : '',
    hasReferenceImage,
    referenceChars,
    imageUrl,
    imageUrlExpiresAt: extractUrlExpiry(imageUrl),
    doneElapsedSeconds: doneMatch ? toSeconds(doneMatch[2]) : null,
    doneUrlMatchesLog: Boolean(doneUrl && imageUrl && doneUrl === imageUrl),
    totalSeconds: toSeconds(firstMatch(DURATION.total, block)),
    llmSeconds: toSeconds(firstMatch(DURATION.llm, block)),
    toolSeconds: toSeconds(firstMatch(DURATION.tools, block)),
    imageApiSeconds: toSeconds(firstMatch(DURATION.imageApi, block)),
    tokens: (() => {
      const match = TOKENS.exec(block);
      if (!match) return null;
      return { prompt: Number(match[1]), completion: Number(match[2]), total: Number(match[3]) };
    })(),
    warnings,
  };
}

/**
 * @param {string} text raw log contents
 * @param {{ fileName?: string }} [options]
 */
export function parseWhiteboardLog(text, options = {}) {
  const fileName = options.fileName || '';
  if (typeof text !== 'string' || !text.trim()) {
    return {
      fileName,
      sessions: [],
      stats: { total: 0, withImage: 0, withoutImage: 0, text2image: 0, image2image: 0, parseFailures: 0 },
      warnings: ['日志内容为空'],
    };
  }

  const blocks = text.split(SESSION_SPLIT).slice(1);
  const sessions = blocks.map((block, index) => parseSessionBlock(block, index));

  const stats = {
    total: sessions.length,
    withImage: sessions.filter((session) => session.status === 'ok').length,
    withoutImage: sessions.filter((session) => session.status === 'no-image').length,
    text2image: sessions.filter((session) => session.mode === 'text2image').length,
    image2image: sessions.filter((session) => session.mode === 'image2image').length,
    parseFailures: sessions.filter((session) => !session.prompt).length,
  };

  const warnings = [];
  if (!sessions.length) warnings.push('未识别到任何 GENERATE START 标记，这可能不是白板智能体的日志');
  if (stats.parseFailures) warnings.push(`${stats.parseFailures} 个会话缺少可用的提示词`);

  return { fileName, sessions, stats, warnings };
}

/** Turn a parsed session into the gallery's entry shape (image URL excluded). */
export function sessionToEntry(session, { tags = [], source = '' } = {}) {
  const modeLabel = session.mode === 'image2image' ? '图生图' : '文生图';
  const merged = [...tags, modeLabel].filter(Boolean);
  const unique = [...new Set(merged.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12);

  return {
    title: (session.title || `未命名生成 #${session.index}`).slice(0, 120),
    prompt: session.prompt.slice(0, 8000),
    negativePrompt: session.negativePrompt || '',
    model: session.imageModel || '',
    tags: unique,
    aspectRatio: session.size || '',
    seed: '',
    steps: '',
    guidance: '',
    provenance: {
      source,
      sessionId: session.sessionId,
      mode: session.mode,
      llmModel: session.llmModel,
      size: session.size,
      watermark: session.watermark,
      promptOptimizeMode: session.promptOptimizeMode,
      generatedAt: session.startedAt,
      latencySeconds: session.totalSeconds,
      imageLatencySeconds: session.imageApiSeconds,
      llmLatencySeconds: session.llmSeconds,
      tokens: session.tokens,
      referenceImage: session.hasReferenceImage,
      rawRequest: session.userRequest,
      urlExpiresAt: session.imageUrlExpiresAt,
      promptTruncated: session.promptTruncated,
    },
  };
}
