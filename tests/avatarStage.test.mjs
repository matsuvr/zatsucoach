import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateStageBubbleMaxWidth,
  calculateVRPanelDepth,
  calculateVRTextCanvasMetrics,
  fitCanvasText,
  getRendererProfile,
  normalizeStageText,
  wrapCanvasText
} from '../avatarStageUtils.mjs';

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

test('VR panel depth moves older panels farther from the user', () => {
  assert.deepEqual(
    [0, 1, 2].map((index) => calculateVRPanelDepth(-1.35, index, 3)),
    [-1.374, -1.362, -1.35]
  );
});

test('VR panel depth clamps invalid indexes and counts', () => {
  assert.equal(calculateVRPanelDepth(0.06, -1, 3), 0.036);
  assert.equal(calculateVRPanelDepth(0.06, 99, 3), 0.06);
  assert.equal(calculateVRPanelDepth(0.06, 0, 0), 0.06);
});

test('Quest renderer profile keeps VR quality settings enabled', () => {
  const profile = getRendererProfile({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) OculusBrowser MetaQuest Quest 3',
    deviceMemory: 4,
    hardwareConcurrency: 6
  });

  assert.deepEqual(profile, {
    name: 'quest-vr-quality',
    antialias: true,
    maxPixelRatio: 2,
    precision: 'highp',
    xrFramebufferScaleFactor: 1.4,
    vrTextTextureScale: 2
  });
});

test('non-Quest low-power renderer profile keeps lightweight settings', () => {
  const profile = getRendererProfile({
    userAgent: 'Mozilla/5.0 (Linux; Android 13) Mobile Safari/537.36',
    deviceMemory: 4,
    hardwareConcurrency: 6
  });

  assert.deepEqual(profile, {
    name: 'low-power',
    antialias: false,
    maxPixelRatio: 1,
    precision: 'mediump',
    xrFramebufferScaleFactor: 1,
    vrTextTextureScale: 1
  });
});

test('VR text canvas metrics increase density without changing logical aspect', () => {
  const metrics = calculateVRTextCanvasMetrics({
    panelWidth: 1.48,
    panelHeight: 0.32,
    textureScale: 2
  });

  assert.equal(metrics.logicalWidth, 1024);
  assert.equal(metrics.canvasWidth, 2048);
  assert.equal(metrics.textureScale, 2);
  assert.equal(metrics.minLogicalHeight, Math.round(1024 * (0.32 / 1.48)));
});

test('canvas text wrapper truncates long text by measured width', () => {
  const ctx = { measureText: (value) => ({ width: Array.from(value).length * 10 }) };
  assert.deepEqual(wrapCanvasText(ctx, 'abcdefghij', 30, 2, true), ['abc', 'de…']);
  assert.deepEqual(wrapCanvasText(ctx, 'abcdef', 30, 3, false), ['abc', 'def']);
});

test('canvas text wrapper keeps full text when truncation is disabled', () => {
  const ctx = { measureText: (value) => ({ width: Array.from(value).length * 10 }) };
  assert.deepEqual(wrapCanvasText(ctx, 'abcdefghij', 30, 2, false), ['abc', 'def', 'ghi', 'j']);
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
