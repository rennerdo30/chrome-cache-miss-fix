/**
 * Generates the extension icons as PNGs, with no third-party dependencies.
 *
 * The artwork is described analytically (a squircle plate, a broken ring and an
 * arrowhead) and sampled with 4x4 supersampling for smooth edges, so every size
 * is drawn at full quality instead of being scaled from one bitmap.
 *
 * Run: node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES_PER_AXIS = 4;

/* Artwork geometry, in coordinates where the icon spans -1 … 1 on both axes. */
const PLATE_EXPONENT = 4;          // 2 = circle, larger = squarer
const PLATE_RADIUS = 0.97;
const RING_RADIUS = 0.5;
const RING_HALF_THICKNESS = 0.093;
const RING_GAP_START_DEG = 4;      // the arrowhead occupies the gap
const RING_GAP_END_DEG = 62;
const ARROW_BASE_ANGLE_DEG = 62;   // sits flush against the arc's end
const ARROW_TIP_ANGLE_DEG = 10;    // points clockwise, continuing the arc
const ARROW_HALF_WIDTH = 0.175;

const PLATE_COLOR_START = [0x63, 0x66, 0xf1];
const PLATE_COLOR_END = [0x8b, 0x5c, 0xf6];
const GLYPH_COLOR = [0xff, 0xff, 0xff];

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Signed-distance style test for the rounded plate. */
function insidePlate(x, y) {
  const value = Math.abs(x) ** PLATE_EXPONENT + Math.abs(y) ** PLATE_EXPONENT;
  return value <= PLATE_RADIUS ** PLATE_EXPONENT;
}

function normaliseAngle(angle) {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

/** True inside the ring, except for the wedge reserved for the arrowhead. */
function insideRing(x, y) {
  const radius = Math.hypot(x, y);
  if (Math.abs(radius - RING_RADIUS) > RING_HALF_THICKNESS) return false;

  const angle = normaliseAngle(Math.atan2(y, x));
  const gapStart = normaliseAngle(toRadians(RING_GAP_START_DEG));
  const gapEnd = normaliseAngle(toRadians(RING_GAP_END_DEG));
  const inGap = gapStart < gapEnd
    ? angle >= gapStart && angle <= gapEnd
    : angle >= gapStart || angle <= gapEnd;
  return !inGap;
}

const polar = (radius, degrees) => [
  radius * Math.cos(toRadians(degrees)),
  radius * Math.sin(toRadians(degrees)),
];

const ARROW_VERTICES = [
  polar(RING_RADIUS, ARROW_TIP_ANGLE_DEG),
  polar(RING_RADIUS - ARROW_HALF_WIDTH, ARROW_BASE_ANGLE_DEG),
  polar(RING_RADIUS + ARROW_HALF_WIDTH, ARROW_BASE_ANGLE_DEG),
];

function insideArrow(x, y) {
  const [a, b, c] = ARROW_VERTICES;
  const sign = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = sign(a, b, [x, y]);
  const d2 = sign(b, c, [x, y]);
  const d3 = sign(c, a, [x, y]);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
}

function mixChannel(from, to, ratio) {
  return Math.round(from + (to - from) * ratio);
}

function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SAMPLES_PER_AXIS);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let plateHits = 0;
      let glyphHits = 0;

      for (let sy = 0; sy < SAMPLES_PER_AXIS; sy += 1) {
        for (let sx = 0; sx < SAMPLES_PER_AXIS; sx += 1) {
          const u = (px * SAMPLES_PER_AXIS + sx + 0.5) * step;
          const v = (py * SAMPLES_PER_AXIS + sy + 0.5) * step;
          const x = u * 2 - 1;
          const y = 1 - v * 2; // screen y grows downwards
          if (!insidePlate(x, y)) continue;
          plateHits += 1;
          if (insideRing(x, y) || insideArrow(x, y)) glyphHits += 1;
        }
      }

      const totalSamples = SAMPLES_PER_AXIS * SAMPLES_PER_AXIS;
      const plateCoverage = plateHits / totalSamples;
      const offset = (py * size + px) * 4;
      if (plateCoverage === 0) continue;

      const gradientRatio = (px + py) / (2 * (size - 1 || 1));
      const glyphRatio = glyphHits / Math.max(plateHits, 1);
      for (let channel = 0; channel < 3; channel += 1) {
        const plateChannel = mixChannel(
          PLATE_COLOR_START[channel], PLATE_COLOR_END[channel], gradientRatio,
        );
        pixels[offset + channel] = mixChannel(plateChannel, GLYPH_COLOR[channel], glyphRatio);
      }
      pixels[offset + 3] = Math.round(plateCoverage * 255);
    }
  }
  return pixels;
}

/* ------------------------------------------------------------ PNG encoding */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0; // filter type: none
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUTPUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, renderPixels(size)));
  process.stdout.write(`wrote ${file}\n`);
}
