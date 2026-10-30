// LilyGO T5 4.7" e-ink badge (ESP32, firmware/BADGE). The badge never draws anything
// itself: the BADGE tab makes the finished 16-grey frame and this sends it.
//
// Screen slots, kept on the badge: 0 login QR, 1 STEAMWorkz card, 2-5 the last four
// guest portraits (send to SLOT.GUEST and the badge picks the oldest one to replace),
// 6 an invite (stays up until we show something else), 7 HIGH SCORES.
//
// One custom service, two characteristics:
//   RX  (we write, with response, <= 500 bytes each)
//       'B' u32 length u8 slot u8 flags  a frame is coming: `length` bytes of PackBits
//                               data; flags 1 = quiet (keep it, don't show it)
//       'D' data...             the next piece of it
//       'E'                     that's all: unpack, keep it in its slot, show it
//       'S' u8 slot             show a stored slot
//       'M' u8 mode u16 hold    0 worn (portraits for `hold` s, then login) / 1 table
//                               (slideshow, `hold` s a slide)
//       'C'                     clear to white
//       '?'                     report
//   TX  (badge notifies, text)  READY | OK | ERR <why> |
//                               INFO <w> <h> <battery mV> <slots bitmask> <mode> <hold> <showing>
//
// Frame: the panel's own 960 x 540 landscape layout, 4 bits a pixel (0 black, 15 white),
// 2 pixels a byte, the left pixel in the low nibble: 259 200 bytes before PackBits.

import { RigDevice } from './device.js';

export const BADGE_SERVICE = '7a1e0001-5d2c-4e8b-9c1f-3b6a8d0e4f21';
const BADGE_RX = '7a1e0002-5d2c-4e8b-9c1f-3b6a8d0e4f21';
const BADGE_TX = '7a1e0003-5d2c-4e8b-9c1f-3b6a8d0e4f21';
export const BADGE_NAME_PREFIX = 'RIG-BADGE';
export const PANEL = { w: 960, h: 540 };       // native; the badge is worn portrait
export const SLOT = { LOGIN: 0, CARD: 1, INVITE: 6, SCORES: 7, GUEST: 255 };
const CHUNK = 500;                              // long writes: Chrome splits to the MTU

const dec = new TextDecoder();

/** PackBits: n 0..127 = n+1 literal bytes follow; n 129..255 = repeat next byte 257-n times. */
export function packBits(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && run < 128 && src[i + run] === src[i]) run++;
    if (run >= 3) {
      out.push(257 - run, src[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < src.length && i - start < 128) {
      if (i + 2 < src.length && src[i] === src[i + 1] && src[i] === src[i + 2]) break;
      i++;
    }
    out.push(i - start - 1);
    for (let j = start; j < i; j++) out.push(src[j]);
  }
  return Uint8Array.from(out);
}

export class Badge extends RigDevice {
  constructor() {
    super({
      key: 'badge',
      label: 'Badge',
      filters: [{ namePrefix: BADGE_NAME_PREFIX }],
      optionalServices: [BADGE_SERVICE],
    });
    this.rx = null;
    this.info = null;
    this._waiters = [];
    this.busy = false;
  }

  async setup(server) {
    const svc = await server.getPrimaryService(BADGE_SERVICE);
    this.rx = await svc.getCharacteristic(BADGE_RX);
    const tx = await svc.getCharacteristic(BADGE_TX);
    tx.addEventListener('characteristicvaluechanged', (e) => this._onLine(dec.decode(e.target.value).trim()));
    await tx.startNotifications();
    this._write(Uint8Array.of(0x3f));            // '?': battery etc.
  }

  teardown() {
    this.rx = null;
    for (const w of this._waiters.splice(0)) w.reject(new Error('badge disconnected'));
  }

  _onLine(line) {
    const [k, ...w] = line.split(/\s+/);
    if (k === 'INFO') {
      this.info = { w: +w[0], h: +w[1], mv: +w[2], slots: +w[3] || 0, mode: +w[4] || 0, hold: +w[5] || 0, showing: +(w[6] ?? -1) };
      this.dispatchEvent(new CustomEvent('info', { detail: this.info }));
      return;
    }
    const waiter = this._waiters.shift();
    if (!waiter) return;
    if (k === 'ERR') waiter.reject(new Error(w.join(' ') || 'badge error'));
    else waiter.resolve(k);
  }

  _reply(ms) {
    const p = new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this._waiters.push(w);
      setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) { this._waiters.splice(i, 1); reject(new Error('badge did not answer')); }
      }, ms);
    });
    p.catch(() => {});        // a write that failed first already threw; no stray rejection
    return p;
  }

  _write(bytes) {
    return this.rx.writeValueWithResponse ? this.rx.writeValueWithResponse(bytes) : this.rx.writeValue(bytes);
  }

  /** Send a packed 960x540 4-bit frame (Uint8Array, 259 200 bytes) into a slot; it shows
   *  straight away. Progress 0..1 as events. */
  async sendFrame(frame, slot = SLOT.LOGIN, { quiet = false } = {}) {
    if (!this.rx) throw new Error('Badge not connected');
    if (this.busy) throw new Error('Badge is still busy');
    this.busy = true;
    const progress = (v) => this.dispatchEvent(new CustomEvent('progress', { detail: v }));
    try {
      const data = packBits(frame);
      const head = new Uint8Array(7);
      head[0] = 0x42;                                         // 'B'
      new DataView(head.buffer).setUint32(1, data.length, true);
      head[5] = slot;
      head[6] = quiet ? 1 : 0;
      const ready = this._reply(5000);
      await this._write(head);
      await ready;
      progress(0);
      for (let i = 0; i < data.length; i += CHUNK) {
        const piece = new Uint8Array(1 + Math.min(CHUNK, data.length - i));
        piece[0] = 0x44;                                      // 'D'
        piece.set(data.subarray(i, i + CHUNK), 1);
        await this._write(piece);
        progress(Math.min(1, (i + CHUNK) / data.length));
      }
      const done = this._reply(20000);                         // unpack + a full refresh
      await this._write(Uint8Array.of(0x45));                 // 'E'
      await done;
      progress(1);
      this._write(Uint8Array.of(0x3f));                       // '?': which slots it has now
      return data.length;
    } finally {
      this.busy = false;
    }
  }

  /** Show a stored slot (instant: no transfer). */
  async show(slot) {
    if (!this.rx || this.busy) return;
    const done = this._reply(15000);
    await this._write(Uint8Array.of(0x53, slot));            // 'S'
    await done;
    this._write(Uint8Array.of(0x3f));
  }

  /** WORN (0) or TABLE (1), and how long a portrait / slide stays, in seconds. */
  async setMode(mode, hold) {
    if (!this.rx || this.busy) return;
    const done = this._reply(5000);
    await this._write(Uint8Array.of(0x4d, mode ? 1 : 0, hold & 0xff, hold >> 8));   // 'M'
    await done;
  }

  async clear() {
    if (!this.rx || this.busy) return;
    const done = this._reply(15000);
    await this._write(Uint8Array.of(0x43));                   // 'C'
    await done;
  }
}
