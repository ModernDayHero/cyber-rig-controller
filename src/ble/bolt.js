// Sphero BOLT over the Sphero v2 BLE API, ported from the `spherov2` Python library
// (controls/v2.py Packet, commands/io.py, commands/drive.py, sphero_edu.register_matrix_animation).
// Worn in the carrier it only shows LEDs; out of it, the BOLT tab's DRIVE panel drives it.
//
// Each rig look is an 8x8 animation (palette + frames) uploaded once and then looped
// by the BOLT itself, so nothing streams while it plays.

import { RigDevice } from './device.js';
import { lookPalette, tuneOf } from '../config.js';

const API_SERVICE = '00010001-574f-4f20-5370-6865726f2121';
const API_CHAR = '00010002-574f-4f20-5370-6865726f2121';
const ANTIDOS_SERVICE = '00020001-574f-4f20-5370-6865726f2121';
const ANTIDOS_CHAR = '00020005-574f-4f20-5370-6865726f2121';
const UNLOCK = 'usetheforce...band';

// Targets: nibble 1 = this connection, low nibble = processor (1 primary, 2 secondary)
const SECONDARY = 0x12;  // the matrix lives on the secondary (ST) processor
const SOURCE = 0x01;

// Device / command IDs (spherov2 commands/power.py, commands/io.py)
const POWER = 0x13, POWER_WAKE = 0x0d;
const IO = 0x1a;
const SENSOR = 0x18, SENSOR_COLLISION_CONFIG = 17, SENSOR_COLLISION_NOTIFY = 18;
const DRIVE = 0x16, DRIVE_RESET_YAW = 6, DRIVE_WITH_HEADING = 7, DRIVE_STABILIZATION = 12;
const CID = {
  oneColor: 47,         // set_compressed_frame_player_one_color
  scrollText: 59,       // set_compressed_frame_player_text_scrolling
  saveFrame: 48,        // save_compressed_frame_player64_bit_frame
  saveAnim: 49,         // save_compressed_frame_player_animation
  deleteAll: 53,        // delete_all_compressed_frame_player_animations_and_frames
  playLoop: 67,         // play_compressed_frame_player_animation_with_loop_option
};

const FLAG = { REQ_RESPONSE: 0x02, ACTIVITY: 0x08, HAS_TARGET: 0x10, HAS_SOURCE: 0x20 };
const SOP = 0x8d, EOP = 0xd8, ESC = 0xab;

const KEEPALIVE_MS = 30_000;

let seq = 0;

/** Escaped Sphero v2 packet. With a target it also carries the source id, like spherov2. */
export function spheroPacket(did, cid, data = [], target = null) {
  let flags = FLAG.REQ_RESPONSE | FLAG.ACTIVITY;
  const head = [];
  if (target !== null) {
    flags |= FLAG.HAS_TARGET | FLAG.HAS_SOURCE;
    head.push(target, SOURCE);
  }
  const body = [flags, ...head, did, cid, seq, ...data];
  seq = (seq + 1) % 0xff;
  const chk = 0xff - (body.reduce((a, b) => a + b, 0) & 0xff);
  const out = [SOP];
  for (const b of [...body, chk]) {
    if (b === SOP || b === EOP || b === ESC) out.push(ESC, b & ~0x88); // 0x05 / 0x50 / 0x23
    else out.push(b);
  }
  out.push(EOP);
  return new Uint8Array(out);
}

/** 8x8 grid of palette indexes (0-15) -> 32 bytes: 4 bit planes x rows 7..0. */
export function compressFrame(frame) {
  const out = [];
  for (let plane = 0; plane < 4; plane++) {
    for (let row = 7; row >= 0; row--) {
      let byte = 0;
      for (let col = 0; col < 8; col++) byte |= ((frame[row][col] >> plane) & 1) << (7 - col);
      out.push(byte);
    }
  }
  return out;
}

// ---------- looks: palette + frames per rig mode ----------

