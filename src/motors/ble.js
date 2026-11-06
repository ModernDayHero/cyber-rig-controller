// The motor plugin (firmware/MOTOR: Pico Plus 2 W, MicroPython) over Nordic UART.
// It reports its channels (servos, DC motors, steppers) and stores one motion pattern per
// lighting mode, so the motion keeps going smoothly by itself; we tell it which to play.
//
// Phone -> plugin: ?  |  X (STOP)  |  V <ch> <value> [ms]  |  K  |  P <key> <json>  |  M <key>|-
// Plugin -> phone: C <i> <type> <name> <min> <max> <home> ... C end  |  S <key>|-  |  E <why>

import { RigDevice, Status } from '../ble/device.js';
import { NUS_SERVICE } from '../ble/clue.js';

const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const MOTOR_NAME = 'RIG-MOTOR';

const enc = new TextEncoder();
const dec = new TextDecoder();

// CRC-32 (the same as MicroPython's binascii.crc32), to check an update arrived whole.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

/** The plugin firmware this deck carries (loaded only when needed, not in every page). */
export async function bundledFirmware() {
  const { default: text } = await import('../../firmware/MOTOR/main.py?raw');
  const bytes = enc.encode(text);
  return { bytes, crc: crc32(bytes) };
}

export class Motor extends RigDevice {
  constructor() {
    // Other names the board may advertise as (firmware/MOTOR identity.json), kept on this phone.
    let extra = [];
    try { extra = JSON.parse(localStorage.getItem('rig-motor-names') || '[]'); } catch {}
    const filters = [MOTOR_NAME, ...extra].map((namePrefix) => ({ namePrefix }));
    super({ key: 'motor', label: 'Motor', filters, optionalServices: [NUS_SERVICE] });
    this.rx = this.tx = null;
    this._queue = Promise.resolve();
    this._buf = '';
    this.channels = [];      // [{ i, type: 'servo'|'dc'|'stepper', name, min, max, home }]
    this._incoming = [];
    this.playing = '-';
    this.fwCrc = null;       // the board's firmware CRC (from ?), null = too old to say
    this._waiters = [];
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
    this._buf = '';
    this.fwCrc = null;
    for (const w of this._waiters.splice(0)) w.fail(new Error('the Bluetooth link dropped'));
  }

  /** Wait for a line from the board that `match(k, w)` accepts. */
  _wait(match, ms) {
    return new Promise((resolve, reject) => {
      const w = {
        match, ok: (v) => { clearTimeout(w.t); resolve(v); },
        fail: (e) => { clearTimeout(w.t); reject(e); },
      };
      w.t = setTimeout(() => { this._waiters = this._waiters.filter((x) => x !== w); reject(new Error('the board stopped answering')); }, ms);
      this._waiters.push(w);
    });
  }

  /** Bluetooth update: send `bytes` as `name` (main.py / channels.json); the board checks it,
   *  keeps the old one and restarts. progress(0..1). */
  async upload(name, bytes, progress = () => {}) {
    const answer = (k) => k === 'U';
    let r = this._wait(answer, 6000);
    await this.send(`U ${name} ${bytes.length} ${crc32(bytes)}`);
    let [, w] = await r;
    if (w[0] !== 'ready') throw new Error(w.slice(1).join(' ') || 'refused');
    const PIECE = 120;
    for (let off = 0, seq = 0; off < bytes.length; off += PIECE, seq++) {
      const b64 = btoa(String.fromCharCode(...bytes.subarray(off, off + PIECE)));
      const last = off + PIECE >= bytes.length;
      // Every 8th piece the board says it has it: never more than 8 pieces in flight.
      const ack = seq % 8 === 7 ? this._wait((k, x) => (k === 'A' && +x[0] === seq) || k === 'U', 10000) : null;
      await this.send(`F ${seq} ${b64}`);
      if (ack) {
        const [k, x] = await ack;
        if (k === 'U') throw new Error(x.slice(1).join(' '));
      }
      progress(Math.min(1, (off + PIECE) / bytes.length));
      if (last) break;
    }
    r = this._wait(answer, 20000);
    await this.send('U!');
    [, w] = await r;
    if (w[0] !== 'done') throw new Error(w.slice(1).join(' ') || 'refused');
  }

