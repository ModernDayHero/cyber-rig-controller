// Image upload helpers shared by the BOLT and hat tabs.
// decodeImage(): PNG / JPEG / WebP / GIF (animated GIFs frame by frame via ImageDecoder).
// toBolt():      8x8, up to 16 colours -> BOLT animation {palette, frames, fps, fade}.
// toMono():      W x H, 1 bit per pixel -> hat frames (on/off grids).
// toPic():       16x16, up to 15 colours -> a library picture's art (IMAGE tab uploads).
// badgeCrop() / toGrey16() / packBadge(): the e-ink badge, 540x960 portrait, 16 greys.

/** -> [{ image: ImageBitmap|VideoFrame, ms }] (at most maxFrames). */
export async function decodeImage(file, maxFrames = 20) {
  if (file.type === 'image/gif' && 'ImageDecoder' in window) {
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type });
    await dec.tracks.ready;
    const count = Math.min(dec.tracks.selectedTrack.frameCount, maxFrames);
    const frames = [];
    for (let i = 0; i < count; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      frames.push({ image, ms: Math.max(20, (image.duration ?? 100000) / 1000) });
    }
    return frames;
  }
  return [{ image: await createImageBitmap(file), ms: 1000 }];
}

/** Draw a frame into a w x h canvas. fit: 'cover' | 'contain' | 'stretch'. -> ImageData
 *  (on black, or left transparent with clear). */
export function rasterise(image, w, h, fit = 'contain', smooth = true, clear = false) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000';
  if (!clear) g.fillRect(0, 0, w, h);
  const iw = image.displayWidth ?? image.width, ih = image.displayHeight ?? image.height;
  let dw = w, dh = h;
  if (fit !== 'stretch') {
    const k = fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    dw = iw * k; dh = ih * k;
  }
  g.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return g.getImageData(0, 0, w, h);
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Frames -> BOLT animation. One shared palette of <= 16 colours across all frames. */
export function toBolt(frames, fit = 'contain') {
  const px = frames.map((f) => rasterise(f.image, 8, 8, fit).data);
  // Count colours (rounded to 5 bits/channel so near-identical shades merge).
  const counts = new Map();
  for (const d of px) {
    for (let i = 0; i < d.length; i += 4) {
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const palette = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([k]) => [((k >> 10) & 31) << 3, ((k >> 5) & 31) << 3, (k & 31) << 3]);
  const grids = px.map((d) =>
    Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => {
      const i = (y * 8 + x) * 4, c = [d[i], d[i + 1], d[i + 2]];
      let best = 0, bd = Infinity;
      palette.forEach((p, j) => { const dd = dist2(c, p); if (dd < bd) { bd = dd; best = j; } });
      return best;
    })));
  const avgMs = frames.reduce((a, f) => a + f.ms, 0) / frames.length;
  return { palette, frames: grids, fps: Math.max(1, Math.min(30, Math.round(1000 / avgMs))), fade: false };
}

/** Median cut: split the box with the widest channel range at its median until there
 *  are n boxes; each box's average is a palette colour. colours: [[r,g,b]] */
function medianCut(colours, n) {
  let boxes = [colours];
  while (boxes.length < n) {
    let best = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const c of b) { lo = Math.min(lo, c[ch]); hi = Math.max(hi, c[ch]); }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = i; bestCh = ch; }
      }
    });
    if (best < 0) break;                     // every box is one colour: done early
    const b = boxes[best].sort((p, q) => p[bestCh] - q[bestCh]), mid = b.length >> 1;
    boxes.splice(best, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.map((b) => [0, 1, 2].map((ch) => Math.round(b.reduce((a, c) => a + c[ch], 0) / b.length)));
}

const PIC_CHARS = 'abcdefghijklmno';
const hex2 = (v) => v.toString(16).padStart(2, '0');

/** An image -> a library picture's art: 16x16, see-through pixels are the background
 *  ('.'), the rest up to 15 colours. Pixel art drawn at a multiple of 16 stays crisp.
 *  -> { pal: {char: '#rrggbb'}, art: [16 strings], rgb (its main colour) } */
export function toPic(image, fit = 'contain') {
  const iw = image.displayWidth ?? image.width, ih = image.displayHeight ?? image.height;
  const crisp = iw % 16 === 0 && ih % 16 === 0;
  const d = rasterise(image, 16, 16, fit, !crisp, true).data;
  const solid = [];
  for (let i = 0; i < 256; i++) if (d[i * 4 + 3] >= 128) solid.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  const palette = solid.length ? medianCut(solid.map((c) => [...c]), 15) : [];
  const counts = palette.map(() => 0);
  const art = Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => {
    const i = (y * 16 + x) * 4;
    if (d[i + 3] < 128) return '.';
    const c = [d[i], d[i + 1], d[i + 2]];
    let best = 0, bd = Infinity;
    palette.forEach((p, j) => { const dd = dist2(c, p); if (dd < bd) { bd = dd; best = j; } });
    counts[best]++;
    return PIC_CHARS[best];
  }).join(''));
  const pal = Object.fromEntries(palette.map((p, j) => [PIC_CHARS[j], '#' + p.map(hex2).join('')]));
  // Title colour: the most used colour that isn't too dark to read.
  const bright = (p) => Math.max(...p) > 90;
  const order = palette.map((p, j) => j).sort((a, b) => counts[b] - counts[a]);
  const main = palette[order.find((j) => bright(palette[j])) ?? order[0]] ?? [0, 229, 255];
  return { pal, art, rgb: main };
}

