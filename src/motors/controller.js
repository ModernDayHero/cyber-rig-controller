// The motor controller: what the motors do, and why. The rig owns one (rig.motors).
//
//   follow    play the motion linked to the lighting pattern on show (stored on the plugin)
//   test      the bench: play any motion, swivel, sticks, the stall finder
//   shake     a CLUE shake: a short burst, then back to what they were doing
//   set       SET -> MOTORS changes: re-store only the patterns that changed
//
// State lives in rig.state.motors (saved with the rest of the rig); the Bluetooth device
// is rig.motor (ble.js). Events go out on the rig: 'change' (re-render) and 'motornote'
// (a message for the banner).

import { makePattern, motorKey, motionOf, useOf, matchCfg, tuneOf } from './motions.js';
import { SoundDrive, SHAKES } from './live.js';
import { modeOf } from '../config.js';

export class MotorController {
  constructor(rig) {
    this.rig = rig;
    this.test = null;          // the bench's test: { motion, key } | { swivel } | { sticks } | { stall }
    this.key = null;           // the pattern the plugin was last told to play
    this.sound = new SoundDrive(this);    // SOUND: the phone's mic drives the motors

    const motor = rig.motor;
    // On (re)connect the plugin reports its channels; then it gets a pattern for every
    // linked lighting mode (it only rewrites its flash when one changed) and the one to play.
    motor.addEventListener('channels', () => {
      this.endTest();                     // (re)connected: whatever was on test is gone
      for (const key of Object.keys(this.state.links)) this.store(key);
      this.follow(true);
      this.emit();
    });
    motor.addEventListener('status', () => this.emit());
    rig.clue.addEventListener('shake', (e) => this.shake(e.detail));
  }

  get motor() { return this.rig.motor; }
  get state() { return this.rig.state.motors; }
  emit() { this.rig.dispatchEvent(new CustomEvent('change', { detail: this.rig.state })); }
  note(text) { this.rig.dispatchEvent(new CustomEvent('motornote', { detail: text })); }

  // ---------- following the lights ----------

  /** What a lighting pattern's stored motion is: motion + tuning, or null (none). */
  sig(m, key) {
    const motion = motionOf(m, key);
    return motion === 'none' ? null : JSON.stringify([motion, tuneOf(m, motion), m.use ?? 'all',
      motion === 'lights' ? [matchCfg(m, key), key === 'R' ? this.rig.state.rainbow : 0] : 0]);
  }

  /** Send the plugin the pattern for one lighting mode (if it has a stored motion). */
  store(key) {
    const m = this.state, motion = motionOf(m, key);
    if (!this.motor.connected || !this.motor.channels.length || motion === 'none') return;
    const p = makePattern(motion, this.motor.channels, tuneOf(m, motion), this.useList(m.use),
      { key, state: this.rig.state, cfg: matchCfg(m, key) });
    if (p) this.motor.store(key, p);
  }

  /** Play the pattern linked to what the rig shows now (force: again, ending hand control). */
  follow(force = false) {
    if (!this.state.on || !this.motor.connected) return this.sound.stop();
    if (this.test || this._shaking) return;   // a test / a shake burst has the motors
    const key = motorKey(this.rig.state);
    if (key === undefined || (key === this.key && !force)) return;
    this.key = key;
    if (key !== '-' && motionOf(this.state, key) === 'sound') {   // live from the mic
      this.motor.play('-');
      this.sound.start();
      return;
    }
    this.sound.stop();
    this.motor.play(key);
  }

  /** The rainbow's speed / direction changed: Rainbow's MATCH LIGHTS follows it. */
  rainbowChanged(rainbow) {
    const s = this.rig.state;
    if (this.state.links.R !== 'lights' || JSON.stringify(rainbow) === JSON.stringify(s.rainbow)) return;
    s.rainbow = rainbow;
    this.store('R');
    if (this.key === 'R') this.follow(true);
  }

  /** SHAKE: the CLUE was shaken (strength 1-9): a short burst on the motors, then back to what
   *  they were doing. preview = SET's SHAKE buttons with TEST on. */
  shake(strength = 5, { preview = false } = {}) {
    const m = this.state, kind = m.shake;
    if (!m.on || !this.motor.connected || !SHAKES[kind] || this._shaking) return;
    if (this.test && !this.test.motion && !preview) return;     // not over hand control
    const drives = this.drives;
    if (!drives.length) return;
    const k = Math.round(100 * Math.min(1, 0.55 + strength * 0.05)), b = SHAKES[kind](k);
    const use = this.useList(this.test ? m.testUse : m.use);
    const tracks = Object.fromEntries(drives.map((c) => [c.i, !use || use.includes(c.i) ? b.pts : [[0, 0]]]));
    if (this.sound.on) this.sound.stop();
    this._shaking = true;
    this.motor.store('~shake', { len: b.len, tracks });
    this.motor.play('~shake');
    clearTimeout(this._shakeT);
    this._shakeT = setTimeout(() => {          // the burst played once: carry on
      this._shaking = false;
      const t = this.test;
      if (t?.motion) this.testMotion(t.motion, { again: true, key: t.key });
      else if (this.motor.connected) { this.motor.play('-'); this.follow(true); }
    }, b.len);
  }