  async applyState() {
    await this.send('?');
  }

  /** Let go of it for good (SET -> MOTORS off): everything stops, no reconnecting. */
  async forget() {
    if (this.connected) await this.send('X');
    const d = this.device;
    clearTimeout(this._retryTimer);
    this.device = null;
    if (d) {
      d.removeEventListener('gattserverdisconnected', this._onDisconnect);
      try { d.gatt.disconnect(); } catch {}
    }
    this.teardown();
    this._setStatus(Status.IDLE);
  }

  send(line) {
    if (!this.rx) return Promise.resolve();
    const bytes = enc.encode(line + '\n');
    this._queue = this._queue
      .then(async () => {
        for (let i = 0; i < bytes.length; i += 20) {
          const chunk = bytes.slice(i, i + 20);
          await (this.rx.writeValueWithoutResponse ? this.rx.writeValueWithoutResponse(chunk) : this.rx.writeValue(chunk));
        }
      })
      .catch((err) => console.warn('[motor] write failed', err));
    return this._queue;
  }

  stop() { return this.send('X'); }
  keepalive() { return this.send('K'); }
  /** Hand control: servo angle (moving over ms), DC / stepper -100..100 %. */
  set(ch, value, ms = 0) { return this.send(`V ${ch} ${Math.round(value)}${ms ? ' ' + ms : ''}`); }
  store(key, pattern) { return this.send(`P ${key} ${JSON.stringify(pattern)}`); }
  play(key) { return this.send(`M ${key || '-'}`); }
  /** Calibration, live: stall minimum % (and start-up kick ms). */
  calibrate(ch, floor, kick) { return this.send(`N ${ch} ${Math.round(floor)}${kick === undefined ? '' : ' ' + Math.round(kick)}`); }
  saveCalibration() { return this.send('W'); }

  _onData(view) {
    this._buf += dec.decode(view);
    let nl;
    // Our lines end in a newline, the standard protocol's answers ("OK;") in ';'.
    while ((nl = this._buf.search(/[\n;]/)) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (line) this._line(line);
    }
  }

  _line(line) {
    this.dispatchEvent(new CustomEvent('line', { detail: line }));      // the console
    const [k, ...w] = line.split(/\s+/);
    for (const x of this._waiters) {
      if (x.match(k, w)) {
        this._waiters = this._waiters.filter((y) => y !== x);
        x.ok([k, w]);
        break;
      }
    }
    if (k === 'F') {                             // the board's firmware CRC
      this.fwCrc = w[0];
      this.dispatchEvent(new CustomEvent('firmware', { detail: w[0] }));
      return;
    }
    if (k === 'C') {
      if (w[0] === 'end') {
        this.channels = this._incoming;
        this._incoming = [];
        this.dispatchEvent(new CustomEvent('channels', { detail: this.channels }));
      } else if (w.length >= 6) {
        const [i, type, name, min, max, home, floor = -1, kick = -1] = w;
        this._incoming.push({ i: +i, type, name: name.replace(/_/g, ' '), min: +min, max: +max, home: +home,
          floor: +floor, kick: +kick });
      }
    } else if (k === 'S') {
      this.playing = w[0] || '-';
      this.dispatchEvent(new CustomEvent('playing', { detail: this.playing }));
    } else if (k === 'T') {                     // connection test results
      this.dispatchEvent(new CustomEvent('selftest', { detail: w }));
    } else if (k === 'I') {
      this.dispatchEvent(new CustomEvent('info', { detail: w.join(' ') }));
    } else if (k === 'E') {
      console.warn('[motor] refused:', w.join(' '));
      this.dispatchEvent(new CustomEvent('refused', { detail: w.join(' ') }));
    }
  }
}
