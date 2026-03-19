/**
 * make-ico.mjs — rebuild orca.ico from renderer/orca-logo-dark.png.
 *
 * The original ICO had off-by-one frame dimensions (31×32, 63×64…) and
 * all frames except 16×16 used the dark (black) mark, making it invisible
 * on the Windows taskbar. This script rebuilds with:
 *   - Standard sizes: 16, 32, 48, 64, 128, 256
 *   - All frames sourced from orca-logo-dark.png (white mark, transparent bg)
 *   - Proper ICO directory entries
 *
 * Run: node make-ico.mjs
 */

import fs   from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CRC-32 (needed for PNG chunks) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG decoder ──────────────────────────────────────────────────────────────

function parsePng(buf) {
  let pos = 8; // skip signature
  let width, height;
  const idatChunks = [];

  while (pos < buf.length) {
    const len  = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString("ascii");
    const data = buf.slice(pos + 8, pos + 8 + len);

    if (type === "IHDR") {
      width  = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth  = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || colorType !== 6)
        throw new Error(`Unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGBA)`);
    }
    if (type === "IDAT") idatChunks.push(data);
    if (type === "IEND") break;
    pos += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bpp    = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(width * height * bpp);

  function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  }

  for (let y = 0; y < height; y++) {
    const rowBase = y * (stride + 1);
    const filterType = raw[rowBase];
    const src = raw.slice(rowBase + 1, rowBase + 1 + stride);
    const dst = pixels.slice(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride, 0);

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? dst[x - bpp]   : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      const f = src[x];
      switch (filterType) {
        case 0: dst[x] = f; break;
        case 1: dst[x] = (f + a) & 0xff; break;
        case 2: dst[x] = (f + b) & 0xff; break;
        case 3: dst[x] = (f + Math.floor((a + b) / 2)) & 0xff; break;
        case 4: dst[x] = (f + paethPredictor(a, b, c)) & 0xff; break;
        default: dst[x] = f;
      }
    }
  }

  return { width, height, pixels };
}

// ── Bilinear resize ──────────────────────────────────────────────────────────

function resizePixels(src, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const sx = srcW / dstW;
  const sy = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const fx = (dx + 0.5) * sx - 0.5;
      const fy = (dy + 0.5) * sy - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(fy));
      const y1 = Math.min(srcH - 1, y0 + 1);
      const wx = fx - x0;
      const wy = fy - y0;

      for (let c = 0; c < 4; c++) {
        const v =
          src[(y0 * srcW + x0) * 4 + c] * (1 - wx) * (1 - wy) +
          src[(y0 * srcW + x1) * 4 + c] * wx       * (1 - wy) +
          src[(y1 * srcW + x0) * 4 + c] * (1 - wx) * wy       +
          src[(y1 * srcW + x1) * 4 + c] * wx       * wy;
        dst[(dy * dstW + dx) * 4 + c] = Math.round(v);
      }
    }
  }
  return dst;
}

// ── PNG encoder (filter-0 / None, single IDAT) ───────────────────────────────

function encodePng(pixels, width, height) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type, data) {
    const typeBuf = Buffer.from(type, "ascii");
    const lenBuf  = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf  = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  // Prepend filter byte 0 (None) to each row
  const stride  = width * 4;
  const rawRows = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    rawRows[y * (1 + stride)] = 0;
    pixels.copy(rawRows, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(rawRows, { level: 6 });

  return Buffer.concat([
    PNG_SIG,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", compressed),
    makeChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO builder ──────────────────────────────────────────────────────────────

function buildIco(frames) {
  // frames: Array<{ size: number, png: Buffer }>
  const ICO_HEADER = 6;
  const DIR_ENTRY  = 16;
  const dirSize    = ICO_HEADER + frames.length * DIR_ENTRY;

  let dataOffset = dirSize;
  const offsets = frames.map(f => { const o = dataOffset; dataOffset += f.png.length; return o; });

  const header = Buffer.alloc(dirSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(frames.length, 4);

  for (let i = 0; i < frames.length; i++) {
    const b = ICO_HEADER + i * DIR_ENTRY;
    const sz = frames[i].size;
    header[b]    = sz >= 256 ? 0 : sz; // 0 = 256 in ICO spec
    header[b + 1] = sz >= 256 ? 0 : sz;
    header[b + 2] = 0;  // color count (0 = not paletted)
    header[b + 3] = 0;  // reserved
    header.writeUInt16LE(1, b + 4);  // color planes
    header.writeUInt16LE(32, b + 6); // bits per pixel
    header.writeUInt32LE(frames[i].png.length, b + 8);
    header.writeUInt32LE(offsets[i], b + 12);
  }

  return Buffer.concat([header, ...frames.map(f => f.png)]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const srcPath = path.join(__dirname, "renderer", "orca-logo-dark.png");
const dstPath = path.join(__dirname, "orca.ico");

console.log("Reading source:", srcPath);
const srcBuf = fs.readFileSync(srcPath);
const { width: srcW, height: srcH, pixels: srcPixels } = parsePng(srcBuf);
console.log(`Source: ${srcW}×${srcH}`);

// Crop to square, centred
const cropSz = Math.min(srcW, srcH);
const cropX  = Math.floor((srcW - cropSz) / 2);
const cropY  = Math.floor((srcH - cropSz) / 2);
const cropped = Buffer.alloc(cropSz * cropSz * 4);
for (let y = 0; y < cropSz; y++) {
  for (let x = 0; x < cropSz; x++) {
    srcPixels.copy(cropped, (y * cropSz + x) * 4, ((y + cropY) * srcW + (x + cropX)) * 4, ((y + cropY) * srcW + (x + cropX)) * 4 + 4);
  }
}
console.log(`Cropped: ${cropSz}×${cropSz} (offset ${cropX},${cropY})`);

const SIZES = [16, 32, 48, 64, 128, 256];
const frames = SIZES.map(size => {
  const resized = resizePixels(cropped, cropSz, cropSz, size, size);
  const png = encodePng(resized, size, size);
  console.log(`  ${size}×${size}: ${png.length} bytes`);
  return { size, png };
});

const ico = buildIco(frames);
fs.writeFileSync(dstPath, ico);
console.log(`✓ Wrote ${dstPath} (${ico.length} bytes, ${SIZES.join("/")}px, white mark)`);
