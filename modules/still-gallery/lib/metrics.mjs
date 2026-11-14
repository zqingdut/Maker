/**
 * Generation timing metrics.
 *
 * Every call that actually reaches the image endpoint — the direct
 * `POST /api/generate` route and the queue worker alike — appends exactly one
 * *sample* here. A sample is per **request**, not per bitmap, and that
 * distinction matters:
 *
 *   Ark answers a group request (`sequential_image_generation: auto`) with N
 *   images under a single wall clock, and the response carries no per-image
 *   timing. So the only honest per-image number is `durationMs / imageCount`,
 *   which is apportioned rather than measured. Everything downstream labels it
 *   as an apportioned figure instead of pretending it was timed individually.
 *
 * Failed attempts are recorded too, with `ok: false` and `imageCount: 0`. A
 * model whose average is computed only from successes would look faster than it
 * is; the success rate is reported alongside the average for that reason.
 *
 * The module is pure: no filesystem, no clock, no network. `server.mjs` owns
 * persistence, and every function here can be unit-tested on plain objects.
 */

export const METRICS_VERSION = 1;

/** Ring-buffer ceiling for `data/metrics.json`. Oldest samples fall off first. */
export const MAX_SAMPLES = 2000;

export const SAMPLE_SOURCES = ['direct', 'queue'];

const MAX_MODEL_CHARS = 120;
const MAX_ERROR_CHARS = 300;

function clampText(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Coerce anything (a hand-edited file, an old revision, a caller's object) into
 * a well-formed sample, or return null when there is not enough to be useful.
 *
 * A sample without a model or a duration cannot contribute to an average, so it
 * is dropped rather than stored as a zero — a zero would silently drag the
 * average down.
 */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const model = clampText(raw.model, MAX_MODEL_CHARS);
  if (!model) return null;
  const durationMs = finiteOrNull(raw.durationMs);
  if (durationMs === null) return null;

  const imageCount = finiteOrNull(raw.imageCount);
  const ok = raw.ok === undefined ? true : Boolean(raw.ok);
  const source = SAMPLE_SOURCES.includes(raw.source) ? raw.source : 'direct';
  const mode = ['text2image', 'text2group', 'image2image'].includes(raw.mode) ? raw.mode : '';
  const at = clampText(raw.at, 40);

  return {
    id: clampText(raw.id, 64),
    at: at && !Number.isNaN(Date.parse(at)) ? at : new Date(0).toISOString(),
    model,
    mode,
    size: clampText(raw.size, 40),
    group: Boolean(raw.group),
    maxImages: finiteOrNull(raw.maxImages) ?? 0,
    referenceCount: finiteOrNull(raw.referenceCount) ?? 0,
    durationMs: Math.round(durationMs),
    ok,
    // A failed request produced nothing; storing a count for it would make the
    // "images per model" figure disagree with the number of bitmaps on screen.
    imageCount: ok ? Math.round(imageCount ?? 0) : 0,
    error: ok ? '' : clampText(raw.error, MAX_ERROR_CHARS),
    source,
  };
}

/** Build a sample from a completed (or failed) generation attempt. */
export function createSample(partial) {
  return normalizeSample({
    id: partial.id,
    at: partial.at || new Date().toISOString(),
    model: partial.model,
    mode: partial.mode,
    size: partial.size,
    group: partial.group,
    maxImages: partial.maxImages,
    referenceCount: partial.referenceCount,
    durationMs: partial.durationMs,
    ok: partial.ok,
    imageCount: partial.imageCount,
    error: partial.error,
    source: partial.source,
  });
}

/** Keep only the most recent `limit` samples, preserving order. */
export function trimSamples(samples, limit = MAX_SAMPLES) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  if (list.length <= limit) return list;
  return list.slice(list.length - limit);
}

/** Nearest-rank percentile over an ascending list. Returns null when empty. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Round to one decimal; keeps the JSON small and the table readable. */
function round(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function summarize(list) {
  const okRuns = list.filter((sample) => sample.ok);
  const durations = okRuns.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const images = okRuns.reduce((sum, sample) => sum + sample.imageCount, 0);
  const stamps = list.map((sample) => sample.at).sort();

  return {
    runs: list.length,
    ok: okRuns.length,
    failed: list.length - okRuns.length,
    images,
    successRate: list.length ? Math.round((okRuns.length / list.length) * 1000) / 1000 : null,
    avgMs: durations.length ? round(totalMs / durations.length) : null,
    medianMs: round(median(durations)),
    p95Ms: percentile(durations, 95),
    minMs: durations.length ? durations[0] : null,
    maxMs: durations.length ? durations[durations.length - 1] : null,
    // Apportioned, not measured — see the module comment.
    avgMsPerImage: images ? round(totalMs / images) : null,
    firstAt: stamps[0] || '',
    lastAt: stamps[stamps.length - 1] || '',
  };
}

/**
 * One aggregate row per model, slowest average first — the ordering an operator
 * actually wants when asking "which model is dragging".
 */
export function summarizeByModel(samples) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  const groups = new Map();
  for (const sample of list) {
    if (!groups.has(sample.model)) groups.set(sample.model, []);
    groups.get(sample.model).push(sample);
  }

  const rows = [];
  for (const [model, group] of groups) {
    rows.push({
      model,
      ...summarize(group),
      modes: [...new Set(group.map((sample) => sample.mode).filter(Boolean))],
      lastError: [...group].reverse().find((sample) => !sample.ok)?.error || '',
    });
  }

  rows.sort((a, b) => {
    if (a.avgMs === null && b.avgMs === null) return a.model.localeCompare(b.model);
    if (a.avgMs === null) return 1;
    if (b.avgMs === null) return -1;
    return b.avgMs - a.avgMs;
  });
  return rows;
}

/** The headline row: everything pooled, plus how many distinct models it covers. */
export function overallSummary(samples) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  return { ...summarize(list), models: new Set(list.map((sample) => sample.model)).size };
}

/**
 * Flatten request-level samples into one row per produced bitmap, so the
 * "每张图" table has a real line per image. `perImageMs` is the apportioned
 * figure; `measured: false` marks group requests, where the upstream reported
 * one clock for the whole batch.
 */
export function expandPerImage(samples, limit = 60) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  const rows = [];
  for (let index = list.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const sample = list[index];
    if (!sample.ok || sample.imageCount < 1) continue;
    const perImageMs = Math.round(sample.durationMs / sample.imageCount);
    for (let slot = 1; slot <= sample.imageCount && rows.length < limit; slot += 1) {
      rows.push({
        at: sample.at,
        model: sample.model,
        mode: sample.mode,
        size: sample.size,
        index: slot,
        total: sample.imageCount,
        requestMs: sample.durationMs,
        perImageMs,
        measured: sample.imageCount === 1,
        source: sample.source,
      });
    }
  }
  return rows;
}

/** Newest first, capped — the raw log behind the tables. */
export function recentSamples(samples, limit = 40) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  return list.slice(-limit).reverse();
}

/** Everything the metrics tab needs, from one call. */
export function buildReport(samples, { recentLimit = 40, imageLimit = 60 } = {}) {
  const list = (Array.isArray(samples) ? samples : []).map(normalizeSample).filter(Boolean);
  return {
    version: METRICS_VERSION,
    generatedAt: new Date().toISOString(),
    overall: overallSummary(list),
    models: summarizeByModel(list),
    images: expandPerImage(list, imageLimit),
    recent: recentSamples(list, recentLimit),
    capacity: MAX_SAMPLES,
  };
}
