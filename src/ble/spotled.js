// SpotLED cap (advertises as SpotLED_2986), ported from `python-spotled`.
//
// STATUS: transport skeleton, UNTESTED on hardware.
//   Done:    UUIDs, SendData framing, start/chunk/continue/finish transfer, brightness.
//   TODO:    frame/animation encoding (AnimationData type 11 + FrameData type 96,
//            Time 7 / Speed 9 / Effect 8). See encodeAnimation() below.
//
// Important: the hat has no "play preloaded animation N" command. It shows whatever
// was last uploaded, so every mode change uploads that mode's animation frames.
//
// Close the SpotLED app before connecting: the hat accepts one connection at a time.

import { RigDevice } from './device.js';

const SERVICE  = '0000ff20-0000-1000-8000-00805f9b34fb';
const CMD_CHAR = '0000ff21-0000-1000-8000-00805f9b34fb'; // control writes + notifications
const DATA_CHAR = '0000ff22-0000-1000-8000-00805f9b34fb'; // bulk payload

const SEND_DATA_TYPE = 32772;
const RESP_SENDING = 2, RESP_CONTINUE = 255, RESP_PAUSE = 254;
const RESPONSE_TIMEOUT_MS = 400;

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
export const screenModeData = (mode) => byteRecord(15, mode);

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

/**
 * TODO: build AnimationData for a mode. Expected shape (from python-spotled):
 *   short 11, short frameCount, FrameData[] (type 96: width, height, colour depth, bitmap),
 *   then TimeData (7), SpeedData (9), EffectData (8).
 * Port gen_color_bitmap for the RGB frames. Returns null until implemented.
 */
export function encodeAnimation(_modeId, _hunt) {
  return null;
}

export class SpotLed extends RigDevice {
  constructor() {
    super({
      key: 'cap',
      label: 'Cap',
      filters: [{ namePrefix: 'SpotLED' }],
      optionalServices: [SERVICE],
    });
    this.cmdChar = null;
    this.dataChar = null;
    this.serial = 0;
    this.chunk = 20;        // MTU 23 - 3; Web Bluetooth doesn't expose MTU
    this.bufferSize = 200;  // guess until GetBufferSize is wired up
    this._waiter = null;
    this._queue = Promise.resolve();
  }

  async setup(server) {
    const svc = await server.getPrimaryService(SERVICE);
    this.cmdChar = await svc.getCharacteristic(CMD_CHAR);
    this.dataChar = await svc.getCharacteristic(DATA_CHAR);
    this.cmdChar.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e.target.value));
    // python-spotled also writes 00 00 00 01 to handle 0x0f; check whether this hat needs that.
    await this.cmdChar.startNotifications();
  }

  teardown() {
    this.cmdChar = this.dataChar = null;
  }

  _onNotify(view) {
    const b = new Uint8Array(view.buffer);
    if (b.length < 5) return;
    const type = b[4]; // skip 3 bytes, length byte, then type
    const p = 5;
    let resp = { type };
    if (type === RESP_SENDING) {
      resp.serial = (b[p] << 8) | b[p + 1];
      resp.error = b[p + 2];
    } else if (type === RESP_CONTINUE) {
      resp.serial = (b[p] << 8) | b[p + 1];
      resp.from = ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
    }
    if (this._waiter) { const w = this._waiter; this._waiter = null; w(resp); }
  }

  _wait() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._waiter = null; reject(new Error('spotled timeout')); }, RESPONSE_TIMEOUT_MS);
      this._waiter = (r) => { clearTimeout(t); resolve(r); };
    });
  }

  async _transfer(content) {
    const serial = (this.serial = (this.serial + 1) & 0xffff);
    const payload = sendDataCommand(serial, content);

    let ack = this._wait();
    await this.cmdChar.writeValue(transferControl(1, serial, payload.length));
    const start = await ack;
    if (start.type !== RESP_SENDING || start.error) throw new Error('spotled start rejected');

    // Write a window of chunks, then wait for the hat's "continue from" offset.
    // TODO: read the real buffer size with GetBufferSizeCommand (id 20, response 21).
    const window = Math.max(1, Math.floor(this.bufferSize / this.chunk));
    let seek = 0;
    while (seek < payload.length) {
      ack = this._wait();
      let end = seek;
      for (let i = 0; i < window && end < payload.length; i++, end += this.chunk) {
        await this.dataChar.writeValueWithoutResponse(payload.slice(end, end + this.chunk));
      }
      const r = await ack.catch(() => ({ type: RESP_CONTINUE, from: end }));
      if (r.type === RESP_PAUSE) throw new Error('spotled paused (MTU?)');
      seek = r.type === RESP_CONTINUE && r.from > seek ? r.from : end;
    }

    ack = this._wait();
    await this.cmdChar.writeValue(transferControl(3, serial, payload.length));
    await ack.catch(() => {});
  }

  /** Serialised, with retries like python-spotled's send_data. */
  send(content, attempts = 3) {
    this._queue = this._queue.then(async () => {
      for (let i = 0; i < attempts; i++) {
        try { return await this._transfer(content); }
        catch (err) { console.warn('[cap] transfer failed', i + 1, err); }
      }
    });
    return this._queue;
  }

  async applyState(s) {
    await this.send(brightnessData(s.power === 2 ? s.brightness : 0));
    const anim = encodeAnimation(s.mode, s.hunt);
    if (anim) await this.send(anim);
  }
}
