import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;
const DEFAULT_MAIN_SIZE = 2048;
const DEFAULT_OTHER_SIZE = 1024;

export async function optimizeVrmTextures({
  input,
  output,
  mainSize = DEFAULT_MAIN_SIZE,
  otherSize = DEFAULT_OTHER_SIZE
}) {
  if (!input) throw new Error('Missing input path.');
  if (!output) throw new Error('Missing output path.');
  if (!Number.isInteger(mainSize) || mainSize <= 0) throw new Error('mainSize must be a positive integer.');
  if (!Number.isInteger(otherSize) || otherSize <= 0) throw new Error('otherSize must be a positive integer.');

  const source = await fs.readFile(input);
  const { gltf, binChunk } = parseGlb(source);
  if (!gltf.extensions?.VRM) {
    throw new Error('Input GLB does not contain the VRM extension.');
  }

  const mainImageIndexes = collectMainTextureImageIndexes(gltf);
  const imageUpdates = await buildImageUpdates(gltf, binChunk, { mainImageIndexes, mainSize, otherSize });
  const nextBin = rebuildBinChunk(gltf, binChunk, imageUpdates);
  const outputBuffer = encodeGlb(gltf, nextBin);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, outputBuffer);

  return summarizeOptimization({
    inputBytes: source.byteLength,
    outputBytes: outputBuffer.byteLength,
    gltf,
    imageUpdates,
    mainImageIndexes
  });
}

export function parseGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('Input is not a binary glTF/VRM file.');
  if (buffer.readUInt32LE(4) !== GLB_VERSION) throw new Error('Only glTF 2.0 binary files are supported.');

  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength > buffer.byteLength) throw new Error('GLB length header exceeds file size.');

  let offset = 12;
  let gltf = null;
  let binChunk = null;
  while (offset + 8 <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;
    const chunk = buffer.subarray(offset, offset + chunkLength);
    offset += chunkLength;

    if (chunkType === CHUNK_TYPE_JSON) {
      gltf = JSON.parse(chunk.toString('utf8').replace(/[\u0000 ]+$/u, ''));
    } else if (chunkType === CHUNK_TYPE_BIN) {
      binChunk = chunk;
    }
  }

  if (!gltf) throw new Error('GLB JSON chunk not found.');
  if (!binChunk) throw new Error('GLB BIN chunk not found.');
  return { gltf, binChunk };
}

export function collectMainTextureImageIndexes(gltf) {
  const indexes = new Set();
  for (const material of gltf.extensions?.VRM?.materialProperties || []) {
    const mainTextureIndex = material.textureProperties?._MainTex;
    addImageIndexForTexture(gltf, indexes, mainTextureIndex);
  }
  for (const material of gltf.materials || []) {
    addImageIndexForTexture(gltf, indexes, material.pbrMetallicRoughness?.baseColorTexture?.index);
  }
  return indexes;
}

export function inspectEmbeddedImages(gltf, binChunk) {
  return (gltf.images || []).map((image, imageIndex) => {
    const bufferView = gltf.bufferViews?.[image.bufferView];
    if (!bufferView) {
      return {
        imageIndex,
        name: image.name || '',
        mimeType: image.mimeType || '',
        byteLength: 0,
        width: 0,
        height: 0
      };
    }
    const bytes = readBufferView(binChunk, bufferView);
    const dimensions = readImageDimensions(bytes);
    return {
      imageIndex,
      name: image.name || '',
      mimeType: image.mimeType || dimensions.mimeType || '',
      byteLength: bytes.byteLength,
      width: dimensions.width || 0,
      height: dimensions.height || 0
    };
  });
}

async function buildImageUpdates(gltf, binChunk, { mainImageIndexes, mainSize, otherSize }) {
  const updates = new Map();
  for (const [imageIndex, image] of (gltf.images || []).entries()) {
    if (image.uri) continue;
    const bufferViewIndex = image.bufferView;
    const bufferView = gltf.bufferViews?.[bufferViewIndex];
    if (!bufferView) continue;

    const original = readBufferView(binChunk, bufferView);
    const metadata = await sharp(original, { animated: false }).metadata();
    const sourceWidth = metadata.width || 0;
    const sourceHeight = metadata.height || 0;
    const maxSize = mainImageIndexes.has(imageIndex) ? mainSize : otherSize;
    const needsResize = sourceWidth > maxSize || sourceHeight > maxSize;
    const nextBytes = needsResize
      ? await resizeImage(original, image.mimeType, maxSize)
      : Buffer.from(original);

    updates.set(bufferViewIndex, {
      imageIndex,
      originalBytes: original.byteLength,
      nextBytes,
      sourceWidth,
      sourceHeight,
      maxSize,
      role: mainImageIndexes.has(imageIndex) ? 'main' : 'support',
      resized: needsResize
    });
  }
  return updates;
}

