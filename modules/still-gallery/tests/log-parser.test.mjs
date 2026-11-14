import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWhiteboardLog,
  parseSessionBlock,
  extractUserRequest,
  unwrapPromptEnvelope,
  extractBalancedJson,
  unescapeJsonString,
  sessionToEntry,
} from '../lib/log-parser.mjs';
import { SAMPLE_LOG, EXPECTED, EXPECTED_EXPIRY_ISO } from './log-fixture.mjs';

test('parses every generation session in the log', () => {
  const result = parseWhiteboardLog(SAMPLE_LOG, { fileName: 'whiteboard_agent.log' });
  assert.equal(result.fileName, 'whiteboard_agent.log');
  assert.equal(result.stats.total, EXPECTED.total);
  assert.equal(result.stats.withImage, EXPECTED.withImage);
  assert.equal(result.stats.withoutImage, EXPECTED.withoutImage);
  assert.equal(result.stats.image2image, EXPECTED.image2image);
  assert.equal(result.stats.text2image, EXPECTED.total - EXPECTED.image2image);
  assert.equal(result.sessions.length, EXPECTED.total);
});

test('extracts session ids, titles and image urls', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ['111111111', '222222222', '333333333', '444444444'],
  );
  assert.deepEqual(
    sessions.map((session) => session.imageUrl),
    [...EXPECTED.urls, ''],
  );
  assert.equal(sessions[0].title, '画一只坐在窗台上的橘猫');
  assert.equal(sessions[2].title, '把背景改成夜晚');
  assert.equal(sessions[3].status, 'no-image');
});

test('prefers the untruncated user_input over the banner copy', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  const first = sessions[0];
  assert.equal(first.inputWasTruncated, true, 'the banner input ends mid-sentence');
  assert.match(first.userInput, /背景必须是纯白色/);
  assert.match(first.userInput, /纯色平涂，有合理渐变/);
});

test('reads the image API payload even though the logger truncated it', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  assert.equal(sessions[0].imageModel, 'doubao-seedream-4-0-20260415');
  assert.equal(sessions[0].size, '2K');
  assert.equal(sessions[0].watermark, true);
  assert.equal(sessions[0].promptOptimizeMode, 'standard');
  // The `{"content": "..."}` envelope is unwrapped.
  assert.equal(sessions[0].prompt, '一只橘猫坐在木质窗台上，午后阳光斜照，赛璐珞简笔漫画风格');
  assert.equal(sessions[0].promptTruncated, false);

  // A truncated envelope still yields readable prompt text.
  assert.match(sessions[1].prompt, /画一栋海边的房子/);
  assert.doesNotMatch(sessions[1].prompt, /^\{/);
  assert.equal(sessions[1].promptTruncated, true);
  assert.equal(sessions[1].llmModel, 'doubao-seed-2-0-pro-260215');
});

test('detects image-to-image runs and their reference payload', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  const img2img = sessions[2];
  assert.equal(img2img.mode, 'image2image');
  assert.equal(img2img.hasReferenceImage, true);
  assert.equal(img2img.referenceChars, 667820);
});

test('parses durations from both the plain and the FastPath log tags', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  assert.equal(sessions[0].totalSeconds, 64.93);
  assert.equal(sessions[0].llmSeconds, 58.92);
  assert.equal(sessions[0].toolSeconds, 5.97);
  assert.equal(sessions[0].imageApiSeconds, 5.97);
  assert.equal(sessions[2].totalSeconds, 15.35, 'FastPath durations must not be missed');
  assert.equal(sessions[2].imageApiSeconds, 15.34);
});

test('missing measurements become null rather than zero', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  assert.equal(sessions[2].toolSeconds, null, 'FastPath logs no tool breakdown');
  assert.equal(sessions[3].totalSeconds, null, 'the text-only run has no duration summary');
  assert.equal(sessions[3].tokens, null);
});

test('parses token usage and the url expiry embedded in the signed link', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  assert.deepEqual(sessions[0].tokens, { prompt: 4714, completion: 2372, total: 7086 });
  assert.equal(sessions[0].imageUrlExpiresAt, EXPECTED_EXPIRY_ISO);
  assert.equal(sessions[0].doneUrlMatchesLog, true);
});

test('sessions without an image are flagged and explained', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  const empty = sessions[3];
  assert.equal(empty.status, 'no-image');
  assert.equal(empty.prompt, '');
  assert.ok(empty.warnings.some((warning) => warning.includes('未产出图片')));
});

