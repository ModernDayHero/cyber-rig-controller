// Rig state + fan-out. The CLUE is the source of truth for the mask: the page sends
// it commands and takes its reports back, so watch presses, the random hack and
// pad 0 standby all show up here. The BOLT and hat either follow the rig's look or
// show what their own tab picked.

import { Clue } from './ble/clue.js';
import { Badge } from './ble/badge.js';
import { Bolt } from './ble/bolt.js';
import { SpotLed } from './ble/spotled.js';
import { BRIGHTNESS, BREATHE_IDX, DEFAULT_HACK_TIMER, DEFAULT_PAIR, DEFAULT_RAINBOW, POWER, SETS, TUNE, cmd, look, tuneOf } from './config.js';
import { PIC_MS, TEXT_MS, indexed } from './library.js';
import { RECIPE_KEYS, recipe } from './recipes.js';
import { ascii } from './i18n.js';

const STORE_KEY = 'rig-state-v3';
const MSG_MS = 10000;     // how long a call / message scrolls on the hat
// A title for the hat / BOLT / CLUE: what was typed, as one upper-case ASCII word.
const oneWord = (s) => ascii(s).toUpperCase().replace(/[^!-~]/g, '').slice(0, 19);

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
  clockStyle: 'static',               // the hat's clock in WATCH: 'static' big HH:MM + date, or 'ticker'
};
const CLOCK_CHECK_MS = 15000;         // the hat only gets a new upload when the minute changes
const WATCH_IDX = SETS.alt.modes.findIndex((m) => m.key === 'W');

/** Saved mode positions, kept inside the sets (the ALT set lost HACK, so it got shorter). */
const fitIdx = (idx = {}) => Object.fromEntries(Object.keys(SETS).map((k) =>
  [k, idx[k] >= 0 && idx[k] < SETS[k].modes.length ? idx[k] : 0]));

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

