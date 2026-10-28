// SpotLED hat (advertises as SpotLED_2986), protocol from `python-spotled`, checked
// against the real hat:
//   - 32 x 16 panel, frame limit 20, transfer buffer 120 bytes (asked on connect)
//   - frames are FULL COLOUR, one byte per pixel, RGB323: rrr gg bbb (bits 7-5, 4-3, 2-0)
//   - notifications start with the length byte (python-spotled's 3 leading bytes are
//     a Linux gattlib artefact, not part of the reply)
//
// The hat has no "play preset N" command: it shows whatever was last uploaded, so
// every look change uploads that look's frames.
// Close the SpotLED app before connecting: the hat accepts one connection at a time.
//
// The hat drops idle links a lot, so it's driven ON DEMAND: pick it once, then every
// upload connects, sends, and lets go ~8 s later. Drops between uploads don't matter;
// a drop mid-upload reconnects and retries.

import { RigDevice, Status } from './device.js';
import { lookPalette, tuneOf } from '../config.js';

const SERVICE = '0000ff20-0000-1000-8000-00805f9b34fb';
const CMD_CHAR = '0000ff21-0000-1000-8000-00805f9b34fb'; // control writes + notifications
const DATA_CHAR = '0000ff22-0000-1000-8000-00805f9b34fb'; // bulk payload

const SEND_DATA_TYPE = 32772;
const RESP = { SENDING: 2, FINISHED: 4, DISPLAY: 19, BUFFER: 21, CONTINUE: 255, PAUSE: 254 };
const RESPONSE_TIMEOUT_MS = 600;

export const EFFECTS = ['none', 'scroll up', 'scroll down', 'scroll left', 'scroll right', 'stack', 'expand', 'laser'];

// ---- byte helpers (big-endian, like python-spotled's ByteWriter) ----
class Bytes {
  constructor() { this.a = []; this.ck = 0; }
  byte(v) { this.a.push(v & 0xff); return this; }
  short(v) { return this.byte(v >> 8).byte(v); }
  int(v) { return this.short(v >>> 16).short(v); }
  bytes(arr) { for (const b of arr) this.byte(b); return this; }
  startChecksum() { this.ck = this.a.length; return this; }
  checksum() {
    let v = 0;
    for (let i = this.ck; i < this.a.length; i++) v += this.a[i];
    if (v > 255) v = ~v + 1;
    return this.byte(v);
  }
  get u8() { return new Uint8Array(this.a); }
}

/** Inner record: length, type, one-byte value, checksum. */
function byteRecord(type, value) {
  return new Bytes().startChecksum().int(8).short(type).byte(value).checksum().u8;
}

export const brightnessData = (pct) => byteRecord(14, Math.max(0, Math.min(100, pct)));
export const screenModeData = (mode) => byteRecord(15, mode); // 0 normal, 1 upside down, 2 mirror, 3 both

/** 8-bit sRGB -> one RGB323 byte, with gamma so mid tones don't wash out on the LEDs. */
const GAMMA = 2.2;
const lin = (v) => 255 * (v / 255) ** GAMMA;
export function rgb323([r, g, b]) {
  // Channels that carry the colour (>= 40% of its strongest channel) keep at least
  // level 1 when dimmed, so dim colours keep their hue: otherwise dim purple drops its
  // red and goes navy, and dim magenta drops its blue and goes red. Trace channels
  // (purple's bit of green) are left to round to 0, or everything turns green.
  const top = Math.max(r, g, b);
  const q = (v, bits) => {
    const lv = Math.min((1 << bits) - 1, Math.round(lin(v) / 255 * ((1 << bits) - 1)));
    return top > 14 && v >= top * 0.4 ? Math.max(1, lv) : lv;
  };
  return (q(r, 3) << 5) | (q(g, 2) << 3) | q(b, 3);
}
/** RGB323 byte -> approximate on-screen colour, for previews. */
export function fromRgb323(v) {
  const up = (x, bits) => Math.round(255 * (x / ((1 << bits) - 1)) ** (1 / GAMMA));
  return [up(v >> 5, 3), up((v >> 3) & 3, 2), up(v & 7, 3)];
}

/** AnimationData: frames = [{ px: Uint8Array(w*h) of RGB323 }], frame time ms, speed, effect. */
export function encodeAnimation(frames, w, h, { ms = 200, speed = 0, effect = 0 } = {}) {
  const b = new Bytes().startChecksum().int(9).short(11).short(frames.length).checksum();
  for (const f of frames) {
    const fr = new Bytes().startChecksum().int(f.px.length + 12).short(96).short(w).short(h).byte(1).bytes(f.px).checksum();
    b.bytes(fr.a);
  }
  b.bytes(new Bytes().startChecksum().int(10).short(7).byte(0).short(ms).checksum().a);  // TimeData
  b.bytes(new Bytes().startChecksum().int(8).short(9).byte(speed).checksum().a);         // SpeedData
  b.bytes(new Bytes().startChecksum().int(8).short(8).byte(effect).checksum().a);        // EffectData
  return b.u8;
}

