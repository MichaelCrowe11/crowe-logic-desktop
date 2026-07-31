// A QR encoder, byte mode, error correction level M, versions 1 to 10.
//
// Written rather than installed for the reason gen-mark.js draws the icon
// rather than importing one: this repo ships an app that signs and notarizes,
// and every dependency is a thing to audit. A pairing code is ~140 bytes of
// ASCII, which version 7 holds comfortably, so the long tail of the spec —
// kanji mode, ECI, versions to 40 — is weight with no cargo.
//
// Level M corrects about 15% of the symbol. That is the usual choice for a code
// read off a screen: L is smaller and fine in perfect conditions, but the phone
// is being held at an angle, in a grow room, over a laptop display with a sheen
// on it.
//
// Correctness here is not obvious by reading, so scripts/test-qr.js does not
// try: it renders each code and decodes it back with the same CoreImage
// detector the iPhone camera uses. Encoding that no scanner accepts is the
// failure mode worth testing, and only a real decoder can see it.

// ─── GF(256) ─────────────────────────────────────────────────────────────────
// The field the Reed-Solomon parity is computed in: x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// The generator polynomial for `degree` parity bytes: (x-a^0)(x-a^1)...
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function ecBytes(data, count) {
  const gen = generator(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

// ─── Version table, level M ──────────────────────────────────────────────────
// [data codewords, EC codewords per block, [ [blocks, data per block], ... ] ]
const VERSIONS = {
  1:  [16,  10, [[1, 16]]],
  2:  [28,  16, [[1, 28]]],
  3:  [44,  26, [[1, 44]]],
  4:  [64,  18, [[2, 32]]],
  5:  [86,  24, [[2, 43]]],
  6:  [108, 16, [[4, 27]]],
  7:  [124, 18, [[4, 31]]],
  8:  [154, 22, [[2, 38], [2, 39]]],
  9:  [182, 22, [[3, 36], [2, 37]]],
  10: [216, 26, [[4, 43], [1, 44]]],
};
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

function pickVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    // 4 mode bits + the character count (8 bits below version 10, 16 at 10)
    const header = 4 + (v < 10 ? 8 : 16);
    if (VERSIONS[v][0] * 8 >= header + byteLength * 8) return v;
  }
  throw new Error(`${byteLength} bytes does not fit a version 10 code at level M (216 max)`);
}

// ─── Bitstream ───────────────────────────────────────────────────────────────
function codewords(bytes, version) {
  const [dataCount] = VERSIONS[version];
  const bits = [];
  const push = (value, width) => { for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1); };

  push(0b0100, 4);                                  // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCount * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  }
  // The spec's pad bytes, alternating, until the capacity is used.
  for (let i = 0; out.length < dataCount; i++) out.push(i % 2 === 0 ? 0xec : 0x11);
  return out;
}

// Data and parity are interleaved across blocks so a scratch that destroys one
// region of the symbol costs every block a little rather than one block all.
function interleave(data, version) {
  const [, ecCount, groups] = VERSIONS[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(at, at + size);
      at += size;
      blocks.push({ data: chunk, ec: ecBytes(chunk, ecCount) });
    }
  }
  const out = [];
  const widest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < widest; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecCount; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ─── Matrix ──────────────────────────────────────────────────────────────────
function emptyMatrix(size) {
  return { size, cells: Array.from({ length: size }, () => new Array(size).fill(null)) };
}

function drawFunctionPatterns(m, version) {
  const { size, cells } = m;
  const set = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) cells[r][c] = v; };

  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
        const inSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, inRing || inSide || inCore ? 1 : 0);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {          // timing
    const v = i % 2 === 0 ? 1 : 0;
    cells[6][i] = v; cells[i][6] = v;
  }

  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      // Skipped where a finder already sits.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, edge === 1 ? 0 : 1);
        }
      }
    }
  }

  cells[size - 8][8] = 1;                        // the dark module, always set

  for (let i = 0; i < 9; i++) {                  // reserve the format areas
    if (cells[8][i] === null) cells[8][i] = 0;
    if (cells[i][8] === null) cells[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (cells[8][size - 1 - i] === null) cells[8][size - 1 - i] = 0;
    if (cells[size - 1 - i][8] === null) cells[size - 1 - i][8] = 0;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        cells[size - 11 + j][i] = 0;
        cells[i][size - 11 + j] = 0;
      }
    }
  }
}