export class Rig extends EventTarget {
  constructor() {
    super();
    const saved = load();
    this.state = {
      set: saved.set ?? 'os',
      idx: fitIdx(saved.idx),
      pair: saved.pair ?? DEFAULT_PAIR,
      rainbow: saved.rainbow ?? DEFAULT_RAINBOW,
      hackTimer: saved.hackTimer ?? DEFAULT_HACK_TIMER,
      tunes: saved.tunes ?? {},          // only modes the user changed: key -> {bright, colors}
      muted: saved.muted ?? false,       // silences the CLUE + mask (sent on every connect)
      sandbox: saved.sandbox ?? false,   // the virus never starts (sent on every connect)
      showCmd: saved.showCmd ?? true,    // eggs: hat / BOLT show the /command before the look
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
    this.badge = new Badge();
    this.devices = [this.clue, this.cap, this.bolt, this.badge]; // also the Connect-all order

    this.clue.addEventListener('ready', async () => {
      this.clue.send(cmd.time());           // the CLUE has no battery clock: set it
      this.clue.send(cmd.mute(this.state.muted));
      this.clue.send(cmd.sandbox(this.state.sandbox));
      await this.clue.applyState();
      for (const k of Object.keys(this.state.tunes)) this.clue.send(this._tuneCmd(k));  // CLUE -> mask
    });
    // A mask side just linked: send it every recipe (it only rewrites its NVM if they changed).
    this._mask = { L: false, R: false };
    this.clue.addEventListener('mask', (e) => {
      const m = e.detail, rose = (m.L && !this._mask.L) || (m.R && !this._mask.R);
      this._mask = { ...m };
      if (rose) this.pushRecipes();
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
    // Hat clock: check often, but showClock's signature only changes with the minute,
    // so the hat is only reconnected and re-sent once a minute.
    setInterval(() => { if (this.watching()) this.pushCap(); }, CLOCK_CHECK_MS);
  }

  _save() {
    const { set, idx, pair, rainbow, hackTimer, tunes, muted, sandbox, showCmd, bolt, hat } = this.state;
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ set, idx, pair, rainbow, hackTimer, tunes, muted, sandbox, showCmd, bolt, hat })); } catch {}
  }

  /** What the rig looks like right now, for the devices that follow it. */
  _rigSig() {
    const { pair, rainbow, tunes } = this.state;
    // watching(): WATCH looks like DARK, but the hat swaps to its clock.
    return JSON.stringify([look(this.state), pair, rainbow, tunes, this.watching()]);
  }

  _update(patch) {
    const before = this._rigSig(), wasHacked = this.state.hacked;
    Object.assign(this.state, patch);
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    // The virus takes over the hat and BOLT even on OWN content, and gives it back on purge.
    const takeover = this.state.hacked !== wasHacked;
    if (this._rigSig() !== before) {
      if (this.state.bolt.follow || takeover) this.pushBolt();
      if (this.state.hat.follow || takeover) this.pushCap();
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
    // Standby / off always wins, so the whole rig goes dark together; a picture or word
    // from the IMAGE tab takes over too.
    if (lk.on && lk.text) {
      this.bolt.scrollText(lk.text, lk.rgb, 12, b.brightness);
    } else if (b.follow || !lk.on || this.state.egg || this.state.hacked) {
      this.bolt.applyState({ ...this.state, brightness: b.brightness, look: lk });
    } else {
      const c = b.content.type === 'image' && this.boltImage ? { type: 'image', anim: this.boltImage } : b.content;
      this.bolt.showContent({ ...c, brightness: b.brightness }, this.state);
    }
  }

  pushCap() {
    if (!this.cap.available) return;      // the hat connects on demand
    // A message is scrolling: it puts the look back after (an egg or the virus cut in).
    if (this.hatMsg && !this.state.egg && !this.state.hacked) return;
    const h = this.state.hat, lk = look(this.state);
    if (lk.on && lk.text) {
      this.cap.showMessage(lk.text, lk.rgb, null);
    } else if (h.follow && this.watching()) {           // WATCH: the CLUE's clock face, the hat's clock
      this.cap.showClock(h.clockStyle);
    } else if (h.follow || !lk.on || !this.hatImage || this.state.egg || this.state.hacked) {
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
      if (patch.follow !== undefined || patch.ms !== undefined || patch.effect !== undefined
        || patch.clockStyle !== undefined) this.pushCap();
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

  /** The rig is in WATCH (and nothing has cut in): the CLUE shows its clock face and
   *  the hat, when it follows the rig, shows its clock with it. */
  watching() {
    const s = this.state;
    return s.set === 'alt' && s.idx.alt === WATCH_IDX && look(s).on && !s.egg && !s.hacked;
  }

  /** HAT tab CLOCK: the whole rig to WATCH, the hat following it. */
  watch() {
    this.setHat({ follow: true }, { now: true });
    return this.setMode('alt', WATCH_IDX);
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

  /** The mask's pushed animations, a line each, paced so the CLUE's 512-byte buffer keeps up. */
  async pushRecipes(keys = RECIPE_KEYS) {
    for (const k of keys) {
      if (!this.clue.connected) return;
      await this.clue.send(cmd.recipe(k, recipe(this.state, k)));
      await new Promise((r) => setTimeout(r, 120));
    }
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
      if (RECIPE_KEYS.includes(key)) this.pushRecipes([key]);   // its colours live in the recipe
      this._update({});                    // hat / BOLT re-render if this mode is showing
    });
  }

  resetTune(key) {
    const tunes = { ...this.state.tunes };
    delete tunes[key];
    this.state.tunes = tunes;
    this.clue.send(this._tuneCmd(key));   // send the defaults so the CLUE / mask follow
    if (RECIPE_KEYS.includes(key)) this.pushRecipes([key]);
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
  /** Incoming call / message: the CLUE runs the mask + sound; the hat scrolls it
   *  for MSG_MS, then goes back to what it was showing. */
  alert(kind, text) {
    this.clue.send(cmd.alert(kind, text));
    if (!this.cap.available || this.state.egg) return;
    this.hatMsg = true;
    this.cap.showMessage(kind === 'c' ? `CALL ${text || 'INCOMING'}` : `MSG ${text || '1 NEW PACKET'}`, [0, 229, 255]);
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => { this.hatMsg = false; this.pushCap(); }, MSG_MS);
  }
  hack() {
    if (this.state.sandbox) return false;
    this.clue.send(cmd.hack());
    return true;
  }
  /** Sandbox: the virus can't start. The CLUE purges a running one and steps off HACK. */
  setSandbox(on) {
    this.clue.send(cmd.sandbox(on));
    this._update({ sandbox: on });
  }
  setMuted(on) {
    this.clue.send(cmd.mute(on));
    this._update({ muted: on });
  }
  setShowCmd(on) { this._update({ showCmd: on }); }

  /** BOLT drive mode on / off (the DRIVE panel does the steering and the stopping). */
  setDriving(on) {
    this.driving = on;
    if (on) this.bolt.stabilize();
  }

  /** A library picture (library.js) everywhere: the phone sends the CLUE the picture
   *  itself, the mask runs the entry's mode, the hat and BOLT show its look. `typed`
   *  is what was typed (/boo, ghost, /pizza for the ?), shown first with TITLE: SHOW. */
  showPic(p, typed = p.id) {
    const title = this.state.showCmd ? oneWord(typed) : '';
    if (p.art) for (const line of cmd.picture(indexed(p))) this.clue.send(line);
    // The censor has no picture: its caption shows as big text instead.
    this.clue.send(cmd.show(p.art ? 'p' : 't', p.mask, p.sound, p.rgb, title, p.caption));
    this._takeOver({ key: p.look || 'pic', pic: p.art ? p : null, rgb: p.rgb }, title, p.ms || PIC_MS);
  }

  /** Any other word: big text on the CLUE, pages on the hat, scrolling on the BOLT. */
  sayText(text) {
    const t = ascii(text).toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!t) return;
    const rgb = [0, 229, 255];
    this.clue.send(cmd.show('t', '', 'm', rgb, '', t));
    this._takeOver({ key: 'text', text: t, rgb }, '', TEXT_MS);
  }

  /** The hat and BOLT show `egg` for `ms` (OWN content too), the title first if any,
   *  then go back to what they were showing. */
  _takeOver(egg, title, ms) {
    this.state.egg = egg;                    // not saved: it only lasts ms
    clearTimeout(this._eggTimer);
    this._eggTimer = setTimeout(() => {
      this.state.egg = null;
      this.pushCap();
      this.pushBolt();
    }, ms);
    if (!title) {                            // straight to the look
      this.pushCap();
      this.pushBolt();
      return;
    }
    const still = () => this.state.egg === egg;
    if (this.bolt.connected) {
      this.bolt.scrollText(title, egg.rgb, 12, this.state.bolt.brightness)
        .then(() => setTimeout(() => still() && this.pushBolt(), 2500));
    }
    if (this.cap.available) {                // the title holds while the look uploads
      this.cap.showTitle(title.slice(0, 8), egg.rgb)  // 8 characters fill the 32 px
        .then(() => setTimeout(() => still() && this.pushCap(), 1000));
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