/** 15-byte SendDataCommand header + content. */
function sendDataCommand(serial, content) {
  return new Bytes()
    .startChecksum().int(15).short(SEND_DATA_TYPE).int(serial).int(content.length).checksum()
    .bytes(content).u8;
}

/** Start (1) / finish (3) control packets, 10 bytes. */
function transferControl(kind, serial, length) {
  return new Bytes().byte(10).byte(kind).short(serial).short(SEND_DATA_TYPE).int(length).u8;
}

// ---------- pixel toolkit: Octlet sprite, 3x5 font, frame buffers ----------

// The STEAMWorkz Octlet logo at 16x16: gear body, eye, 8 circuit-trace legs.
// '#' body, 't' trace, '0'-'7' leg pads, 'o' eye white, '*' pupil.
const OCTLET = {
  rest: [
    '......2.........',
    '0..1...t........',
    '.t..t..t...3....',
    '..t..t.t..t.....',
    '...t.t.#tt......',
    '4tt.t.t###......',
    '...t.t#######...',
    '....t#5########.',
    '6tt.############',
    '...t..####oo####',
    '....t..##o**o###',
    '...t....#o**o###',
    '...7...###oo####',
    '.........######.',
    '..........###.#.',
    '................',
  ],
  left: [
    '......2.........',
    '0..1...t........',
    '.t..t..t...3....',
    '..t..t.t..t.....',
    '...t.t.#tt......',
    '4tt.t.t###......',
    '...t.t#######...',
    '....t#5########.',
    '6tt.############',
    '...t..####oo####',
    '....t..##**oo###',
    '...t....#**oo###',
    '...7...###oo####',
    '.........######.',
    '..........###.#.',
    '................',
  ],
  right: [
    '......2.........',
    '0..1...t........',
    '.t..t..t...3....',
    '..t..t.t..t.....',
    '...t.t.#tt......',
    '4tt.t.t###......',
    '...t.t#######...',
    '....t#5########.',
    '6tt.############',
    '...t..####oo####',
    '....t..##oo**###',
    '...t....#oo**###',
    '...7...###oo####',
    '.........######.',
    '..........###.#.',
    '................',
  ],
  angry: [
    '......2.........',
    '0..1...t........',
    '.t..t..t...3....',
    '..t..t.t..t.....',
    '...t.t.#tt......',
    '4tt.t.t###......',
    '...t.t#######...',
    '....t#5########.',
    '6tt.############',
    '...t..##########',
    '....t..###oo####',
    '...t....#o**o###',
    '...7...###**####',
    '.........######.',
    '..........###.#.',
    '................',
  ],
};

