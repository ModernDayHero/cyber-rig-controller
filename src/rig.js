// Rig state + fan-out. The CLUE is the source of truth for the mask: the page sends
// it commands and takes its reports back, so watch presses, the random hack and
// pad 0 standby all show up here. The BOLT and hat either follow the rig's look or
// show what their own tab picked.

import { Clue } from './ble/clue.js';
import { Bolt } from './ble/bolt.js';
import { SpotLed } from './ble/spotled.js';
import { BRIGHTNESS, BREATHE_IDX, DEFAULT_HACK_TIMER, DEFAULT_PAIR, DEFAULT_RAINBOW, EGGS, POWER, SETS, TUNE, cmd, look, tuneOf } from './config.js';

const STORE_KEY = 'rig-state-v3';

const DEFAULT_BOLT = {
  follow: true,                       // mirror the rig's mode
  brightness: BRIGHTNESS.default,
  shake: true,                        // shaking the BOLT purges a hack
  sensitivity: 5,
  content: { type: 'look', key: 'D', rgb: [0, 229, 255], text: 'STEAMWORKZ', speed: 10 },
};
const DEFAULT_HAT = {
  follow: true,                       // show the rig's look; off = the uploaded image
  brightness: BRIGHTNESS.default,
  screen: 0,                          // 0 normal, 1 upside down, 2 mirror, 3 both
  effect: 0,                          // transition between frames (spotled EFFECTS)
  ms: 200,                            // frame time for uploaded animations
  lightning: 3,                       // Rainfall strikes per loop: 0 off .. 3 storm
};

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

export class Rig extends EventTarget {
  constructor() {
    super();
    const saved = load();
    this.state = {
      set: saved.set ?? 'os',
      idx: saved.idx ?? { os: 0, alt: 0 },
      pair: saved.pair ?? DEFAULT_PAIR,
      rainbow: saved.rainbow ?? DEFAULT_RAINBOW,
      hackTimer: saved.hackTimer ?? DEFAULT_HACK_TIMER,
      tunes: saved.tunes ?? {},          // only modes the user changed: key -> {bright, colors}
      muted: saved.muted ?? false,       // silences the CLUE + mask (sent on every connect)
      bolt: { ...DEFAULT_BOLT, ...saved.bolt, content: { ...DEFAULT_BOLT.content, ...saved.bolt?.content } },
      hat: { ...DEFAULT_HAT, ...saved.hat },
      power: POWER.ON,
      hacked: false,
    };
    this.boltImage = null;            // uploaded BOLT animation (memory only)
    this.hatImage = null;             // uploaded hat frames [{px}] (memory only)
    this.cap = new SpotLed();
    this.bolt = new Bolt();
    this.clue = new Clue();
    this.devices = [this.clue, this.cap, this.bolt]; // also the Connect-all order

    this.clue.addEventListener('ready', async () => {
      this.clue.send(cmd.time());           // the CLUE has no battery clock: set it
      this.clue.send(cmd.mute(this.state.muted));
      await this.clue.applyState();
      for (const k of Object.keys(this.state.tunes)) this.clue.send(this._tuneCmd(k));  // CLUE -> mask
    });
    this.cap.addEventListener('ready', async () => {
      const h = this.state.hat;
      await this.cap.setBrightness(h.brightness);
      if (h.screen) await this.cap.setScreenMode(h.screen);
      this.pushCap();
    });
    this.bolt.addEventListener('ready', async () => {
      const b = this.state.bolt;
      await this.bolt.configureShake({ on: b.shake, sensitivity: b.sensitivity });
      this.pushBolt();
    });

    // Shaking the BOLT during a hack purges it, like shaking the CLUE (not while
    // driving: every bump would count).
    this.bolt.addEventListener('shake', () => {
      if (this.state.hacked && this.state.bolt.shake && !this.driving) {
        this.purge();
        this.dispatchEvent(new Event('boltshake'));
      }
    });

    // Reports from the CLUE (watch presses, hack, pad 0, its reply to our commands).
    this.clue.addEventListener('report', (e) => {
      const r = e.detail;
      const patch = {};
      if (r.set) {
        patch.set = r.set;
        patch.idx = { ...this.state.idx, [r.set]: r.i };
      }
      if (r.pair) patch.pair = r.pair;
      if (r.rainbow) patch.rainbow = r.rainbow;
      if (r.hackTimer) patch.hackTimer = r.hackTimer;
      if (r.power) patch.power = r.power;
      if ('hacked' in r) patch.hacked = r.hacked;
      this._update(patch);
    });

    this._timers = {};
    // Keep the CLUE's watch accurate: re-sync every 10 minutes while connected.
    setInterval(() => { if (this.clue.connected) this.clue.send(cmd.time()); }, 10 * 60 * 1000);
  }

