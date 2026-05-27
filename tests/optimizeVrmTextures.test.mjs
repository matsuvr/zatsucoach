import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  collectMainTextureImageIndexes,
  inspectEmbeddedImages,
  optimizeVrmTextures,
  parseGlb
} from '../scripts/optimize-vrm-textures.mjs';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

test('optimizeVrmTextures resizes images while preserving VRM metadata', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zatsucoach-vrm-test-'));
  const input = path.join(tmp, 'avatar.vrm');
  const output = path.join(tmp, 'avatar.lite.vrm');
  const mainPng = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: '#ff0000ff'
    }
  }).png().toBuffer();
  const supportPng = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: '#0000ffff'
    }
  }).png().toBuffer();

  await fs.writeFile(input, createTestVrmGlb([mainPng, supportPng]));
  const summary = await optimizeVrmTextures({ input, output, mainSize: 8, otherSize: 4 });
  const result = await fs.readFile(output);
  const { gltf, binChunk } = parseGlb(result);
  const images = inspectEmbeddedImages(gltf, binChunk);

  assert.equal(result.readUInt32LE(0), GLB_MAGIC);
  assert.equal(gltf.extensionsUsed.includes('VRM'), true);
  assert.equal(Boolean(gltf.extensions?.VRM), true);
  assert.deepEqual(Array.from(collectMainTextureImageIndexes(gltf)), [0]);
  assert.equal(images[0].width, 8);
  assert.equal(images[0].height, 8);
  assert.equal(images[1].width, 4);
  assert.equal(images[1].height, 4);
  assert.equal(summary.resizedImages, 2);
});

function createTestVrmGlb(images) {
  const bufferViews = [];
  const chunks = [];
  let binOffset = 0;
  for (const image of images) {
    binOffset = align4(binOffset);
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: image.byteLength });
    chunks.push({ offset: binOffset, bytes: image });
    binOffset += image.byteLength;
  }
  const bin = Buffer.alloc(align4(binOffset));
  for (const chunk of chunks) chunk.bytes.copy(bin, chunk.offset);

  const gltf = {
    asset: { version: '2.0', generator: 'zatsucoach-test' },
    extensionsUsed: ['VRM'],
    extensions: {
      VRM: {
        materialProperties: [
          { textureProperties: { _MainTex: 0 } },
          { textureProperties: { _BumpMap: 1 } }
        ]
      }
    },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews,
    images: [
      { mimeType: 'image/png', bufferView: 0 },
      { mimeType: 'image/png', bufferView: 1 }
    ],
    textures: [
      { source: 0 },
      { source: 1 }
    ]
  };

  return encodeGlb(gltf, bin);
}

function encodeGlb(gltf, bin) {
  const json = padChunk(Buffer.from(JSON.stringify(gltf)), 0x20);
  const paddedBin = padChunk(bin, 0x00);
  const totalLength = 12 + 8 + json.byteLength + 8 + paddedBin.byteLength;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(GLB_VERSION, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(json.byteLength, 12);
  output.writeUInt32LE(CHUNK_TYPE_JSON, 16);
  json.copy(output, 20);
  const binHeaderOffset = 20 + json.byteLength;
  output.writeUInt32LE(paddedBin.byteLength, binHeaderOffset);
  output.writeUInt32LE(CHUNK_TYPE_BIN, binHeaderOffset + 4);
  paddedBin.copy(output, binHeaderOffset + 8);
  return output;
}

function padChunk(buffer, byte) {
  const padded = Buffer.alloc(align4(buffer.byteLength), byte);
  buffer.copy(padded);
  return padded;
}

function align4(value) {
  return (value + 3) & ~3;
}