// 3x5 font: letters for the virus text, digits; the digital rain uses binary 1 / 0.
const FONT = {
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'], 3: ['###', '..#', '.##', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '###'],
  A: ['###', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['###', '#..', '#..', '#..', '###'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
  I: ['###', '.#.', '.#.', '.#.', '###'], L: ['#..', '#..', '#..', '#..', '###'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'], P: ['##.', '#.#', '##.', '#..', '#..'],
  M: ['#.#', '###', '###', '#.#', '#.#'], K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'], G: ['###', '#..', '#.#', '#.#', '###'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  J: ['..#', '..#', '..#', '#.#', '###'], Q: ['###', '#.#', '#.#', '###', '..#'],
  W: ['#.#', '#.#', '###', '###', '#.#'], Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'], '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '?': ['###', '..#', '.##', '...', '.#.'], '-': ['...', '...', '###', '...', '...'],
  ':': ['...', '.#.', '...', '.#.', '...'], "'": ['.#.', '.#.', '...', '...', '...'],
  ',': ['...', '...', '...', '.#.', '#..'], '>': ['#..', '.#.', '..#', '.#.', '#..'],
  '<': ['..#', '.#.', '#..', '.#.', '..#'],
  O: ['###', '#.#', '#.#', '#.#', '###'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['###', '#..', '###', '..#', '###'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'], '.': ['...', '...', '...', '...', '.#.'],
};
const RAIN_GLYPHS = [FONT[0], FONT[1]];

/** An RGB frame buffer the looks draw into; .frame() packs it to RGB323. */
function canvas(w, h, fill = BLACK) {
  const px = Array.from({ length: w * h }, () => fill);
  return {
    set(x, y, c) { if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = c; },
    get(x, y) { return px[y * w + x]; },
    frame() { const out = new Uint8Array(w * h); px.forEach((c, i) => { out[i] = rgbK(c); }); return { px: out }; },
    rowShift(y, dx) {                     // glitch: slide one row sideways
      const row = px.slice(y * w, y * w + w);
      for (let x = 0; x < w; x++) px[y * w + x] = row[((x - dx) % w + w) % w];
    },
  };
}

/** Octlet logo at (ox, oy), scaled to size px (16 native, 12, 8).
 *  pal: body, trace, pad, eye, pupil (+ padLit for lit pads). lit: pad indexes to light. */
function drawOctlet(cv, name, ox, oy, size, pal, lit = []) {
  const sp = OCTLET[name];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = sp[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)];
      if (c === '.') continue;
      const col = c === '#' ? pal.body : c === 't' ? pal.trace : c === 'o' ? pal.eye : c === '*' ? pal.pupil
        : lit.includes(Number(c)) ? pal.padLit : pal.pad;
      cv.set(ox + x, oy + y, col);
    }
  }
}

/** Text in the 3x5 font, 4 px per character. */
function drawText(cv, text, ox, oy, color) {
  [...text].forEach((ch, i) => {
    const g = FONT[ch];
    if (!g) return;
    g.forEach((row, y) => [...row].forEach((p, x) => { if (p === '#') cv.set(ox + i * 4 + x, oy + y, color); }));
  });
}

// ---------- rig looks, 32 x 16 colour ----------

const PURPLE = [160, 60, 255], MAG = [255, 43, 214], CYAN = [0, 229, 255];
const RED = [255, 30, 30], GREEN = [34, 255, 102], WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const BASE = { PURPLE, MAG, CYAN, RED, GREEN: [20, 255, 30], WHITE };   // matrix: pure green on this panel
const GHOST = [150, 160, 200], PUMPKIN = [255, 80, 0], CANDLE = [255, 190, 30];   // /boo, /pumpkin
// Heartbeat trace: offset from the baseline per column (negative = up), one beat per 32 px.
const ECG = Array.from({ length: 32 }, (_, x) => ({ 6: -1, 7: -1, 10: 1, 11: -6, 12: 3, 13: 1, 17: -2, 18: -2, 19: -1 })[x] ?? 0);
let KB = 1;                                    // brightness of the look being built (tuning)
const rgbK = (c) => rgb323(KB === 1 ? c : scale(c, KB));
const scale = (c, k) => c.map((v) => v * k);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function wheel(h) {
  h = ((h % 1) + 1) % 1 * 6;
  const i = Math.floor(h), f = h - i, q = 255 * (1 - f), u = 255 * f;
  return [[255, u, 0], [q, 255, 0], [0, 255, u], [0, q, 255], [u, 0, 255], [255, 0, q]][i % 6];
}
const rnd = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** -> { frames: [{px}], ms } for a rig look on a w x h hat, or null. */
/** -> { frames, ms } for a rig look, with the mode's tuning (colours + brightness). */
export function lookFrames(look, s, w = 32, h = 16) {
  KB = tuneOf(s, look.key).bright / 100;
  try { return lookFramesRaw(look, s, w, h); } finally { KB = 1; }
}

function lookFramesRaw(look, s, w, h) {
  const { PURPLE, MAG, CYAN, RED, GREEN, WHITE } = lookPalette(s, look.key, BASE);
  const HEAD = GREEN === BASE.GREEN ? [210, 255, 210] : GREEN.map((v) => Math.min(255, (v >> 1) + 128));
  const frame = (fn) => {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = rgbK(fn(x, y));
    return { px };
  };
  const r = rnd(4821);
  switch (look.key) {
    case 'D': { // the purple Octlet logo looking around, a signal pulse running through its pads
      const pal = { body: PURPLE, trace: scale(PURPLE, 0.75), pad: [200, 150, 255], padLit: WHITE,
        eye: [240, 240, 255], pupil: [40, 0, 90] };
      const look = ['rest', 'rest', 'left', 'left', 'rest', 'rest', 'right', 'right', 'rest', 'rest', 'rest', 'rest'];
      return { ms: 380, frames: look.map((name, f) => {
        const cv = canvas(w, h);
        for (let i = 0; i < 3; i++) cv.set(Math.floor(r() * w), Math.floor(r() * h), scale(PURPLE, 0.3));
        drawOctlet(cv, name, Math.round(w / 2 - 8), 0, 16, pal, [f % 8, (f + 4) % 8]);
        return cv.frame();
      }) };
    }
    case 'X': { // glitch: cyan static, magenta tear lines, bursts, a cutout
      const n = 12;
      return { ms: 90, frames: Array.from({ length: n }, (_, f) => {
        const burst = f === 3 || f === 4 || f === 9, cut = f === 7;
        // a short tear segment in about half the frames, somewhere random
        const tear = r() < 0.5 ? { y: Math.floor(r() * h), x0: Math.floor(r() * w * 0.7), len: 4 + Math.floor(r() * 12) } : null;
        return frame((x, y) => {
          if (cut) return BLACK;
          if (burst) return r() < 0.3 ? BLACK : r() < 0.5 ? MAG : CYAN;
          if (tear && y === tear.y && x >= tear.x0 && x < tear.x0 + tear.len) return r() < 0.8 ? MAG : WHITE;
          // sparse dark-blue static: dim cyan reads as green on this panel (2-bit green)
          return r() < 0.04 ? MAG : r() < 0.3 ? [0, 10, 70] : BLACK;
        });
      }) };
    }
    case 'r': { // rainfall: purple / magenta / cyan drops + one lightning bolt per loop
      // 20 frames (the hat's limit) so the strike comes round only every ~2.2 s.
      // The rain loops seamlessly: every drop moves a whole number of laps in n frames.
      const n = 20, lap = h + 4;
      const drops = Array.from({ length: 24 }, (_, i) => ({
        x: Math.floor(r() * w), y0: r() * lap, c: [PURPLE, MAG, CYAN][i % 3], v: lap / n * (1 + (i % 2)),
      }));
      const rain = (f, x, y) => {
        for (const d of drops) {
          if (d.x !== x) continue;
          const dy = ((d.y0 + f * d.v) % lap) - y;
          if (dy >= 0 && dy < 1) return d.c;
          if (dy >= 1 && dy < 2) return scale(d.c, 0.5);      // streak: the hat's dim levels
          if (dy >= 2 && dy < 3) return scale(d.c, 0.22);     // round to black below ~20%
        }
        return BLACK;
      };
      // Three blueish-white bolts per loop, one each in the left / middle / right third in a
      // shuffled order, at uneven gaps and different sizes, so the strikes read as random.
      // Math.random: every upload of the look rolls new places and shapes.
      const core = [190, 215, 255];                 // blueish white
      const glow = [40, 90, 255];                   // soft blue halo around the core
      const makeBolt = (zone, big) => {
        const pts = new Map();                      // "x,y" -> 2 core / 1 halo
        const mark = (x, y, v) => {
          if (x < 0 || x >= w || y < 0 || y >= h) return;
          const k = `${x},${y}`;
          pts.set(k, Math.max(pts.get(k) || 0, v));
        };
        const third = w / 3;
        let bx = Math.floor(zone * third + 2 + Math.random() * (third - 4));
        const reach = big ? h - 1 - Math.floor(Math.random() * 3) : 6 + Math.floor(Math.random() * 5);
        const fork = big ? 3 + Math.floor(Math.random() * 5) : -1;
        for (let y = 0; y <= reach; y++) {
          bx += Math.floor(Math.random() * 3) - 1;
          mark(bx, y, 2); mark(bx - 1, y, 1); mark(bx + 1, y, 1);
          if (y === fork) {                         // the big one branches off sideways
            let fx = bx;
            const dir = Math.random() < 0.5 ? -1 : 1;
            for (let fy = y + 1; fy < Math.min(h, y + 6); fy++) {
              fx += dir;
              mark(fx, fy, 2); mark(fx, fy - 1, 1);
            }
          }
        }
        return pts;
      };
      // How many strikes per loop is the HAT tab's LIGHTNING setting (0 off .. 3 storm).
      const count = Math.max(0, Math.min(3, s.hat?.lightning ?? 3));
      const at = [[], [9], [4, 13], [2, 9, 15]][count];
      const zones = [0, 1, 2].sort(() => Math.random() - 0.5);
      const bigOne = Math.floor(Math.random() * Math.max(1, count));
      const strikes = at.map((f, i) => ({ f, pts: makeBolt(zones[i], i === bigOne) }));
      const frames = Array.from({ length: n }, (_, f) => frame((x, y) => {
        const k = `${x},${y}`;
        for (const st of strikes) {
          const b = st.pts.get(k);
          if (!b) continue;
          if (f === st.f) return b === 2 ? core : glow;
          if (f === st.f + 1 && b === 2) return scale(glow, 0.45);   // quick fade
        }
        return rain(f, x, y);
      }));
      return { ms: 110, frames };
    }
    case 'M': { // the movie's digital rain: glyphs stay put, a bright head falls and lights them
      const n = 20, cols = Math.floor((w + 1) / 4);
      const glyph = () => RAIN_GLYPHS[Math.floor(r() * RAIN_GLYPHS.length)];
      const grid = Array.from({ length: cols }, () => Array.from({ length: 3 }, glyph));   // 3 glyph rows
      const heads = Array.from({ length: cols }, () => ({ y0: r() * 40, v: 1 + Math.floor(r() * 2) }));
      const frames = [];
      for (let f = 0; f < n; f++) {
        if (f) for (let i = 0; i < 5; i++) grid[Math.floor(r() * cols)][Math.floor(r() * 3)] = glyph();  // glyphs flip
        const cv = canvas(w, h);
        for (let c = 0; c < cols; c++) {
          const hd = (heads[c].y0 + f * heads[c].v * 2) % 40 - 8;        // loops: 20 frames x 2 px x v
          for (let gy = 0; gy < 3; gy++) {
            grid[c][gy].forEach((row, y) => [...row].forEach((p, x) => {
              if (p !== '#') return;
              const py = gy * 6 + y, d = hd - py;
              if (d >= 0 && d < 2) cv.set(c * 4 + x, py, HEAD);                          // white-green head
              else if (d >= 2 && d < 14) cv.set(c * 4 + x, py, scale(GREEN, 1 - (d - 2) / 14));
            }));
          }
        }
        frames.push(cv.frame());
      }
      return { ms: 90, frames };
    }
    case 'A': { // VU (no mic on the hat): bars bouncing from the bottom
      const n = 12;
      return { ms: 110, frames: Array.from({ length: n }, (_, f) => {
        const lvl = Array.from({ length: 8 }, (_, b) => Math.max(1, Math.round(h * (0.12 + 0.88 * Math.abs(Math.sin(f * 0.55 + b * 1.3)) ** 1.3 * (0.65 + 0.35 * r())))));
        return frame((x, y) => {
          const b = Math.floor(x / 4), row = h - 1 - y;
          if (x % 4 === 3 || row >= lvl[b]) return BLACK;
          return row < h * 0.6 ? [0, 255, 40] : row < h * 0.85 ? [255, 200, 0] : [255, 0, 0];
        });
      }) };
    }
    case 'R': { // rainbow wave; uses the rig's speed / width / direction
      const n = 12, rb = s.rainbow ?? { speed: 50, width: 30, dir: 1 };
      const span = Math.max(0.15, rb.width / 100), dir = rb.dir ? 1 : -1;
      return { ms: Math.round(120 * 50 / rb.speed), frames: Array.from({ length: n }, (_, f) =>
        frame((x, y) => wheel((x + y * 0.4) / w * span - dir * f / n))) };
    }
    case 'B': { // rebreather: breathe between the two colours
      const n = 10, [a, b] = s.pair;
      return { ms: 275, frames: Array.from({ length: n }, (_, f) => {
        // Cross-fade through a dark dip instead of blending: a straight mix of two
        // colours (magenta + cyan) passes through grey-green mud on this panel.
        const t = 0.5 - 0.5 * Math.cos(2 * Math.PI * f / n);       // 0 -> 1 -> 0
        const c = t < 0.5 ? a : b, k = Math.abs(2 * t - 1);
        // Shallow dip: below ~70% the hat's 2-bit green can't hold cyan (it turns green).
        return frame(() => scale(c, 0.7 + 0.3 * k));
      }) };
    }
    case 'H':
    case 'hack': { // the hacked Octlet.AI virus: glitching between corners at different sizes,
                   // with OCTLET .AI VIRUS .EXE flashing up around the display
      const pal = { body: RED, trace: scale(RED, 0.7), pad: MAG, padLit: WHITE, eye: [255, 200, 200], pupil: [90, 0, 0] };
      const poses = ['angry', 'angry', 'left', 'right'];
      const pick = (a) => a[Math.floor(Math.random() * a.length)];
      const spots = (size) => [[0, 0], [w - size, 0], [0, h - size], [w - size, h - size],
        [Math.round((w - size) / 2), Math.round((h - size) / 2)]];
      const words = ['OCTLET', '.AI', 'VIRUS', '.EXE'];
      // 20 frames: Octlet shots and the four words in order, with glitch between.
      const plan = ['o', 'o', 'w0', 'o', 'g', 'o', 'w1', 'o', 'o', 'w2', 'o', 'g', 'o', 'w3', 'o', 'o', 'n', 'o', 'g', 'o'];
      return { ms: 120, frames: plan.map((p) => {
        const cv = canvas(w, h);
        if (p === 'o' || p === 'g') {
          const size = pick([8, 12, 16]);
          const [x, y] = pick(spots(size));
          drawOctlet(cv, pick(poses), x, y, size, pal, [0, 1, 2, 3, 4, 5, 6, 7].filter(() => Math.random() < 0.4));
          if (p === 'g') {                                       // tear: rows slide sideways
            const y0 = Math.floor(Math.random() * (h - 4));
            for (let yy = y0; yy < y0 + 2 + Math.floor(Math.random() * 3); yy++) cv.rowShift(yy, (Math.random() < 0.5 ? -1 : 1) * (2 + Math.floor(Math.random() * 6)));
          }
        } else if (p[0] === 'w') {
          const word = words[Number(p[1])], tw = word.length * 4 - 1;
          const x = Math.floor(Math.random() * (w - tw + 1)), y = Math.floor(Math.random() * (h - 5 + 1));
          drawText(cv, word, x, y, Math.random() < 0.7 ? RED : MAG);
          // tear the top or bottom row only: the middle row carries the letter shapes
          if (Math.random() < 0.6) cv.rowShift(y + (Math.random() < 0.5 ? 0 : 4), 1 + Math.floor(Math.random() * 2));
        } else {                                                 // 'n': a burst of noise
          for (let i = 0; i < w * h * 0.25; i++) cv.set(Math.floor(Math.random() * w), Math.floor(Math.random() * h), pick([RED, MAG, WHITE]));
        }
        return cv.frame();
      }) };
    }
    case 'h': { // heartbeat: an ECG trace, written left to right with a bright head and
                // a dark gap just ahead of it, like a monitor redrawing
      const n = 16, base = Math.round(h * 0.6), trail = w - 6;
      return { ms: 70, frames: Array.from({ length: n }, (_, f) => {
        const cv = canvas(w, h), head = f * (w / n);
        for (let x = 0; x < w; x++) {
          const age = (head - x + w) % w;
          if (age > trail) continue;
          const c = age === 0 ? WHITE : scale(RED, Math.max(0.15, 1 - age / trail));
          const y0 = base + ECG[(x + w - 1) % w], y1 = base + ECG[x];
          for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) cv.set(x, y, c);
        }
        return cv.frame();
      }) };
    }
    case 'G': { // /boo: a ghost drifting side to side, BOO flashing up beside it
      const sprite = ['...####...', '.########.', '##########', '##..##..##', '##..##..##', '##########',
        '####..####', '####..####', '##########', '##########', '##########', '#.#.##.#.#'];
      const n = 8;                 // 8 frames: uploads in ~3 s
      return { ms: 260, frames: Array.from({ length: n }, (_, f) => {
        const cv = canvas(w, h);
        const gx = Math.round((w - 10) / 2 + 9 * Math.sin(2 * Math.PI * f / n)), gy = 2 + (f % 2);
        sprite.forEach((row, y) => [...row].forEach((p, x) => { if (p === '#') cv.set(gx + x, gy + y, GHOST); }));
        if (f % 4 >= 2) drawText(cv, 'BOO', gx < (w - 10) / 2 ? w - 12 : 1, 1, GHOST);
        return cv.frame();
      }) };
    }
    case 'J': { // /pumpkin: a jack-o'-lantern, its face flickering like a candle
      const cx = (w - 1) / 2, cy = 8.5;
      const eye = (x, y) => (y === 5 && x >= 11 && x <= 12) || (y === 6 && x >= 10 && x <= 13) || (y === 7 && x >= 9 && x <= 14);
      const isFace = (x, y) => eye(x, y) || eye(w - 1 - x, y) || (y === 8 && (x === 15 || x === 16))
        || (y === 10 && x >= 9 && x <= 22 && x !== 12 && x !== 19) || (y === 11 && x >= 10 && x <= 21 && x !== 15 && x !== 16);
      return { ms: 120, frames: Array.from({ length: 8 }, () => {
        const lit = r() < 0.75 ? CANDLE : [255, 120, 0];
        return frame((x, y) => {
          if (y <= 1 && (x === 15 || x === 16)) return [30, 150, 30];          // stem
          if (((x - cx) / 12) ** 2 + ((y - cy) / 7) ** 2 > 1) return BLACK;
          if (isFace(x, y)) return lit;
          return Math.abs(Math.abs(x - cx) - 5) < 0.6 ? [170, 50, 0] : PUMPKIN;  // ribs
        });
      }) };
    }
    case 'v': { // /vamp: a bat flapping past a blood moon
      const up = ['#.........#', '##.......##', '.###.#.###.', '..#######..', '....#.#....'];
      const down = ['....#.#....', '..#######..', '.###.#.###.', '##.......##', '#.........#'];
      const n = 8;
      return { ms: 200, frames: Array.from({ length: n }, (_, f) => {
        const cv = canvas(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - 22) ** 2 + (y - 7) ** 2 <= 40) cv.set(x, y, [150, 0, 10]);
        const bx = Math.round(f * (w - 11) / (n - 1)), by = 5 + (f % 2);
        (f % 2 ? down : up).forEach((row, y) => [...row].forEach((p, x) => { if (p === '#') cv.set(bx + x, by + y, [110, 0, 160]); }));
        return cv.frame();
      }) };
    }
    case 'k': { // /frank: the monster's face, sparks jumping off the neck bolts
      const GREEN_F = [60, 200, 50], BOLT = [120, 120, 120], ZAP = [255, 255, 120];
      return { ms: 150, frames: Array.from({ length: 6 }, (_, f) => {
        const zap = f === 2 || f === 4;
        return frame((x, y) => {
          if ((y === 11 || y === 12) && (x === 8 || x === 9 || x === 22 || x === 23)) return BOLT;
          if (zap && (y >= 8 && y <= 14) && (x === 6 || x === 25) && r() < 0.6) return ZAP;
          if (x < 10 || x > 21 || y < 3 || y > 14) return BLACK;
          if (y <= 4 || (y === 5 && x % 2)) return BLACK;                            // hair, jagged fringe
          if (y === 7 && (x === 12 || x === 13 || x === 18 || x === 19)) return BLACK; // eyes
          if (y === 11 && x >= 13 && x <= 18) return BLACK;                            // mouth
          if ((y === 10 || y === 12) && (x === 14 || x === 17)) return BLACK;          // stitches
          return GREEN_F;
        });
      }) };
    }
    case 'f': { // /fish: swimming across, bubbles rising
      const fish = ['..####...#', '.######.##', '#.#######.', '#########.', '.######.##', '..####...#'];
      const n = 8;
      return { ms: 180, frames: Array.from({ length: n }, (_, f) => {
        const cv = canvas(w, h);
        const fx = Math.round((w - 10) * (1 - f / (n - 1))), fy = 5 + (f % 2);
        fish.forEach((row, y) => [...row].forEach((p, x) => { if (p === '#') cv.set(fx + x, fy + y, [255, 140, 26]); }));
        for (const [bx, b0] of [[4, 0], [14, 5], [27, 10]]) cv.set(bx, h - 1 - ((b0 + f * 2) % h), [100, 180, 255]);
        return cv.frame();
      }) };
    }
    case 'P': { // sign off: OFFLINE, dim, flickering like a dying screen
      const tx = Math.round((w - 27) / 2), ty = Math.round((h - 5) / 2);
      const plan = [1, 1, 1, 0.6, 1, 1, 0, 1, 'tear', 1];
      return { ms: 220, frames: plan.map((p) => {
        const cv = canvas(w, h);
        if (p) drawText(cv, 'OFFLINE', tx, ty, scale(WHITE, 0.4 * (p === 'tear' ? 1 : p)));
        if (p === 'tear') cv.rowShift(ty + 2, 2);
        return cv.frame();
      }) };
    }
    default:
      return null;
  }
}