async function resizeImage(bytes, mimeType, maxSize) {
  const pipeline = sharp(bytes, { animated: false }).resize({
    width: maxSize,
    height: maxSize,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: 'lanczos3'
  });

  if (mimeType === 'image/jpeg') return pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

function rebuildBinChunk(gltf, binChunk, imageUpdates) {
  const chunks = [];
  let offset = 0;

  for (const [bufferViewIndex, bufferView] of (gltf.bufferViews || []).entries()) {
    const update = imageUpdates.get(bufferViewIndex);
    const bytes = update?.nextBytes || Buffer.from(readBufferView(binChunk, bufferView));
    offset = align4(offset);
    bufferView.byteOffset = offset;
    bufferView.byteLength = bytes.byteLength;
    chunks.push({ offset, bytes });
    offset += bytes.byteLength;
  }

  const nextLength = align4(offset);
  const nextBin = Buffer.alloc(nextLength);
  for (const chunk of chunks) {
    chunk.bytes.copy(nextBin, chunk.offset);
  }

  if (!gltf.buffers?.[0]) gltf.buffers = [{ byteLength: nextLength }];
  gltf.buffers[0].byteLength = nextLength;
  delete gltf.buffers[0].uri;
  return nextBin;
}

function encodeGlb(gltf, binChunk) {
  const jsonBytes = Buffer.from(JSON.stringify(gltf));
  const paddedJson = padChunk(jsonBytes, 0x20);
  const paddedBin = padChunk(binChunk, 0x00);
  const totalLength = 12 + 8 + paddedJson.byteLength + 8 + paddedBin.byteLength;
  const output = Buffer.alloc(totalLength);
  let offset = 0;

  output.writeUInt32LE(GLB_MAGIC, offset);
  output.writeUInt32LE(GLB_VERSION, offset + 4);
  output.writeUInt32LE(totalLength, offset + 8);
  offset += 12;
  output.writeUInt32LE(paddedJson.byteLength, offset);
  output.writeUInt32LE(CHUNK_TYPE_JSON, offset + 4);
  paddedJson.copy(output, offset + 8);
  offset += 8 + paddedJson.byteLength;
  output.writeUInt32LE(paddedBin.byteLength, offset);
  output.writeUInt32LE(CHUNK_TYPE_BIN, offset + 4);
  paddedBin.copy(output, offset + 8);
  return output;
}

function summarizeOptimization({ inputBytes, outputBytes, gltf, imageUpdates, mainImageIndexes }) {
  const resized = Array.from(imageUpdates.values()).filter((update) => update.resized);
  return {
    inputBytes,
    outputBytes,
    inputMB: toMB(inputBytes),
    outputMB: toMB(outputBytes),
    savedMB: toMB(inputBytes - outputBytes),
    images: (gltf.images || []).length,
    mainImages: mainImageIndexes.size,
    resizedImages: resized.length,
    extensionsUsed: gltf.extensionsUsed || []
  };
}

function addImageIndexForTexture(gltf, indexes, textureIndex) {
  if (!Number.isInteger(textureIndex)) return;
  const imageIndex = gltf.textures?.[textureIndex]?.source;
  if (Number.isInteger(imageIndex)) indexes.add(imageIndex);
}

function readBufferView(binChunk, bufferView) {
  const byteOffset = bufferView.byteOffset || 0;
  return binChunk.subarray(byteOffset, byteOffset + bufferView.byteLength);
}

function readImageDimensions(bytes) {
  if (bytes.byteLength >= 24 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return {
      mimeType: 'image/png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20)
    };
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return readJpegDimensions(bytes);
  }
  return {};
}

function readJpegDimensions(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        mimeType: 'image/jpeg',
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5)
      };
    }
    offset += 2 + length;
  }
  return { mimeType: 'image/jpeg' };
}

function padChunk(buffer, byte) {
  const paddedLength = align4(buffer.byteLength);
  if (paddedLength === buffer.byteLength) return buffer;
  const padded = Buffer.alloc(paddedLength, byte);
  buffer.copy(padded);
  return padded;
}

function align4(value) {
  return (value + 3) & ~3;
}

function toMB(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function parseArgs(argv) {
  const args = {
    input: 'assets/8590256991748008892.vrm',
    output: 'assets/8590256991748008892.lite-2048-1024.vrm',
    mainSize: DEFAULT_MAIN_SIZE,
    otherSize: DEFAULT_OTHER_SIZE
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--main-size') args.mainSize = Number(argv[++index]);
    else if (arg === '--other-size') args.otherSize = Number(argv[++index]);
    else if (arg === '--help') {
      console.log('Usage: node scripts/optimize-vrm-textures.mjs [--input path] [--output path] [--main-size 2048] [--other-size 1024]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  optimizeVrmTextures(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    });
}
