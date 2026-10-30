import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';

// Generate a plain bitmap in memory. No camera image or card artwork is used.
function syntheticTextBitmap() {
  const glyphs = {
    T: ['11111','00100','00100','00100','00100','00100','00100'],
    E: ['11111','10000','10000','11110','10000','10000','11111'],
    S: ['01111','10000','10000','01110','00001','00001','11110'],
    1: ['00100','01100','00100','00100','00100','00100','01110'],
    2: ['01110','10001','00001','00010','00100','01000','11111'],
    3: ['11110','00001','00001','01110','00001','00001','11110'],
  };
  const text = 'TEST 123', scale = 6, padding = 12;
  const width = (text.length * 6 - 1) * scale + padding * 2;
  const height = 7 * scale + padding * 2;
  const stride = Math.ceil(width * 3 / 4) * 4;
  const image = Buffer.alloc(54 + stride * height, 255);
  image.fill(0, 0, 54);
  image.write('BM');
  image.writeUInt32LE(image.length, 2);
  image.writeUInt32LE(54, 10);
  image.writeUInt32LE(40, 14);
  image.writeInt32LE(width, 18);
  image.writeInt32LE(height, 22);
  image.writeUInt16LE(1, 26);
  image.writeUInt16LE(24, 28);
  image.writeUInt32LE(stride * height, 34);
  for (const [letter, character] of [...text].entries()) {
    for (const [row, pixels] of (glyphs[character] || []).entries()) {
      for (let column = 0; column < pixels.length; column++) if (pixels[column] === '1') {
        for (let dy = 0; dy < scale; dy++) {
          const x = padding + (letter * 6 + column) * scale;
          const y = padding + row * scale + dy;
          const offset = 54 + (height - y - 1) * stride + x * 3;
          image.fill(0, offset, offset + scale * 3);
        }
      }
    }
  }
  return image;
}

test('the local English OCR runtime reads generated text without camera fixtures', { timeout: 10000 }, async () => {
  const worker = await createWorker('eng', 1, {
    langPath: fileURLToPath(new URL('../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url)),
    cacheMethod: 'none', gzip: true,
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '7' });
    const { data } = await worker.recognize(syntheticTextBitmap(), {}, { text: true });
    assert.equal(data.text.trim().replace(/\s+/g, ' '), 'TEST 123');
  } finally { await worker.terminate(); }
});

test('installed card assets include the latest sets and complete matching data', async () => {
  const db = JSON.parse(await fs.readFile(new URL('../public/card-hashes.json', import.meta.url), 'utf8'));
  const ids = new Set();
  const counts = {};
  for (const card of db.cards) {
    assert.ok(card.id && !ids.has(card.id), `Duplicate or empty ID: ${card.id}`);
    ids.add(card.id);
    counts[card.set] = (counts[card.set] || 0) + 1;
    assert.equal(card.f.length, db.gridSize ** 2 * 3, card.id);
    assert.ok(card.f.every(v => Number.isFinite(v) && v >= 0 && v <= 1), card.id);
    const image = await fs.stat(new URL(`../public/cards/${card.id}.webp`, import.meta.url));
    assert.ok(image.size > 0, `Missing image: ${card.id}`);
  }
  for (const [set, count] of Object.entries({ OGN: 352, OGS: 24, SFD: 288, UNL: 288, RAD: 219, VEN: 237 })) {
    assert.ok(counts[set] >= count, `${set}: expected at least ${count}, got ${counts[set] || 0}`);
  }
});
