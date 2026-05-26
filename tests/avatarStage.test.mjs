import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateStageBubbleMaxWidth,
  compactStageText,
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