// A second matrix marking which cells the function patterns own, so the data
// walk can skip them without having to re-derive where they were.
function reservedMask(version, size) {
  const probe = emptyMatrix(size);
  drawFunctionPatterns(probe, version);
  return probe.cells.map((row) => row.map((v) => v !== null));
}

function placeData(m, bytes, reserved) {
  const { size, cells } = m;
  let bit = 0;
  const next = () => {
    if (bit >= bytes.length * 8) return 0;       // remainder bits are zero
    const v = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit += 1;
    return v;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;                 // the vertical timing column is not a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        cells[row][col] = next();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(cells) {
  const size = cells.length;
  let score = 0;

  const runScore = (line) => {
    let n = 1, s = 0;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) { n += 1; continue; }
      if (n >= 5) s += 3 + (n - 5);
      n = 1;
    }
    if (n >= 5) s += 3 + (n - 5);
    return s;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(cells[i]);
    score += runScore(cells.map((row) => row[i]));
  }

  for (let r = 0; r < size - 1; r++) {           // 2x2 blocks of one colour
    for (let c = 0; c < size - 1; c++) {
      const v = cells[r][c];
      if (v === cells[r][c + 1] && v === cells[r + 1][c] && v === cells[r + 1][c + 1]) score += 3;
    }
  }

  // The finder-like sequence, which a scanner could mistake for a finder.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, at, pat) => pat.every((v, i) => line[at + i] === v);
  for (let i = 0; i < size; i++) {
    const row = cells[i], col = cells.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, j, A) || matches(row, j, B)) score += 40;
      if (matches(col, j, A) || matches(col, j, B)) score += 40;
    }
  }

  const dark = cells.flat().filter((v) => v === 1).length;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// 15 bits: 2 for the level, 3 for the mask, 10 of BCH, then a fixed XOR so an
// all-zero format never reads as valid.
function formatBits(mask) {
  const data = (0b00 << 3) | mask;               // 00 is level M
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0b10100110111 << (i - 10);
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= 0b1111100100101 << (i - 12);
  return (version << 12) | rem;
}

function applyFormat(cells, size, mask, version) {
  const bits = formatBits(mask);
  const at = (i) => (bits >> i) & 1;
  /* Two copies, and they are not the same shape — which is the trap. The first
     runs UP column 8 and then LEFT along row 8, hugging the top-left finder;
     the second runs up column 8 from the bottom and along row 8 from the right.
     Writing the first copy along the row instead of the column produces a
     symbol that looks perfect — finders, timing, quiet zone all correct — and
     that no scanner will read, because the format block is where a decoder
     looks first to learn the mask and the error level. */
  for (let i = 0; i <= 5; i++) cells[i][8] = at(i);      // column 8, rows 0-5
  cells[7][8] = at(6);
  cells[8][8] = at(7);
  cells[8][7] = at(8);
  for (let i = 9; i <= 14; i++) cells[8][14 - i] = at(i); // row 8, columns 5-0
  for (let i = 0; i <= 7; i++) cells[size - 1 - i][8] = at(i);
  for (let i = 8; i <= 14; i++) cells[8][size - 15 + i] = at(i);
  cells[size - 8][8] = 1;                                 // the dark module, restated
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      cells[size - 11 + c][r] = bit;
      cells[r][size - 11 + c] = bit;
    }
  }
}

/**
 * Encode text as a QR symbol.
 * @returns {{size: number, modules: number[][], version: number}} 1 is dark.
 */
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), "utf8"));
  const version = pickVersion(bytes.length);
  const size = 17 + version * 4;
  const stream = interleave(codewords(bytes, version), version);
  const reserved = reservedMask(version, size);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = emptyMatrix(size);
    drawFunctionPatterns(m, version);
    placeData(m, stream, reserved);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && MASKS[mask](r, c)) m.cells[r][c] ^= 1;
      }
    }
    applyFormat(m.cells, size, mask, version);
    const score = penalty(m.cells);
    if (!best || score < best.score) best = { score, cells: m.cells };
  }
  return { size, version, modules: best.cells };
}

/** The symbol as an SVG, with the quiet zone the spec requires (4 modules). */
function toSvg(text, { scale = 8, quiet = 4, dark = "#16130f", light = "#ffffff" } = {}) {
  const { size, modules } = encode(text);
  const side = (size + quiet * 2) * scale;
  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) rects.push(`M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="${light}"/>` +
    `<path fill="${dark}" d="${rects.join("")}"/></svg>`;
}

module.exports = { encode, toSvg, pickVersion };