  // ---------- which motors ----------

  /** The motors (not servos) the board reports. */
  get drives() { return this.motor.connected ? this.motor.channels.filter((c) => c.type !== 'servo') : []; }

  /** The motors the test bench drives (MOTORS A | B | BOTH). */
  get testDrives() {
    const use = this.useList(this.state.testUse);
    return this.drives.filter((c) => !use || use.includes(c.i));
  }

  /** MOTORS A | B | BOTH -> channel list (null = all). A pick that isn't one of the board's
   *  motors (another board, a changed channels.json) means all of them, never none. */
  useList(pick) {
    const use = useOf(pick);
    return use && this.drives.some((c) => use.includes(c.i)) ? use : null;
  }

  /** No motors from the board yet: ask again, and say so (instead of quietly doing nothing). */
  noMotors() {
    if (!this.motor.connected) return true;
    if (this.drives.length) return false;
    this.motor.send('?');
    this.note("The motor board hasn't listed its motors yet: asking it again. Try once more in a moment, or run CONNECTION TEST.");
    return true;
  }

  // ---------- TEST: the bench plays any motion / spins motors, whatever the lights do ----------

  endTest() {
    if (this.test?.motion === 'sound') this.sound.stop();
    clearInterval(this._swivelBeat);
    clearTimeout(this._swivelFlip);
    if (this._stallCal) {                   // the stall finder ran raw: calibration back on
      for (const c of this._stallCal) this.motor.calibrate(c.i, c.floor, c.kick);
      this._stallCal = null;
    }
    this.test = null;
  }

  /** Hand-control tests (swivel, sticks): no pattern underneath, and a keepalive while on. */
  _handTest(test) {
    const was = this.test;
    if (!was || !(was.swivel || was.sticks)) {
      this.endTest();
      this.motor.play('-');
      this.key = '-';
    }
    this.test = test;
    clearInterval(this._swivelBeat);
    this._swivelBeat = setInterval(() => this.motor.keepalive(), 500);
    return was;
  }

  /** Play a motion now (tuned as in SET -> MOTORS); the same one again = end the test. */
  testMotion(motion, { again = false, key: forKey } = {}) {
    if (this.noMotors()) return;
    if (!again && this.test?.motion === motion) return this.stopTest();
    // MATCH LIGHTS plays a pattern's match: the one asked for, else what the rig is showing.
    const s = this.rig.state, key = forKey ?? (s.hacked ? 'hack' : modeOf(s).key);
    if (motion === 'sound') {                   // live from the mic, not a stored pattern
      this.endTest();
      this.test = { motion, key };
      this.motor.play('-');
      this.key = '~test';
      this.sound.start();
      return this.emit();
    }
    const p = makePattern(motion, this.motor.channels, tuneOf(s.motors, motion), this.useList(s.motors.testUse),
      { key, state: s, cfg: matchCfg(s.motors, key) });
    if (!p && motion === 'lights') return this.note('MATCH LIGHTS: nothing to follow in this pattern');
    if (!p) return;
    this.endTest();
    this.sound.stop();
    this.test = { motion, key };
    this.motor.store('~test', p);           // '~': the plugin keeps it in memory only, no flash write
    this.motor.play('~test');
    this.key = '~test';
    this.emit();
  }

  /** SWIVEL: the chosen motors (MOTORS A | B | BOTH) at a steady pct (-100..100, sign =
   *  direction). It's hand control, so the plugin's dead-man stops them if the deck goes
   *  quiet (phone locked, link lost). */
  testSwivel(pct) {
    if (this.noMotors()) return;
    const chs = this.testDrives.map((c) => c.i);
    const prev = this._handTest({ swivel: { chs, pct } }), was = prev?.swivel;
    clearTimeout(this._swivelFlip);
    for (const c of this.drives) if (!chs.includes(c.i) && (prev?.sticks || was?.chs.includes(c.i))) this.motor.set(c.i, 0);
    const go = () => { for (const i of chs) this.motor.set(i, pct); };
    // Reversing spinning motors: stop, rest a moment, then the other way (easier on gearboxes).
    if (was && was.pct && pct && Math.sign(was.pct) !== Math.sign(pct)) {
      for (const i of chs) this.motor.set(i, 0);
      this._swivelFlip = setTimeout(go, 400);
    } else go();
    this.emit();
  }