/** Frames -> 1-bit grids for the hat. Threshold 0-255 on luminance, optional
 *  Floyd-Steinberg dithering and invert. -> [{ grid: [[0|1]], ms }] */
export function toMono(frames, w, h, { fit = 'contain', threshold = 128, dither = false, invert = false } = {}) {
  return frames.map((f) => {
    const d = rasterise(f.image, w, h, fit).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const grid = Array.from({ length: h }, () => new Array(w).fill(0));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, old = lum[i], on = old >= threshold ? 1 : 0;
        grid[y][x] = on ^ (invert ? 1 : 0);
        if (dither) {
          const err = old - (on ? 255 : 0);
          if (x + 1 < w) lum[i + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) lum[i + w - 1] += err * 3 / 16;
            lum[i + w] += err * 5 / 16;
            if (x + 1 < w) lum[i + w + 1] += err / 16;
          }
        }
      }
    }
    return { grid, ms: f.ms };
  });
}

/** Paint a palette-index grid (or 0/1 grid with on/off colours) into a <canvas>, scaled up. */
export function paintPreview(canvas, grid, colorOf) {
  const h = grid.length, w = grid[0].length;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, gg, b] = colorOf(grid[y][x]);
      const i = (y * w + x) * 4;
      img.data.set([r, gg, b, 255], i);
    }
  }
  g.putImageData(img, 0, 0);
}

/** Frames -> full-colour hat frames: w x h, one RGB323 byte per pixel (see spotled.js).
 *  dither: Floyd-Steinberg on the quantisation error, smoother gradients. -> [{ px, ms }] */
export function toHat(frames, w, h, { fit = 'contain', dither = false, rgb323, fromRgb323 } = {}) {
  return frames.map((f) => {
    const d = rasterise(f.image, w, h, fit).data;
    const buf = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) buf[i * 3 + c] = d[i * 4 + c];
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const want = [0, 1, 2].map((c) => Math.max(0, Math.min(255, buf[i * 3 + c])));
        const v = rgb323(want);
        px[i] = v;
        if (!dither) continue;
        const got = fromRgb323(v);
        for (let c = 0; c < 3; c++) {
          const err = want[c] - got[c];
          if (x + 1 < w) buf[(i + 1) * 3 + c] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) buf[(i + w - 1) * 3 + c] += err * 3 / 16;
            buf[(i + w) * 3 + c] += err * 5 / 16;
            if (x + 1 < w) buf[(i + w + 1) * 3 + c] += err / 16;
          }
        }
      }
    }
    return { px, ms: f.ms };
  });
}

/** Paint RGB323 pixels (hat frame) into a canvas at native size; CSS scales it up. */
export function paintHat(canvas, px, w, h, fromRgb323) {
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) img.data.set([...fromRgb323(px[i]), 255], i * 4);
  g.putImageData(img, 0, 0);
}

// ---------- e-ink badge (LilyGO T5 4.7", worn portrait) ----------
export const BADGE = { w: 540, h: 960 };          // portrait, as worn

/** Draw an image cover-fitted into the badge, zoomed (1 = fill) and panned (-1..1). */
export function badgeCrop(g, image, { zoom = 1, panX = 0, panY = 0 } = {}) {
  const { w, h } = BADGE;
  const iw = image.displayWidth ?? image.width, ih = image.displayHeight ?? image.height;
  const k = Math.max(w / iw, h / ih) * zoom, dw = iw * k, dh = ih * k;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, (w - dw) / 2 * (1 + panX), (h - dh) / 2 * (1 + panY), dw, dh);
}

/** RGBA ImageData (540x960) -> grey levels 0..15 (0 black), with contrast / brightness
 *  and optional Floyd-Steinberg dithering. -> Uint8Array(w*h) */
export function toGrey16(img, { contrast = 1, brightness = 0, dither = true } = {}) {
  const { width: w, height: h, data: d } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    lum[i] = (v - 128) * contrast + 128 + brightness;
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, old = Math.max(0, Math.min(255, lum[i]));
      const q = Math.round(old / 17);
      out[i] = q;
      if (!dither) continue;
      const err = old - q * 17;
      if (x + 1 < w) lum[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) lum[i + w - 1] += err * 3 / 16;
        lum[i + w] += err * 5 / 16;
        if (x + 1 < w) lum[i + w + 1] += err / 16;
      }
    }
  }
  return out;
}

/** Portrait grey levels -> the panel's own 960x540 layout, 2 pixels a byte (left pixel
 *  in the low nibble). turn: 'cw' or 'ccw', whichever way up the badge hangs. */
export function packBadge(grey, turn = 'cw') {
  const { w, h } = BADGE, nw = h, nh = w;          // native 960 x 540
  const out = new Uint8Array(nw * nh / 2);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const nx = turn === 'cw' ? py : nw - 1 - py;
      const ny = turn === 'cw' ? nh - 1 - px : px;
      const v = grey[py * w + px], j = ny * nw + nx, b = j >> 1;
      out[b] |= j & 1 ? v << 4 : v;
    }
  }
  return out;
}

/** Grey levels -> a canvas preview (how the badge will look). */
export function paintGrey(canvas, grey) {
  const { w, h } = BADGE;
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = grey[i] * 17;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