test('empty or unrelated input is reported instead of throwing', () => {
  assert.equal(parseWhiteboardLog('').stats.total, 0);
  assert.deepEqual(parseWhiteboardLog('').warnings, ['日志内容为空']);

  const unrelated = parseWhiteboardLog('2026-09-17 10:00:00,000 INFO boot: starting up\n');
  assert.equal(unrelated.stats.total, 0);
  assert.ok(unrelated.warnings[0].includes('GENERATE START'));
});

test('extractUserRequest handles both prompt templates', () => {
  assert.equal(extractUserRequest('请根据用户需求生成一张插画。\n\n用户需求：画一棵树\n\n【核心风格】\n线条清晰'), '画一棵树');
  assert.equal(
    extractUserRequest('你是一名专业插画师。基于参考图像图生图编辑，最高优先级执行：把天空换成晚霞,输出编辑后的图片。\n1.只修改'),
    '把天空换成晚霞,输出编辑后的图片',
  );
  assert.equal(extractUserRequest(''), '');
});

test('unwrapPromptEnvelope handles plain text, valid and truncated envelopes', () => {
  assert.equal(unwrapPromptEnvelope('直接就是提示词'), '直接就是提示词');
  assert.equal(unwrapPromptEnvelope('{"content": "包在信封里"}'), '包在信封里');
  assert.equal(unwrapPromptEnvelope('{"content": "被截断的提示词...'), '被截断的提示词...');
  assert.equal(unwrapPromptEnvelope('{"用户需求": "换个键名也一样"}'), '换个键名也一样');
  // Escapes inside the envelope are decoded.
  assert.equal(unwrapPromptEnvelope('{"content": "第一行\\n第二行"}'), '第一行\n第二行');
});

test('unescapeJsonString decodes the escapes the logger emits', () => {
  assert.equal(unescapeJsonString('a\\nb'), 'a\nb');
  assert.equal(unescapeJsonString('说\\"引号\\"'), '说"引号"');
  assert.equal(unescapeJsonString('\\u4e2d\\u6587'), '中文');
});

test('extractBalancedJson survives nested braces and braces inside strings', () => {
  const text = 'payload: {"a": {"b": 1}, "c": "} not the end", "d": [{"e": 2}]} trailing';
  assert.equal(extractBalancedJson(text), '{"a": {"b": 1}, "c": "} not the end", "d": [{"e": 2}]}');
  assert.equal(extractBalancedJson('no json here'), null);
});

test('parseSessionBlock is usable on a single block', () => {
  const block = SAMPLE_LOG.split(/^.*?GENERATE START.*$/m)[1];
  const session = parseSessionBlock(block, 0);
  assert.equal(session.index, 1);
  assert.equal(session.sessionId, '111111111');
  assert.equal(session.status, 'ok');
});

test('sessionToEntry maps a session onto the gallery entry shape', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG, { fileName: 'whiteboard_agent.log' });
  const entry = sessionToEntry(sessions[0], { tags: ['白板智能体'], source: 'whiteboard_agent.log' });

  assert.equal(entry.title, '画一只坐在窗台上的橘猫');
  assert.equal(entry.prompt, '一只橘猫坐在木质窗台上，午后阳光斜照，赛璐珞简笔漫画风格');
  assert.equal(entry.model, 'doubao-seedream-4-0-20260415');
  assert.equal(entry.aspectRatio, '2K');
  assert.deepEqual(entry.tags, ['白板智能体', '文生图']);
  assert.equal(entry.provenance.source, 'whiteboard_agent.log');
  assert.equal(entry.provenance.sessionId, '111111111');
  assert.equal(entry.provenance.mode, 'text2image');
  assert.equal(entry.provenance.latencySeconds, 64.93);
  assert.deepEqual(entry.provenance.tokens, { prompt: 4714, completion: 2372, total: 7086 });
  // Derived from the fixture's own X-Tos-Date + X-Tos-Expires rather than
  // hardcoded: the signed url is stamped at load time, so a literal date here
  // would rot within a day.
  assert.equal(entry.provenance.urlExpiresAt, EXPECTED_EXPIRY_ISO);
  // Never carries an image url of its own — the downloader decides that.
  assert.equal(entry.imageUrl, undefined);
  assert.equal(entry.sourceUrl, undefined);
});

test('sessionToEntry labels image-to-image runs and de-duplicates tags', () => {
  const { sessions } = parseWhiteboardLog(SAMPLE_LOG);
  const entry = sessionToEntry(sessions[2], { tags: ['图生图', '白板智能体'], source: 'log' });
  assert.deepEqual(entry.tags, ['图生图', '白板智能体']);
  assert.equal(entry.provenance.mode, 'image2image');
  assert.equal(entry.provenance.referenceImage, true);
});