  _save() {
    const { set, idx, pair, rainbow, hackTimer, tunes, muted, bolt, hat } = this.state;
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ set, idx, pair, rainbow, hackTimer, tunes, muted, bolt, hat })); } catch {}
  }

  /** What the rig looks like right now, for the devices that follow it. */
  _rigSig() {
    const { pair, rainbow, tunes } = this.state;
    return JSON.stringify([look(this.state), pair, rainbow, tunes]);
  }

  _update(patch) {
    const before = this._rigSig();
    Object.assign(this.state, patch);
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    if (this._rigSig() !== before) {
      if (this.state.bolt.follow) this.pushBolt();
      if (this.state.hat.follow) this.pushCap();
      else if (!look(this.state).on) this.pushCap();      // standby/off still blanks it
    }
  }

  _debounce(key, ms, fn) {
    clearTimeout(this._timers[key]);
    this._timers[key] = setTimeout(fn, ms);
  }

  // ---------- devices ----------

  pushBolt() {
    if (!this.bolt.connected) return;
    const b = this.state.bolt;
    const lk = look(this.state);
    // Standby / off always wins, so the whole rig goes dark together; an egg takes over too.
    if (b.follow || !lk.on || this.state.egg) {
      this.bolt.applyState({ ...this.state, brightness: b.brightness, look: lk });
    } else {
      const c = b.content.type === 'image' && this.boltImage ? { type: 'image', anim: this.boltImage } : b.content;
      this.bolt.showContent({ ...c, brightness: b.brightness }, this.state);
    }
  }

  pushCap() {
    if (!this.cap.available) return;      // the hat connects on demand
    const h = this.state.hat, lk = look(this.state);
    if (h.follow || !lk.on || !this.hatImage || this.state.egg) {
      this.cap.applyState({ ...this.state, look: lk });
    } else {
      this.cap.showFrames(this.hatImage, { ms: h.ms, effect: h.effect, speed: 0 },
        JSON.stringify(['img', this.hatImageId, h.ms, h.effect]));
    }
  }

  /** BOLT tab changes. Sliders are debounced so a drag doesn't flood the link. */
  setBolt(patch, { now = false } = {}) {
    const bolt = { ...this.state.bolt, ...patch, content: { ...this.state.bolt.content, ...patch.content } };
    const shakeChanged = patch.shake !== undefined || patch.sensitivity !== undefined;
    this.state.bolt = bolt;
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    const go = () => {
      if (shakeChanged && this.bolt.connected) {
        this.bolt.configureShake({ on: bolt.shake, sensitivity: bolt.sensitivity });
      }
      this.pushBolt();
    };
    if (now) go(); else this._debounce('bolt', 200, go);
  }

  setBoltImage(anim) {
    this.boltImage = anim;
    this.setBolt({ follow: false, content: { type: 'image' } }, { now: true });
  }

  setHat(patch, { now = false } = {}) {
    this.state.hat = { ...this.state.hat, ...patch };
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    const go = async () => {
      if (!this.cap.available) return;
      if (patch.brightness !== undefined) await this.cap.setBrightness(this.state.hat.brightness);
      if (patch.screen !== undefined) await this.cap.setScreenMode(this.state.hat.screen);
      if (patch.follow !== undefined || patch.ms !== undefined || patch.effect !== undefined) this.pushCap();
      else if (patch.lightning !== undefined && this.state.hat.follow) this.pushCap();
    };
    if (now) go(); else this._debounce('hat', 250, go);
  }

  setHatImage(frames) {
    this.hatImage = frames;
    this.hatImageId = (this.hatImageId || 0) + 1;
    this.setHat({ follow: false }, { now: true });
  }

  get locked() {
    return this.state.hacked;
  }

  // ---------- rig commands (optimistic: the CLUE's report confirms or corrects) ----------

  setMode(set, i) {
    if (this.locked) return false;
    this.clue.send(cmd.mode(set, i));
    this._update({ set, idx: { ...this.state.idx, [set]: i }, power: POWER.ON });
    return true;
  }

  setSet(set) {
    return this.setMode(set, this.state.idx[set]);
  }

  setPair(pair) {
    if (this.locked) return false;
    this.clue.send(cmd.colors(pair));
    this._update({ pair, set: 'alt', idx: { ...this.state.idx, alt: BREATHE_IDX } });
    return true;
  }

  /** Rainbow speed / width / direction. Debounced: sliders fire on every pixel of drag. */
  setRainbow(patch) {
    const rainbow = { ...this.state.rainbow, ...patch };
    this.state.rainbow = rainbow;
    this._debounce('rainbow', 150, () => {
      this.clue.send(cmd.rainbow(rainbow));
      this._update({ rainbow });
    });
  }

  _tuneCmd(key) {
    const t = tuneOf(this.state, key);
    return cmd.tune(key, { bright: t.bright, colors: t.colors });
  }

  /** Brightness / colours for one mode, on every device. Debounced for slider drags. */
  setTune(key, patch) {
    const cur = this.state.tunes[key] ?? { bright: TUNE[key].bright, colors: [...TUNE[key].colors] };
    const next = { ...cur, ...patch };
    this.state.tunes = { ...this.state.tunes, [key]: next };
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    this._debounce('tune' + key, 200, () => {
      this.clue.send(this._tuneCmd(key));
      this._update({});                    // hat / BOLT re-render if this mode is showing
    });
  }

  resetTune(key) {
    const tunes = { ...this.state.tunes };
    delete tunes[key];
    this.state.tunes = tunes;
    this.clue.send(this._tuneCmd(key));   // send the defaults so the CLUE / mask follow
    this._update({});
  }

  /** How often the virus hijacks on its own. Works while hacked too (it's a setting). */
  setHackTimer(t) {
    this.clue.send(cmd.hackTimer(t));
    this._update({ hackTimer: t });
  }

  standby() { this.clue.send(cmd.standby()); this._update({ power: POWER.STANDBY }); }
  shutDown() { this.clue.send(cmd.off()); this._update({ power: POWER.OFF }); }
  wake() { this.clue.send(cmd.wake()); this._update({ power: POWER.WAKING }); }
  purge() { this.clue.send(cmd.purge()); }
  alert(kind, text) { this.clue.send(cmd.alert(kind, text)); }
  hack() { this.clue.send(cmd.hack()); }
  setMuted(on) {
    this.clue.send(cmd.mute(on));
    this._update({ muted: on });
  }

  /** BOLT drive mode on / off (the DRIVE panel does the steering and the stopping). */
  setDriving(on) {
    this.driving = on;
    if (on) this.bolt.stabilize();
  }

  /** /boo, /pumpkin, /secret: the CLUE runs the mask + its screen. The hat and BOLT
   *  show the command first, then the egg's look, for the same time (taking over
   *  OWN content too), then go back to what they were showing. */
  egg(name) {
    const e = EGGS[name];
    this.clue.send(cmd.egg(name));
    if (!e.look) return;
    const title = '/' + name.toUpperCase();
    this.state.egg = e.look;                 // not saved: it only lasts e.ms
    clearTimeout(this._eggTimer);
    this._eggTimer = setTimeout(() => {
      this.state.egg = null;
      this.pushCap();
      this.pushBolt();
    }, e.ms);
    const still = () => this.state.egg === e.look;
    if (this.bolt.connected) {
      this.bolt.scrollText(title, e.rgb, 12, this.state.bolt.brightness)
        .then(() => setTimeout(() => still() && this.pushBolt(), 2500));
    }
    if (this.cap.available) {                // the title holds while the look uploads
      this.cap.showTitle(title, e.rgb).then(() => setTimeout(() => still() && this.pushCap(), 1000));
    }
  }

  /** Reconnect devices Chrome already granted, without a picker. */
  restoreAll() {
    return Promise.all(this.devices.map((d) => d.restore()));
  }

  nextUnconnected() {
    return this.devices.find((d) => !d.device);
  }
}

export { SETS };
