import test from 'node:test';
import assert from 'node:assert/strict';
import { LOG_LEVELS, createEventLog, isLogLevel } from '../lib/event-log.mjs';

test('createEventLog keeps entries newest-first and honours the level floor', () => {
  const log = createEventLog({ limit: 10 });
  log.debug('http', 'GET /api/images → 200');
  log.info('generate', '开始生成');
  log.warn('relay', '本机地址连不上');
  log.error('generate', '上游 400');

  assert.deepEqual(
    log.list().map((entry) => entry.level),
    ['error', 'warn', 'info', 'debug'],
  );
  assert.deepEqual(
    log.list({ level: 'warn' }).map((entry) => entry.message),
    ['上游 400', '本机地址连不上'],
  );
  // 上限是「下限」，所以 error 也要包含在 warn 的查询里。
  assert.equal(log.list({ level: 'error' }).length, 1);
});

test('createEventLog evicts the oldest entry and counts what it dropped', () => {
  const log = createEventLog({ limit: 3 });
  for (let i = 1; i <= 5; i += 1) log.info('queue', `任务 ${i}`);

  assert.deepEqual(
    log.list().map((entry) => entry.message),
    ['任务 5', '任务 4', '任务 3'],
  );
  assert.deepEqual(log.stats(), { size: 3, limit: 3, dropped: 2, total: 5 });

  assert.equal(log.clear(), 3);
  assert.deepEqual(log.list(), []);
  assert.deepEqual(log.stats(), { size: 0, limit: 3, dropped: 0, total: 5 });
});

test('createEventLog tolerates unknown levels and oversized fields', () => {
  const log = createEventLog({ limit: 5 });
  const entry = log.push('LOUD', 'x'.repeat(80), 'y'.repeat(3000), { status: 500 });

  // 不认识的级别退化成 info，而不是抛错——日志本身不该成为故障点。
  assert.equal(entry.level, 'info');
  assert.equal(entry.scope.length, 40);
  assert.equal(entry.message.length, 2000);
  assert.deepEqual(entry.meta, { status: 500 });
  assert.equal(log.list({ limit: 1 })[0].id, 1);
});

test('isLogLevel recognises exactly the four levels', () => {
  for (const level of LOG_LEVELS) assert.equal(isLogLevel(level), true);
  assert.equal(isLogLevel('WARN'), true);
  assert.equal(isLogLevel('trace'), false);
  assert.equal(isLogLevel(undefined), false);
  assert.equal(isLogLevel(null), false);
});
