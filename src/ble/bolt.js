// Sphero BOLT over the Sphero v2 BLE API, ported from the `spherov2` Python library.
// Worn in the carrier: LED commands only, never drive.
//
// VERIFY ON HARDWARE: UUIDs, the unlock string and the command IDs below are taken
// from spherov2 and are not yet tested against this BOLT.
//
// v1 look: solid mode colour on the 8x8 matrix, scaled by brightness.
// Animated looks (breathing, scan line, rain) are an open item.

import { RigDevice } from './device.js';
import { MODES } from '../config.js';

const API_SERVICE   = '00010001-574f-4f20-5370-6865726f2121';
const API_CHAR      = '00010002-574f-4f20-5370-6865726f2121';
const ANTIDOS_SERVICE = '00020001-574f-4f20-5370-6865726f2121';
const ANTIDOS_CHAR  = '00020005-574f-4f20-5370-6865726f2121';
const UNLOCK = 'usetheforce...band';

// Processor targets on the BOLT
const NORDIC = 0x11;
const ST = 0x12;

// Device IDs / command IDs
const POWER = 0x13, POWER_WAKE = 0x0d;
const IO = 0x1a, IO_MATRIX_ONE_COLOR = 0x2f;

const FLAG_REQ_RESPONSE = 0x02, FLAG_ACTIVITY = 0x08, FLAG_HAS_TARGET = 0x10;
const SOP = 0x8d, EOP = 0xd8, ESC = 0xab;

const KEEPALIVE_MS = 30_000;

let seq = 0;

/** Build an escaped Sphero v2 packet. */
export function spheroPacket(target, did, cid, data = []) {
  const flags = FLAG_REQ_RESPONSE | FLAG_ACTIVITY | FLAG_HAS_TARGET;
  seq = (seq + 1) & 0xff;
  const body = [flags, target, did, cid, seq, ...data];
  const chk = 0xff - (body.reduce((a, b) => a + b, 0) & 0xff);
  const out = [SOP];
  for (const b of [...body, chk]) {
    if (b === SOP || b === EOP || b === ESC) out.push(ESC, b & ~0x88);
    else out.push(b);
  }
  out.push(EOP);
  return new Uint8Array(out);
}

export class Bolt extends RigDevice {
  constructor() {
    super({
      key: 'bolt',
      label: 'BOLT',
      filters: [{ namePrefix: 'SB-' }],
      optionalServices: [API_SERVICE, ANTIDOS_SERVICE],
    });
    this.api = null;
    this._queue = Promise.resolve();
    this._keepAlive = null;
  }

  async setup(server) {
    const anti = await server.getPrimaryService(ANTIDOS_SERVICE);
    const antiChar = await anti.getCharacteristic(ANTIDOS_CHAR);
    await antiChar.writeValue(new TextEncoder().encode(UNLOCK));

    const svc = await server.getPrimaryService(API_SERVICE);
    this.api = await svc.getCharacteristic(API_CHAR);
    await this.api.startNotifications(); // responses arrive here; ignored for now

    await this._send(spheroPacket(NORDIC, POWER, POWER_WAKE));
    clearInterval(this._keepAlive);
    this._keepAlive = setInterval(
      () => this._send(spheroPacket(NORDIC, POWER, POWER_WAKE)),
      KEEPALIVE_MS,
    );
  }

  teardown() {
    clearInterval(this._keepAlive);
    this.api = null;
  }

  _send(packet) {
    if (!this.api) return Promise.resolve();
    this._queue = this._queue
      .then(() => this.api.writeValueWithResponse(packet))
      .catch((err) => console.warn('[bolt] write failed', err));
    return this._queue;
  }

  setMatrixColor([r, g, b]) {
    return this._send(spheroPacket(ST, IO, IO_MATRIX_ONE_COLOR, [r, g, b]));
  }

  async applyState(s) {
    if (s.power !== 2) return this.setMatrixColor([0, 0, 0]);
    const mode = MODES[s.mode];
    const k = s.brightness / 100;
    await this.setMatrixColor(mode.rgb.map((c) => Math.round(c * k)));
  }
}
