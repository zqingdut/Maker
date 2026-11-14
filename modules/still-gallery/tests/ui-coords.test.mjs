/**
 * 交互编辑的坐标换算。
 *
 * 这一层必须单独测：屏幕上拖出来的框要换算成**原图像素**才能写进
 * `<bbox>`，上游是按原图像素理解这四个数的。差一个 offset 就会框到别处，
 * 而这种错在浏览器里很难一眼看出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { containRect, pointerToImagePixel, bboxTag, pointTag } from '../public/ui.js';

test('containRect centres a wide image inside a square box', () => {
  const fit = containRect({ boxWidth: 400, boxHeight: 400, naturalWidth: 800, naturalHeight: 400 });
  assert.equal(fit.scale, 0.5);
  assert.equal(fit.width, 400);
  assert.equal(fit.height, 200);
  assert.equal(fit.offsetX, 0);
  assert.equal(fit.offsetY, 100, '上下各留 100px 空白');
});

test('containRect centres a tall image and refuses empty input', () => {
  const fit = containRect({ boxWidth: 400, boxHeight: 400, naturalWidth: 400, naturalHeight: 800 });
  assert.equal(fit.height, 400);
  assert.equal(fit.width, 200);
  assert.equal(fit.offsetX, 100);

  assert.equal(containRect({ boxWidth: 0, boxHeight: 400, naturalWidth: 400, naturalHeight: 400 }), null);
  assert.equal(containRect({ boxWidth: 400, boxHeight: 400, naturalWidth: 0, naturalHeight: 400 }), null);
});

test('pointerToImagePixel maps through the letterbox and clamps', () => {
  const rect = { left: 10, top: 20, width: 400, height: 400 };
  const base = { rect, naturalWidth: 800, naturalHeight: 400 };

  // 正中心 → 原图 (400, 200)
  assert.deepEqual(pointerToImagePixel({ ...base, clientX: 210, clientY: 220 }), { x: 400, y: 200 });

  // 画面上沿（还在留白里）→ y 钳到 0
  assert.deepEqual(pointerToImagePixel({ ...base, clientX: 210, clientY: 30 }), { x: 400, y: 0 });

  // 左上角留白外 → 两个都钳到 0
  assert.deepEqual(pointerToImagePixel({ ...base, clientX: 0, clientY: 0 }), { x: 0, y: 0 });

  // 右下角外 → 钳到原图边界
  assert.deepEqual(pointerToImagePixel({ ...base, clientX: 900, clientY: 900 }), { x: 800, y: 400 });
});

test('pointerToImagePixel returns null before the image has decoded', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 };
  assert.equal(pointerToImagePixel({ clientX: 1, clientY: 1, rect, naturalWidth: 0, naturalHeight: 0 }), null);
});

test('bboxTag puts the top-left corner first, whatever the drag direction', () => {
  assert.equal(bboxTag({ x: 179, y: 283 }, { x: 796, y: 986 }), '<bbox>179 283 796 986</bbox>');
  // 反方向拖（右下 → 左上）必须归一化，否则上游拿到的是负宽高。
  assert.equal(bboxTag({ x: 796, y: 986 }, { x: 179, y: 283 }), '<bbox>179 283 796 986</bbox>');
  assert.equal(bboxTag({ x: 5, y: 9 }, { x: 5, y: 9 }), '<bbox>5 9 5 9</bbox>');
});

test('pointTag formats a single point', () => {
  assert.equal(pointTag({ x: 512, y: 0 }), '<point>512 0</point>');
});
