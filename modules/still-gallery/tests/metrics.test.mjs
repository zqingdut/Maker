import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SAMPLES,
  buildReport,
  createSample,
  expandPerImage,
  normalizeSample,
  overallSummary,
  percentile,
  recentSamples,
  summarizeByModel,
  trimSamples,
} from '../lib/metrics.mjs';

const A = 'doubao-seedream-4-0-20260415';
const B = 'doubao-seedream-5-0-pro';

function sample(overrides = {}) {
  return {
    at: '2026-09-30T02:00:00.000Z',
    model: A,
    mode: 'text2image',
    size: '2K',
    durationMs: 1000,
    ok: true,
    imageCount: 1,
    source: 'direct',
    ...overrides,
  };
}

/* ================================================================== *
 * normalization
 * ================================================================== */

test('a sample without a model or a duration is dropped, not zeroed', () => {
  assert.equal(normalizeSample(null), null);
  assert.equal(normalizeSample('nope'), null);
  assert.equal(normalizeSample({ durationMs: 100 }), null, 'no model');
  assert.equal(normalizeSample({ model: A }), null, 'no duration');
  assert.equal(normalizeSample({ model: A, durationMs: 'abc' }), null, 'duration must be numeric');
  assert.equal(normalizeSample({ model: A, durationMs: -5 }), null, 'a negative duration is nonsense');
});

test('a failed sample reports zero images however many were claimed', () => {
  // A failure produced no bitmap. Keeping a count would make "images per model"
  // disagree with the number of pictures the gallery actually holds.
  const failed = normalizeSample(sample({ ok: false, imageCount: 4, error: 'HTTP 429' }));
  assert.equal(failed.imageCount, 0);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'HTTP 429');
});

test('an unrecognised source falls back to direct and an unknown mode is blanked', () => {
  const weird = normalizeSample(sample({ source: 'telepathy', mode: 'text2everything' }));
  assert.equal(weird.source, 'direct');
  assert.equal(weird.mode, '');
});

test('a broken timestamp is replaced rather than propagated', () => {
  const broken = normalizeSample(sample({ at: 'not-a-date' }));
  assert.equal(broken.at, new Date(0).toISOString());
});

test('createSample fills in the timestamp when the caller omits it', () => {
  const created = createSample({ model: A, durationMs: 500 });
  assert.ok(!Number.isNaN(Date.parse(created.at)));
  assert.equal(created.durationMs, 500);
});

test('trimSamples keeps the newest entries', () => {
  const list = Array.from({ length: 10 }, (_, index) =>
    sample({ durationMs: index + 1, at: `2026-09-30T02:00:0${index}.000Z` }),
  );
  const kept = trimSamples(list, 3);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((item) => item.durationMs),
    [8, 9, 10],
  );
});

test('the default capacity is the documented one', () => {
  assert.equal(MAX_SAMPLES, 2000);
  assert.equal(trimSamples(Array.from({ length: MAX_SAMPLES + 5 }, () => sample())).length, MAX_SAMPLES);
});

/* ================================================================== *
 * percentiles
 * ================================================================== */

test('percentile uses nearest rank and handles the degenerate cases', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  // 95th of 10 is rank 10 -> the last element, not an interpolation.
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95), 100);
});

/* ================================================================== *
 * aggregation
 * ================================================================== */

test('per-model averages use only successful runs, and the count includes failures', () => {
  const rows = summarizeByModel([
    sample({ durationMs: 1000 }),
    sample({ durationMs: 2000 }),
    sample({ durationMs: 3000 }),
    sample({ ok: false, durationMs: 9000, error: 'HTTP 429' }),
  ]);

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.runs, 4);
  assert.equal(row.ok, 3);
  assert.equal(row.failed, 1);
  // 9s failure must NOT be averaged in — but it must be visible in the counts.
  assert.equal(row.avgMs, 2000);
  assert.equal(row.medianMs, 2000);
  assert.equal(row.minMs, 1000);
  assert.equal(row.maxMs, 3000);
  assert.equal(row.successRate, 0.75);
  assert.equal(row.images, 3);
  assert.equal(row.lastError, 'HTTP 429');
});

test('the per-image average is apportioned across a group', () => {
  const rows = summarizeByModel([sample({ durationMs: 4000, imageCount: 4, mode: 'text2group' })]);
  assert.equal(rows[0].avgMs, 4000);
  assert.equal(rows[0].avgMsPerImage, 1000);
});

