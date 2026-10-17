// Adafruit CLUE over Nordic UART Service. In the Pro tier the CLUE is the
// phone's link to the mask: it relays every line to both Bluefruits.
//
// Phone -> CLUE: lines from config.js `cmd` (M, B, H, S, T, P), newline-terminated.
// CLUE -> phone (notify), PROPOSED — firmware must match:
//   M<n>         mode picked on the watch
//   L0 / L1      left Bluefruit link down / up
//   R0 / R1      right Bluefruit link down / up

import { RigDevice } from './device.js';
import { cmd } from '../config.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we write here
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // CLUE notifies here

// CLUE firmware should advertise with this name prefix (set in code.py).
export const CLUE_NAME_PREFIX = 'RIG-CLUE';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Clue extends RigDevice {
  constructor() {
    super({
      key: 'clue',
      label: 'CLUE',
      filters: [{ namePrefix: CLUE_NAME_PREFIX }],
      optionalServices: [NUS_SERVICE],
    });
    this.rx = null;
    this.tx = null;
    this._queue = Promise.resolve();
    this._buf = '';
    this.mask = { L: false, R: false };
  }

  async setup(server) {
    const svc = await server.getPrimaryService(NUS_SERVICE);
    this.rx = await svc.getCharacteristic(NUS_RX);
    this.tx = await svc.getCharacteristic(NUS_TX);
    this.tx.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
    await this.tx.startNotifications();
  }

  teardown() {
    this.rx = this.tx = null;
    this._setMask('L', false);
    this._setMask('R', false);
  }

  /** Queue one line. GATT allows one operation at a time, so writes are serialised. */
  send(line) {
    if (!this.rx) return Promise.resolve();
    const bytes = enc.encode(line + '\n');
    this._queue = this._queue
      .then(async () => {
        for (let i = 0; i < bytes.length; i += 20) {
          const chunk = bytes.slice(i, i + 20);
          await (this.rx.writeValueWithoutResponse
            ? this.rx.writeValueWithoutResponse(chunk)
            : this.rx.writeValue(chunk));
        }
      })
      .catch((err) => console.warn('[clue] write failed', err));
    return this._queue;
  }

  async applyState(s) {
    await this.send(cmd.brightness(s.brightness));
    await this.send(cmd.hunt(s.hunt));
    await this.send(s.mode === 1 ? cmd.modeWithSeed(s.mode, s.seed) : cmd.mode(s.mode));
  }

  _onData(view) {
    this._buf += dec.decode(view);
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._handleLine(line);
    }
  }

  _handleLine(line) {
    const m = /^([MLR])(\d+)$/.exec(line);
    if (!m) return;
    const [, k, v] = m;
    if (k === 'M') {
      this.dispatchEvent(new CustomEvent('watchmode', { detail: Number(v) }));
    } else {
      this._setMask(k, v === '1');
    }
  }

  _setMask(side, up) {
    this.mask[side] = up;
    this.dispatchEvent(new CustomEvent('mask', { detail: { ...this.mask } }));
  }
}
