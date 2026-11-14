/**
 * 提示词字数守卫的计数逻辑。
 *
 * 手册 1 节给的是「中文不超过 300 字、英文不超过 600 词」，这是建议不是硬限制，
 * 所以这里只断言「数得对」，不断言「超了就拦」——拦不拦是调用方的事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promptBudget, PROMPT_BUDGET } from '../public/ui.js';

test('promptBudget counts CJK characters and latin words separately', () => {
  const zh = promptBudget('一只橘猫在阳光下打哈欠');
  assert.equal(zh.cjk, 11);
  assert.equal(zh.words, 0);
  assert.equal(zh.over, false);

  const en = promptBudget('a corgi sitting in the snow, soft light');
  assert.equal(en.cjk, 0);
  assert.equal(en.words, 8, '逗号粘在词尾不算新词');
  assert.equal(en.over, false);
});

test('promptBudget handles mixed text and punctuation-only input', () => {
  const mixed = promptBudget('一只 corgi 在雪地里，soft light');
  assert.equal(mixed.cjk, 6);
  assert.equal(mixed.words, 3);

  assert.deepEqual(promptBudget('，。！？——'), {
    cjk: 0,
    words: 0,
    overChars: false,
    overWords: false,
    over: false,
  });
  assert.equal(promptBudget('').cjk, 0);
  assert.equal(promptBudget(null).words, 0);
});

test('promptBudget flags each budget independently', () => {
  const longZh = promptBudget('猫'.repeat(PROMPT_BUDGET.chars + 1));
  assert.equal(longZh.overChars, true);
  assert.equal(longZh.overWords, false);
  assert.equal(longZh.over, true);

  const longEn = promptBudget(Array.from({ length: PROMPT_BUDGET.words + 1 }, () => 'cat').join(' '));
  assert.equal(longEn.overChars, false);
  assert.equal(longEn.overWords, true);
  assert.equal(longEn.over, true);

  // 正好卡在上限不算超。
  assert.equal(promptBudget('猫'.repeat(PROMPT_BUDGET.chars)).over, false);
  assert.equal(
    promptBudget(Array.from({ length: PROMPT_BUDGET.words }, () => 'cat').join(' ')).over,
    false,
  );
});
