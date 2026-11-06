// The motion feed: what the rig's motors are doing, as two live levels (left = motor A's
// part, right = motor B's), -100..100 each. For outputs that can't store patterns (a
// bridge to another app, a robot's wheels): sample sides() a few times a second.
//
// It follows exactly what the motor board would play: the bench's test motion if one is on,
// else the motion linked to the lighting pattern (MATCH LIGHTS, the links), SOUND live from
// the mic, and a CLUE shake as a short on / off burst.

import { makePattern, motorKey, motionOf, matchCfg, tuneOf } from '../motors/motions.js';

// The rig's two sides as two virtual motors: makePattern gives side L (A) and R (B) tracks.
const SIDES = [{ i: 0, type: 'dc', min: -100, max: 100, home: 0 }, { i: 1, type: 'dc', min: -100, max: 100, home: 0 }];
const GATE = 0.15;                       // SOUND: below this is room hiss

/** A track's value at t (straight lines between points), as the motor board plays it. */
export function at(track, t) {
  if (!track?.length) return 0;
  if (t <= track[0][0]) return track[0][1];
  for (let k = 1; k < track.length; k++) {
    const [t0, v0] = track[k - 1], [t1, v1] = track[k];
    if (t <= t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }
  return track[track.length - 1][1];
}

export class MotionFeed {
  /** owner: who holds the mic while SOUND plays (the plugin's id). */
  constructor(rig, owner) {
    this.rig = rig;
    this.owner = owner;
    this.playing = null;
    this.started = 0;
    this.pattern = null;
    this.shakeUntil = 0;
  }

  /** A CLUE shake: a burst of on / off for its length, then back to the motion. */
  shake(ms = 640) { this.shakeUntil = Date.now() + ms; }

  /** What the motors would do now: { motion, key } (a bench test wins). */
  now() {
    const s = this.rig.state, test = this.rig.motors.test;
    if (test?.motion) return { motion: test.motion, key: test.key };
    const key = motorKey(s);
    if (key === undefined) return this.playing;     // a picture passing through: keep going
    return { motion: key === '-' ? 'none' : motionOf(s.motors, key), key };
  }

  /** [left, right], -100..100. */
  sides() {
    const s = this.rig.state, m = s.motors, t = Date.now(), sound = this.rig.motors.sound;
    if (t < this.shakeUntil) {
      const on = Math.floor((this.shakeUntil - t) / 100) % 2 === 0;
      return [on ? 100 : 0, on ? 100 : 0];
    }
    const want = this.now() ?? { motion: 'none' };
    const sig = JSON.stringify([want, tuneOf(m, want.motion), matchCfg(m, want.key), s.rainbow]);
    if (sig !== this.playing?.sig) {               // a new motion: start it from the top
      this.playing = { ...want, sig };
      this.started = t;
      this.pattern = want.motion === 'none' || want.motion === 'sound' ? null
        : makePattern(want.motion, SIDES, tuneOf(m, want.motion), null, { key: want.key, state: s, cfg: matchCfg(m, want.key) });
      if (want.motion === 'sound') sound.start(this.owner); else sound.stop(this.owner);
    }
    if (want.motion === 'sound') {
      const v = sound.level < GATE ? 0 : ((sound.level - GATE) / (1 - GATE)) * (m.sound?.size ?? 100);
      return [v, m.sound?.right === 'mirror' ? -v : v];
    }
    if (!this.pattern) return [0, 0];
    const tt = (t - this.started) % this.pattern.len;
    return [at(this.pattern.tracks[0], tt), at(this.pattern.tracks[1], tt)];
  }

  /** Stopped or paused: forget the motion (it restarts from the top) and let go of the mic. */
  idle() {
    if (!this.playing) return;
    this.playing = null;
    this.rig.motors.sound.stop(this.owner);
  }
}