  /** CONTROLLER: sticks -> the first two motors, -100..100 each. Called many times a second,
   *  so it only tells the page when stick control starts. */
  testSticks(a, b) {
    if (!this.motor.connected) return;
    const starting = !this.test?.sticks, was = this.test?.sticks || {};
    this._handTest({ sticks: { a, b } });
    const [ca, cb] = this.drives;
    if (ca && (starting || a !== was.a)) this.motor.set(ca.i, a);
    if (cb && (starting || b !== was.b)) this.motor.set(cb.i, b);
    if (starting) this.emit();
  }

  /** CALIBRATE: every motor climbs 5 % a step, 1.5 s each, raw (no minimum, no kick): the
   *  first % where one turns reliably is its MIN. */
  testStall() {
    const cal = this.testDrives.filter((c) => c.floor >= 0);
    if (!cal.length) return;
    this.endTest();
    this._stallCal = cal.map(({ i, floor, kick }) => ({ i, floor, kick }));
    for (const c of cal) this.motor.calibrate(c.i, 0, 0);
    const pts = [];
    let t = 0;
    for (let p = 5; p <= 100; p += 5, t += 1500) pts.push([t, p], [t + 1490, p]);
    pts.push([t, 0], [t + 2000, 0]);
    this.motor.store('~stall', { len: t + 2000, tracks: Object.fromEntries(cal.map((c) => [c.i, pts])) });
    this.motor.play('~stall');
    this.key = '~stall';
    this.test = { stall: { at: Date.now(), len: t + 2000 } };
    this.emit();
  }

  /** CALIBRATE: a motor's stall minimum % / kick ms, live (SAVE keeps them on the board). */
  setCalibration(i, { floor, kick }) {
    const c = this.motor.channels.find((x) => x.i === i);
    if (!c) return;
    if (floor !== undefined) c.floor = floor;
    if (kick !== undefined) c.kick = kick;
    const held = this._stallCal?.find((x) => x.i === i);
    if (held) Object.assign(held, { floor: c.floor, kick: c.kick });   // applied when the finder ends
    else this.motor.calibrate(i, c.floor, c.kick);
  }

  /** End the test: back to following the lights. */
  stopTest() {
    if (!this.test) return;
    this.endTest();
    if (this.motor.connected) {
      if (this.state.on) this.follow(true);    // M clears the test's hand control too
      else this.motor.play('-');
    }
    this.emit();
  }

  // ---------- SET -> MOTORS ----------

  /** { on, cap, links, off (motions switched off), tune (motion -> speed / size), match,
   *  use / testUse (MOTORS A | B | BOTH), sound, shake, test }. */
  set(patch) {
    const before = this.state;
    this.rig.state.motors = { ...before, ...patch };
    this.rig._save();
    const now = this.state;
    if (patch.links || patch.off || patch.tune || patch.match) {
      // Re-store only the patterns whose motion or its tuning changed; the plugin plays on.
      let changed = false;
      for (const k of Object.keys(now.links)) {
        if (this.sig(before, k) === this.sig(now, k)) continue;
        this.store(k);
        changed = true;
      }
      if (changed) this.follow(true);
      const t = this.test?.motion;          // the motion on test was retuned: play the new one
      if (t && (JSON.stringify(tuneOf(before, t)) !== JSON.stringify(tuneOf(now, t))
        || (t === 'lights' && patch.match))) this.testMotion(t, { again: true, key: this.test.key });
    }
    if (patch.use !== undefined && patch.use !== before.use) {   // lights' MOTORS: re-store every link
      for (const k of Object.keys(now.links)) this.store(k);
      this.follow(true);
    }
    if (patch.testUse !== undefined && patch.testUse !== before.testUse && this.test) {
      const t = this.test;                  // the bench's MOTORS changed: the test moves over
      if (t.motion) this.testMotion(t.motion, { again: true });
      else if (t.swivel) this.testSwivel(t.swivel.pct);
      else if (t.stall) this.testStall();
    }
    if ((patch.test === false || patch.on === false) && this.test) this.stopTest();
    if (patch.on === false && before.on) { this.sound.stop(); this.motor.forget(); }
    if (patch.on && !before.on) this.motor.restore();
    this.emit();
  }
}