export class SpotLed extends RigDevice {
  constructor() {
    super({
      key: 'cap',
      label: 'Hat',
      filters: [{ namePrefix: 'SpotLED' }],
      optionalServices: [SERVICE],
    });
    this.cmdChar = null;
    this.dataChar = null;
    this.serial = 0;
    this.dataSerial = 0;
    this.chunk = 20;          // MTU 23 - 3; Web Bluetooth doesn't expose MTU
    this.info = { width: 32, height: 16, frameLimit: 20, bufferSize: 120 };
    this._waiter = null;
    this._queue = Promise.resolve();
    this._shown = null;
    this.busy = false;
    this._infoKnown = false;
    this._idleTimer = null;
  }

  /** Picked (Chrome remembers it): uploads will connect as needed. */
  get available() {
    return !!this.device;
  }

  /** Open the link if it isn't, for one upload. */
  async _ensure() {
    if (this.device.gatt.connected && this.cmdChar) return;
    this._setStatus(Status.CONNECTING);
    const server = await this.device.gatt.connect();
    await this.setup(server);
    this._setStatus(Status.CONNECTED, this.device.name);
  }

  /** Let the hat go a while after the last upload. */
  _scheduleIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this.busy && this.device?.gatt.connected) this.device.gatt.disconnect();
    }, 8000);
  }

  // A drop isn't an error here: just back to READY until the next upload.
  _handleDisconnect() {
    this.teardown();
    if (this.device) this._setStatus(Status.READY);
  }

  _scheduleRetry() {
    this._setStatus(this.device ? Status.READY : Status.IDLE);
  }

  async setup(server) {
    const svc = await server.getPrimaryService(SERVICE);
    this.cmdChar = await svc.getCharacteristic(CMD_CHAR);
    this.dataChar = await svc.getCharacteristic(DATA_CHAR);
    this.cmdChar.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e.target.value));
    await this.cmdChar.startNotifications();
    if (!this._infoKnown) {               // size / buffer only need asking once
      await this._query();
      this._infoKnown = true;
    }
  }

  teardown() {
    this.cmdChar = this.dataChar = null;
  }

  /** Ask the hat its size and buffer (python-spotled does the same on connect). */
  async _query() {
    for (const [id, want] of [[18, RESP.DISPLAY], [20, RESP.BUFFER]]) {
      const r = this._wait();
      await this.cmdChar.writeValueWithoutResponse(new Uint8Array([4, id, 0, 0]));
      const resp = await r.catch(() => null);
      if (!resp || resp.type !== want) continue;
      const c = resp.content;
      if (want === RESP.DISPLAY && c.length >= 11) {
        this.info.width = (c[3] << 8) | c[4];
        this.info.height = (c[5] << 8) | c[6];
        this.info.frameLimit = c[8] || 20;
      } else if (want === RESP.BUFFER && c.length >= 7) {
        this.info.bufferSize = ((c[3] << 24) | (c[4] << 16) | (c[5] << 8) | c[6]) >>> 0 || 120;
      }
    }
    this.dispatchEvent(new CustomEvent('info', { detail: this.info }));
  }

  _onNotify(view) {
    const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    if (b.length < 2) return;
    const content = b.slice(2, 2 + Math.max(0, b[0] - 2));
    const resp = { type: b[1], content };
    if (resp.type === RESP.SENDING) {
      resp.serial = (content[0] << 8) | content[1];
      resp.error = content[2];
    } else if (resp.type === RESP.CONTINUE) {
      resp.serial = (content[0] << 8) | content[1];
      resp.from = ((content[4] << 24) | (content[5] << 16) | (content[6] << 8) | content[7]) >>> 0;
    }
    if (this._waiter) { const w = this._waiter; this._waiter = null; w(resp); }
  }

  _wait() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._waiter = null; reject(new Error('spotled timeout')); }, RESPONSE_TIMEOUT_MS);
      this._waiter = (r) => { clearTimeout(t); resolve(r); };
    });
  }

  async _transfer(content, onProgress) {
    const serial = (this.serial = (this.serial + 1) & 0xffff);
    this.dataSerial = (this.dataSerial + 1) >>> 0;
    const payload = sendDataCommand(this.dataSerial, content);

    let ack = this._wait();
    await this.cmdChar.writeValueWithoutResponse(transferControl(1, serial, payload.length));
    const start = await ack;
    if (start.type !== RESP.SENDING || start.error) throw new Error('spotled start rejected');

    // A buffer's worth of 20-byte chunks, then the hat says where to continue from.
    const window = Math.max(1, Math.floor(this.info.bufferSize / this.chunk));
    let seek = 0;
    while (seek < payload.length) {
      ack = this._wait();
      let end = seek;
      for (let i = 0; i < window && end < payload.length; i++, end += this.chunk) {
        await this.dataChar.writeValueWithoutResponse(payload.slice(end, end + this.chunk));
      }
      const r = await ack.catch(() => ({ type: RESP.CONTINUE, from: end }));
      if (r.type === RESP.PAUSE) throw new Error('spotled paused');
      seek = r.type === RESP.CONTINUE && r.from > seek ? r.from : end;
      onProgress?.(Math.min(1, seek / payload.length));
    }

    ack = this._wait();
    await this.cmdChar.writeValueWithoutResponse(transferControl(3, serial, payload.length));
    await ack.catch(() => {});
  }

  /** Serialised. Each attempt (re)connects first, so a dropped link just retries. */
  send(content, { attempts = 3, onProgress } = {}) {
    this._queue = this._queue.then(async () => {
      if (!this.device) return;
      clearTimeout(this._idleTimer);
      this.busy = true;
      this.dispatchEvent(new CustomEvent('progress', { detail: 0 }));
      try {
        for (let i = 0; i < attempts; i++) {
          try {
            await this._ensure();
            return await this._transfer(content, (p) => {
              onProgress?.(p);
              this.dispatchEvent(new CustomEvent('progress', { detail: p }));
            });
          } catch (err) {
            console.warn('[hat] upload failed, retrying', i + 1, err);
            this._shown = null;
          }
        }
      } finally {
        this.busy = false;
        this.dispatchEvent(new CustomEvent('progress', { detail: 1 }));
        this._scheduleIdle();
      }
    });
    return this._queue;
  }

  setBrightness(pct) {
    return this.send(brightnessData(pct));
  }

  setScreenMode(mode) {
    return this.send(screenModeData(mode));
  }

  /** Upload frames ({px} RGB323, w*h each). Skips the upload if it's already showing. */
  async showFrames(frames, opts = {}, sig = null) {
    if (sig && sig === this._shown) return;
    this._shown = sig;
    const { width: w, height: h, frameLimit } = this.info;
    await this.send(encodeAnimation(frames.slice(0, frameLimit), w, h, opts));
  }

  clear() {
    const { width: w, height: h } = this.info;
    return this.showFrames([{ px: new Uint8Array(w * h) }], {}, 'off');
  }

  /** A title card, e.g. the slash command before its animation: the text centred,
   *  with a glitch tear now and then. Three frames, so it's up in about a second. */
  async showTitle(text, color) {
    const { width: w, height: h } = this.info;
    const tw = text.length * 4 - 1, x = Math.max(0, Math.round((w - tw) / 2)), y = Math.round((h - 5) / 2);
    const frames = [0, 1, 0].map((tear) => {
      const cv = canvas(w, h);
      drawText(cv, text, x, y, color);
      if (tear) cv.rowShift(y + 2, 2);
      return cv.frame();
    });
    await this.showFrames(frames, { ms: 250 }, JSON.stringify(['title', text, color]));
  }

  /** A message scrolling across: one frame wider than the hat, double-size letters,
   *  scrolled by the hat's own scroll-left effect (no 20-frame limit on length). */
  async showMessage(text, color) {
    const { height: h } = this.info;
    const fw = text.length * 8 + this.info.width;           // trailing gap before it loops
    const px = new Uint8Array(fw * h), c = rgb323(color), y0 = Math.round((h - 10) / 2);
    [...text].forEach((ch, i) => (FONT[ch] || []).forEach((row, y) => [...row].forEach((p, x) => {
      if (p !== '#') return;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) px[(y0 + y * 2 + dy) * fw + i * 8 + x * 2 + dx] = c;
    })));
    this._shown = JSON.stringify(['msg', text, color]);
    await this.send(encodeAnimation([{ px }], fw, h, { ms: 1000, effect: EFFECTS.indexOf('scroll left') }));
  }

  /** Follow the rig: the look's animation at the hat's brightness. */
  async applyState(s) {
    if (!s.look.on) return this.clear();
    const { width: w, height: h } = this.info;
    const anim = lookFrames(s.look, s, w, h);
    if (!anim) return;
    const k = s.look.key;
    const sig = JSON.stringify(['look', k, k === 'B' ? s.pair : 0, k === 'R' ? s.rainbow : 0, k === 'r' ? s.hat?.lightning : 0,
      s.tunes?.[k === 'hack' ? 'H' : k] ?? 0]);
    await this.showFrames(anim.frames, { ms: anim.ms }, sig);
  }
}
