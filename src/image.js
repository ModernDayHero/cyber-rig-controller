// Image upload helpers shared by the BOLT and hat tabs.
// decodeImage(): PNG / JPEG / WebP / GIF (animated GIFs frame by frame via ImageDecoder).
// toBolt():      8x8, up to 16 colours -> BOLT animation {palette, frames, fps, fade}.
// toMono():      W x H, 1 bit per pixel -> hat frames (on/off grids).

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

/** Draw a frame into a w x h canvas. fit: 'cover' | 'contain' | 'stretch'. -> ImageData */
export function rasterise(image, w, h, fit = 'contain', smooth = true) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = smooth;
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
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