test('models are ordered slowest average first', () => {
  const rows = summarizeByModel([
    sample({ model: A, durationMs: 1000 }),
    sample({ model: B, durationMs: 5000 }),
    sample({ model: 'doubao-seedream-4-5', durationMs: 3000 }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.model),
    [B, 'doubao-seedream-4-5', A],
  );
});

test('a model with only failures has no average but still shows up', () => {
  const rows = summarizeByModel([sample({ model: B, ok: false, durationMs: 1200, error: '超时' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].avgMs, null);
  assert.equal(rows[0].medianMs, null);
  assert.equal(rows[0].p95Ms, null);
  assert.equal(rows[0].avgMsPerImage, null);
  assert.equal(rows[0].successRate, 0);
  assert.equal(rows[0].failed, 1);
});

test('a model with no successful run sorts last, whatever the others average', () => {
  const rows = summarizeByModel([
    sample({ model: B, ok: false, durationMs: 1 }),
    sample({ model: A, durationMs: 60_000 }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.model),
    [A, B],
  );
});

test('the overall summary pools every model and counts them', () => {
  const overall = overallSummary([
    sample({ model: A, durationMs: 1000 }),
    sample({ model: B, durationMs: 3000 }),
    sample({ model: B, ok: false, durationMs: 500 }),
  ]);
  assert.equal(overall.runs, 3);
  assert.equal(overall.ok, 2);
  assert.equal(overall.failed, 1);
  assert.equal(overall.models, 2);
  assert.equal(overall.avgMs, 2000);
  assert.equal(overall.images, 2);
});

test('an empty history produces nulls rather than zeros or NaN', () => {
  const overall = overallSummary([]);
  assert.equal(overall.runs, 0);
  assert.equal(overall.avgMs, null);
  assert.equal(overall.avgMsPerImage, null);
  assert.equal(overall.successRate, null);
  assert.equal(overall.models, 0);
  assert.deepEqual(summarizeByModel([]), []);
});

/* ================================================================== *
 * per-image expansion
 * ================================================================== */

test('each bitmap of a group gets a row, marked as apportioned', () => {
  const rows = expandPerImage([
    sample({ durationMs: 3000, imageCount: 3, mode: 'text2group' }),
    sample({ durationMs: 800, imageCount: 1 }),
  ]);

  // Newest first: the single image, then the three group slots.
  assert.equal(rows.length, 4);
  assert.equal(rows[0].perImageMs, 800);
  assert.equal(rows[0].measured, true);
  assert.equal(rows[0].index, 1);
  assert.equal(rows[0].total, 1);

  assert.equal(rows[1].perImageMs, 1000);
  assert.equal(rows[1].measured, false, 'a group batch shares one clock');
  assert.deepEqual(
    rows.slice(1).map((row) => row.index),
    [1, 2, 3],
  );
  assert.equal(rows[1].requestMs, 3000);
});

test('failed runs contribute no per-image rows', () => {
  assert.deepEqual(expandPerImage([sample({ ok: false, durationMs: 100, imageCount: 0 })]), []);
});

test('per-image expansion respects its row limit', () => {
  const rows = expandPerImage([sample({ durationMs: 6000, imageCount: 6, mode: 'text2group' })], 4);
  assert.equal(rows.length, 4);
});

test('recent samples come back newest first and capped', () => {
  const list = Array.from({ length: 5 }, (_, index) =>
    sample({ durationMs: index + 1, at: `2026-09-30T02:00:0${index}.000Z` }),
  );
  const recent = recentSamples(list, 2);
  assert.deepEqual(
    recent.map((item) => item.durationMs),
    [5, 4],
  );
});

test('the report bundles everything the metrics tab renders', () => {
  const report = buildReport([sample({ durationMs: 1500 }), sample({ model: B, durationMs: 2500 })]);
  assert.equal(report.version, 1);
  assert.equal(report.capacity, MAX_SAMPLES);
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)));
  assert.equal(report.overall.runs, 2);
  assert.equal(report.models.length, 2);
  assert.equal(report.images.length, 2);
  assert.equal(report.recent.length, 2);
});

test('the report tolerates garbage input instead of throwing', () => {
  const report = buildReport([null, 7, 'x', { model: A }]);
  assert.equal(report.overall.runs, 0);
  assert.deepEqual(report.models, []);
});
