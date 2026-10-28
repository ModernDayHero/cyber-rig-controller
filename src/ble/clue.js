// Adafruit CLUE over Nordic UART Service. The CLUE owns the mask: it stays the
// BLE central for the Bluefruit(s) and is a peripheral to this page at the same time.
//
// Phone -> CLUE: lines from config.js `cmd`, newline-terminated.
// CLUE -> phone (notify), sent whenever something changes on the watch or the rig:
//   M <os|alt> <i>     current mode
//   C r g b r g b      rebreather colors
//   R sp w dir         rainbow speed / width / direction
//   T min max          random-hack timer, seconds (0 0 = off)
//   P on|waking|blink|off
//   V 0|1              hacked (the CLUE refuses M/C while 1; K purges)
//   L 0|1 0|1          mask Bluefruit links, left then right (older firmware: left only)
//   E <why>            a command was refused (locked, asleep, bad)

import { RigDevice } from './device.js';
import { cmd } from '../config.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we write here
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // CLUE notifies here

export const CLUE_NAME_PREFIX = 'RIG-CLUE'; // ble.name in rig.py

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
    this._setMask(false, false);
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

  /** The CLUE is the source of truth: on (re)connect, just ask it for everything. */
  async applyState() {
    await this.send(cmd.query());
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
    const [k, ...w] = line.split(/\s+/);
    const report = (patch) => this.dispatchEvent(new CustomEvent('report', { detail: patch }));
    switch (k) {
      case 'M':
        if (w[0] === 'os' || w[0] === 'alt') report({ set: w[0], i: Number(w[1]) });
        break;
      case 'C': {
        const v = w.map(Number);
        if (v.length === 6) report({ pair: [v.slice(0, 3), v.slice(3)] });
        break;
      }
      case 'R': {
        const [speed, width, dir] = w.map(Number);
        if (w.length === 3) report({ rainbow: { speed, width, dir } });
        break;
      }
      case 'T': {
        const [min, max] = w.map(Number);
        if (w.length === 2) report({ hackTimer: { min, max } });
        break;
      }
      case 'P':
        report({ power: w[0] });
        break;
      case 'V':
        report({ hacked: w[0] === '1' });
        break;
      case 'L':
        this._setMask(w[0] === '1', w[1] === '1');
        break;
      case 'E':
        this.dispatchEvent(new CustomEvent('refused', { detail: w.join(' ') }));
        break;
    }
  }

  _setMask(left, right) {
    this.mask = { L: left, R: right };
    this.dispatchEvent(new CustomEvent('mask', { detail: this.mask }));
  }
}
