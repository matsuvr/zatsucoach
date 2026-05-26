import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateStageBubbleMaxWidth,
  compactStageText,
  fitCanvasText,
  normalizeStageText,
  wrapCanvasText
} from '../avatarStage.mjs';

test('stage bubble width clamps to configured bounds', () => {
  assert.equal(calculateStageBubbleMaxWidth(20), 72);
  assert.equal(calculateStageBubbleMaxWidth(240.8), 240);
  assert.equal(calculateStageBubbleMaxWidth(900), 520);
});

test('stage text normalizes reason labels and whitespace', () => {
  assert.equal(
    normalizeStageText('  良いです   理由:  質問できています\n\n\n次へ  '),
    '良いです\n理由: 質問できています\n\n次へ'
  );
});

test('stage text compacts with ellipsis', () => {
  assert.equal(compactStageText('1234567890', 6), '12345…');
});

test('canvas text wrapper truncates long text by measured width', () => {
  const ctx = { measureText: (value) => ({ width: Array.from(value).length * 10 }) };
  assert.deepEqual(wrapCanvasText(ctx, 'abcdefghij', 30, 2, true), ['abc', 'de…']);
  assert.deepEqual(wrapCanvasText(ctx, 'abcdef', 30, 3, false), ['abc', 'def']);
});

test('canvas text wrapper keeps ellipsis inside measured width', () => {
  const ctx = {
    measureText: (value) => ({
      width: Array.from(value).reduce((sum, unit) => sum + (unit === '…' ? 20 : 10), 0)
    })
  };
  const lines = wrapCanvasText(ctx, 'abcdefghij', 30, 2, true);
  assert.deepEqual(lines, ['abc', 'd…']);
  assert.equal(lines.every((line) => ctx.measureText(line).width <= 30), true);
});

test('canvas text fitter shrinks advice text before truncating', () => {
  const ctx = {
    font: '',
    measureText(value) {
      const size = Number((this.font.match(/(\d+)px/) || [])[1]) || 20;
      return { width: Array.from(value).length * size * 0.5 };
    }
  };
  const layout = fitCanvasText(ctx, 'a'.repeat(32), {
    maxWidth: 100,
    maxLines: 2,
    fontSize: 20,
    minFontSize: 10,
    truncate: true
  });
  assert.equal(layout.fontSize < 20, true);
  assert.equal(layout.lines.join('').includes('…'), false);
  assert.equal(layout.lines.join('').length, 32);
  assert.equal(layout.lines.every((line) => ctx.measureText(line).width <= 100), true);
});