const grid = (fn) => Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (_, x) => fn(x, y)));
const rnd = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const PURPLE = [160, 60, 255], MAG = [255, 43, 214], CYAN = [0, 229, 255];
const RED = [255, 30, 30], GREEN = [34, 255, 102], GREEN_HEAD = [200, 255, 216], WHITE = [255, 255, 255];
const BASE = { PURPLE, MAG, CYAN, RED, GREEN, WHITE };
const HEART = ['.##..##.', '########', '########', '.######.', '..####..', '...##...', '........', '........'];
const dim = (c, k) => c.map((v) => Math.round(v * k));

function wheel(h) {
  h = ((h % 1) + 1) % 1 * 6;
  const i = Math.floor(h), f = h - i, q = Math.round(255 * (1 - f)), u = Math.round(255 * f);
  return [[255, u, 0], [q, 255, 0], [0, 255, u], [0, q, 255], [u, 0, 255], [255, 0, q]][i % 6];
}

/** {palette: [[r,g,b]...] (<=16), frames: [8x8 grids], fps, fade} for a rig look. */
export function lookAnimation(look, s) {
  const { PURPLE, MAG, CYAN, RED, GREEN, WHITE } = lookPalette(s, look.key, BASE);   // tuned colours
  const GREEN_HEAD_T = GREEN === BASE.GREEN ? GREEN_HEAD : GREEN.map((v) => Math.min(255, (v >> 1) + 128));
  const r = rnd(4821);
  switch (look.key) {
    case 'D': { // dark purple, a brighter arc circling the edge (like the mask)
      const ring = [];
      for (let i = 0; i < 7; i++) ring.push([i, 0]);
      for (let i = 0; i < 7; i++) ring.push([7, i]);
      for (let i = 7; i > 0; i--) ring.push([i, 7]);
      for (let i = 7; i > 0; i--) ring.push([0, i]);
      const pal = [[0, 0, 0], dim(PURPLE, 0.12), dim(PURPLE, 0.35), dim(PURPLE, 0.65), PURPLE];
      const frames = Array.from({ length: 14 }, (_, f) => {
        const g = grid(() => 0);
        ring.forEach(([x, y], i) => {
          const d = (f * 2 - i + 28) % 28;          // 0 = head of the arc
          g[y][x] = d === 0 ? 4 : d <= 2 ? 3 : d <= 5 ? 2 : 1;
        });
        return g;
      });
      return { palette: pal, frames, fps: 7, fade: false };
    }

    case 'X': { // glitch: dim cyan static, magenta flicks, bursts, a cutout
      const pal = [[0, 0, 0], dim(CYAN, 0.2), MAG, CYAN];
      const frames = [];
      for (let f = 0; f < 10; f++) {
        if (f === 6) { frames.push(grid(() => 0)); continue; }              // cutout
        const burst = f === 2 || f === 3 || f === 8;
        frames.push(grid(() => (burst ? (r() < 0.3 ? 0 : r() < 0.5 ? 2 : 3) : r() < 0.07 ? 2 : 1)));
      }
      return { palette: pal, frames, fps: 10, fade: false };
    }

    case 'r': { // rainfall: purple / magenta / cyan drops falling, one lightning frame
      const pal = [[0, 0, 0], PURPLE, MAG, CYAN, dim(PURPLE, 0.3), dim(MAG, 0.3), dim(CYAN, 0.3), WHITE];
      const drops = Array.from({ length: 8 }, (_, x) => ({ x, y0: Math.floor(r() * 8), c: 1 + (x % 3) }));
      const frames = [];
      for (let f = 0; f < 8; f++) {
        frames.push(grid((x, y) => {
          const d = drops[x];
          const head = (d.y0 + f) % 8;
          if (y === head) return d.c;
          if (y === (head + 7) % 8) return d.c + 3;                       // tail just above
          return 0;
        }));
      }
      frames.splice(5, 0, grid(() => 7));                                   // lightning
      return { palette: pal, frames, fps: 10, fade: false };
    }

    case 'M': { // matrix: green rain with pale heads and fading trails
      const pal = [[0, 0, 0], GREEN_HEAD_T, GREEN, dim(GREEN, 0.4), dim(GREEN, 0.12)];
      const starts = Array.from({ length: 8 }, () => Math.floor(r() * 8));
      const frames = [];
      for (let f = 0; f < 8; f++) {
        frames.push(grid((x, y) => {
          const d = (starts[x] + f - y + 16) % 8;                          // rows below the head
          return d === 0 ? 1 : d === 1 ? 2 : d === 2 ? 3 : d === 3 ? 4 : 0;
        }));
      }
      return { palette: pal, frames, fps: 9, fade: false };
    }

    case 'A': { // VU (no mic on the BOLT): bars bouncing from the bottom
      const pal = [[0, 0, 0], [0, 255, 40], [255, 200, 0], [255, 0, 0]];
      const frames = [];
      for (let f = 0; f < 8; f++) {
        const lvl = Array.from({ length: 8 }, (_, x) => Math.max(1, Math.round(4 + 3.5 * Math.sin(f * 0.8 + x * 0.9) * r())));
        frames.push(grid((x, y) => {
          const row = 7 - y;                                               // 0 = bottom
          if (row >= lvl[x]) return 0;
          return row < 4 ? 1 : row < 6 ? 2 : 3;
        }));
      }
      return { palette: pal, frames, fps: 8, fade: false };
    }

    case 'R': { // rainbow: diagonal wave; speed setting -> frame rate
      const pal = Array.from({ length: 8 }, (_, i) => wheel(i / 8));
      const frames = Array.from({ length: 8 }, (_, f) => grid((x, y) => (x + y + f * (s.rainbow?.dir === 0 ? -1 : 1) + 16) % 8));
      const fps = Math.max(1, Math.min(30, Math.round(4 * (s.rainbow?.speed ?? 50) / 50)));
      return { palette: pal, frames, fps, fade: true };
    }

    case 'B': // rebreather: fade between the two colours
      return { palette: [s.pair[0], s.pair[1]], frames: [grid(() => 0), grid(() => 1)], fps: 1, fade: true };

    case 'H':      // the HACK mode, between infections: same red sweep
    case 'hack': { // red scanner sweep with magenta/white stabs
      const pal = [[0, 0, 0], RED, dim(RED, 0.35), dim(RED, 0.08), MAG, WHITE];
      const cols = [0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1];
      const frames = cols.map((c, f) => grid((x, y) => {
        if ((f === 4 || f === 11) && r() < 0.25) return r() < 0.5 ? 4 : 5;
        const d = Math.abs(x - c);
        return d === 0 ? 1 : d === 1 ? 2 : 3;
      }));
      return { palette: pal, frames, fps: 14, fade: false };
    }

    case 'h': { // heartbeat: a heart, lub (full) then dub (softer), then rest
      const pal = [[0, 0, 0], dim(RED, 0.1), dim(RED, 0.55), RED];
      const beat = [3, 1, 2, 1, 1, 1, 1, 1, 1, 1];
      return { palette: pal, frames: beat.map((b) => grid((x, y) => (HEART[y][x] === '#' ? b : 0))), fps: 10, fade: false };
    }

    case 'G': { // /boo: a dim ghost bobbing, flaring bright now and then
      const g = ['..####..', '.######.', '##.##.##', '########', '########', '########', '########', '#.##.##.'];
      const at = (dy, c) => grid((x, y) => (y - dy >= 0 && g[y - dy][x] === '#' ? c : 0));
      return { palette: [[0, 0, 0], [60, 64, 80], [190, 200, 255]],
        frames: [at(0, 1), at(1, 1), at(0, 1), at(1, 1), at(0, 2)], fps: 3, fade: false };
    }

    case 'J': { // /pumpkin: jack-o'-lantern, the candle-lit face flickering
      const p = ['...ss...', '.oooooo.', 'ofoooofo', 'oooooooo', 'offffffo', 'ooffffoo', '.oooooo.', '........'];
      const idx = { '.': 0, o: 1, s: 3 };
      return { palette: [[0, 0, 0], [255, 80, 0], [255, 190, 30], [30, 150, 30], [255, 120, 0]],
        frames: Array.from({ length: 8 }, () => {
          const lit = r() < 0.75 ? 2 : 4;
          return grid((x, y) => (p[y][x] === 'f' ? lit : idx[p[y][x]]));
        }), fps: 8, fade: false };
    }

    case 'P': // sign off: a flatline across the middle, fading in and out
      return { palette: [[0, 0, 0], dim(WHITE, 0.12), WHITE],
        frames: [2, 1].map((c) => grid((x, y) => (y === 4 ? c : 0))), fps: 1, fade: true };

    default:
      return null;
  }
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
    this._shown = null; // signature of the animation on the BOLT, to skip re-uploads
    this._rx = [];
    this._waiting = null;
    this._lastShake = 0;
    this.shake = { on: true, sensitivity: 5 };
    this._driveNext = null;   // newest [speed, heading] waiting to go
    this._drivePump = null;
  }

  async setup(server) {
    const anti = await server.getPrimaryService(ANTIDOS_SERVICE);
    const antiChar = await anti.getCharacteristic(ANTIDOS_CHAR);
    await antiChar.writeValue(new TextEncoder().encode(UNLOCK));

    const svc = await server.getPrimaryService(API_SERVICE);
    this.api = await svc.getCharacteristic(API_CHAR);
    this._rx = [];
    this.api.addEventListener('characteristicvaluechanged', (e) => this._onData(e.target.value));
    await this.api.startNotifications(); // command responses: used to pace the next packet

    this._shown = null;
    await this._send(spheroPacket(POWER, POWER_WAKE));
    await this.configureShake(this.shake);
    clearInterval(this._keepAlive);
    // The BOLT sleeps after a few idle minutes; a wake every 30 s keeps it up.
    this._keepAlive = setInterval(() => this._send(spheroPacket(POWER, POWER_WAKE)), KEEPALIVE_MS);
  }

  teardown() {
    clearInterval(this._keepAlive);
    this.api = null;
  }

  /** Like spherov2: write each packet in 20-byte pieces, then wait for the BOLT's
   *  response (or 600 ms) before the next one. Whole packets over 20 bytes get refused. */
  _send(packet) {
    if (!this.api) return Promise.resolve();
    this._queue = this._queue
      .then(async () => {
        const replied = new Promise((resolve) => {
          this._waiting = resolve;
          setTimeout(resolve, 600);
        });
        for (let i = 0; i < packet.length; i += 20) {
          await this.api.writeValueWithResponse(packet.slice(i, i + 20));
        }
        await replied;
      })
      .catch((err) => console.warn('[bolt] write failed', err));
    return this._queue;
  }

  /** Reassemble response packets (SOP .. EOP), log errors, release the next send. */
  _onData(view) {
    for (let i = 0; i < view.byteLength; i++) {
      const b = view.getUint8(i);
      if (b === SOP) this._rx = [];
      else if (b === EOP) {
        const p = [];
        for (let j = 0; j < this._rx.length; j++) {
          p.push(this._rx[j] === ESC ? this._rx[++j] | 0x88 : this._rx[j]);
        }
        const flags = p[0];
        const at = 1 + (flags & FLAG.HAS_TARGET ? 1 : 0) + (flags & FLAG.HAS_SOURCE ? 1 : 0);
        const [did, cid, , err] = p.slice(at, at + 4);
        if (flags & 1) {                                     // a response to one of ours
          if (err) console.warn(`[bolt] did ${did} cid ${cid} error ${err}`);
          this._waiting?.();
          this._waiting = null;
        } else if (did === SENSOR && cid === SENSOR_COLLISION_NOTIFY) {
          const now = performance.now();                     // one shake = a burst of hits
          if (now - this._lastShake > 1500) {
            this._lastShake = now;
            this.dispatchEvent(new Event('shake'));
          }
        }
      } else this._rx.push(b);
    }
  }

  _io(cid, data = []) {
    return this._send(spheroPacket(IO, cid, data, SECONDARY));
  }

  setMatrixColor([r, g, b]) {
    return this._io(CID.oneColor, [r, g, b]);
  }

  /** Roll at speed 0-255 toward heading 0-359 (0 = where it was aimed). Only the newest
   *  command is kept while one is in flight, so a joystick can't build up a backlog. */
  drive(speed, heading) {
    this._driveNext = [Math.max(0, Math.min(255, Math.round(speed))), ((Math.round(heading) % 360) + 360) % 360];
    if (this._drivePump) return;
    this._drivePump = (async () => {
      while (this._driveNext) {
        const [sp, hd] = this._driveNext;
        this._driveNext = null;
        await this._send(spheroPacket(DRIVE, DRIVE_WITH_HEADING, [sp, hd >> 8, hd & 0xff, 0], SECONDARY));
      }
      this._drivePump = null;
    })();
  }

  /** The way the BOLT faces now becomes heading 0 ("forward" on the stick). */
  resetAim() {
    return this._send(spheroPacket(DRIVE, DRIVE_RESET_YAW, [], SECONDARY));
  }

  /** Self-balancing on, so it drives straight and holds its heading when stopped. */
  stabilize() {
    return this._send(spheroPacket(DRIVE, DRIVE_STABILIZATION, [1], SECONDARY));
  }

  /** Shake detection = the BOLT's accelerometer collision events. Sensitivity 1-10;
   *  5 is spherov2's default (thresholds 90 / 130). Higher = lighter shakes count. */
  configureShake({ on, sensitivity }) {
    this.shake = { on, sensitivity };
    const x = Math.max(10, 160 - 14 * sensitivity), y = Math.max(20, 200 - 14 * sensitivity);
    return this._send(spheroPacket(SENSOR, SENSOR_COLLISION_CONFIG, [on ? 1 : 0, x, y, x, y, 1], SECONDARY));
  }

  /** Scrolling text (max 25 chars). speed 1-30. */
  async scrollText(text, [r, g, b], speed = 10, brightness = 100) {
    const k = brightness / 100;
    const chars = [...text.slice(0, 25)].map((c) => Math.min(255, c.charCodeAt(0)));
    this._shown = null;
    await this._io(CID.deleteAll);
    await this._io(CID.scrollText, [Math.round(r * k), Math.round(g * k), Math.round(b * k),
      speed % 0x1f, 1, ...chars, 0]);
  }

  /** Show something the BOLT tab picked, instead of following the rig. */
  async showContent(c, s) {
    const b = c.brightness;
    if (c.type === 'text') return this.scrollText(c.text || ' ', c.rgb, c.speed, b);
    if (c.type === 'color') {
      this._shown = null;
      await this._io(CID.deleteAll);
      return this.setMatrixColor(c.rgb.map((v) => Math.round(v * b / 100)));
    }
    const anim = c.type === 'image' ? c.anim : lookAnimation({ key: c.key }, s);
    const sig = JSON.stringify(['content', c.type, c.key, anim?.palette, anim?.frames?.length, anim?.fps, b]);
    if (sig === this._shown || !anim) return;
    this._shown = sig;
    await this.playAnimation(anim, b);
  }

  /** Upload an animation as id 0 (replacing whatever was there) and loop it. */
  async playAnimation({ palette, frames, fps, fade }, brightness = 100) {
    const k = brightness / 100;
    const pal = palette.slice(0, 16).flatMap((c) => c.map((v) => Math.round(v * k)));
    await this._io(CID.deleteAll);
    for (let i = 0; i < frames.length; i++) {
      await this._io(CID.saveFrame, [i >> 8, i & 0xff, ...compressFrame(frames[i])]);
    }
    const idx = frames.flatMap((_, i) => [i >> 8, i & 0xff]);
    await this._io(CID.saveAnim, [0, fps % 31, fade ? 1 : 0, pal.length / 3, ...pal,
      frames.length >> 8, frames.length & 0xff, ...idx]);
    await this._io(CID.playLoop, [0, 1]);
  }

  async applyState(s) {
    const anim = s.look.on ? lookAnimation(s.look, s) : null;
    const bright = Math.round(s.brightness * tuneOf(s, s.look.key).bright / 100);   // device x mode
    const sig = JSON.stringify([s.look.key, anim && anim.palette, anim && anim.fps, bright]);
    if (sig === this._shown) return;
    this._shown = sig;
    if (!anim) {
      await this._io(CID.deleteAll);
      return this.setMatrixColor([0, 0, 0]);
    }
    await this.playAnimation(anim, bright);
  }
}
