// The motion library: what each motion is, and how it becomes a pattern for the plugin.
// Pure data and maths (no Bluetooth, no page), so it can be tested on its own.
//
// Each lighting pattern links to a MOTION; the deck turns that motion into a pattern for
// the plugin's channels and stores it there (P), then just says which to play (M) as the
// rig's mode changes, so the motion runs smoothly with no BLE chatter (controller.js).

import { SETS, POWER, modeOf } from '../config.js';

// ---------------------------------------------------------------- the motions
// Every motion is a loop of [t ms, f] points, f -1..1: a servo's f is a share of its swing
// either side of home, a DC motor's / stepper's a share of its top speed (sign = direction).
// Channels alternate between an A and a B part (the 1st, 3rd... motor of a kind is A), so
// two-motor motions (ping-pong, rolling) play across them.
//
// `steps` motions come from the SCMD controller's patterns: (a, b, seconds, ramp) with
// levels 0..100 (servos: 0 = one end of the swing, 100 = the other) or, `signed`,
// -100..100 (speed and direction; servos swing that way from home).

// A seeded random, so a "random" motion is the same pattern every time it's stored.
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const between = (r, a, b) => a + (b - a) * r();

function rumble() {
  const r = seeded(4242);
  return Array.from({ length: 16 }, () =>
    [Math.round(between(r, 20, 100)), Math.round(between(r, 20, 100)), between(r, 0.1, 0.4), r() < 0.5]);
}
function surge() {
  const r = seeded(777), out = [];
  for (let i = 0; i < 3; i++) {
    const base = Math.round(between(r, 15, 35));
    out.push([base, base, between(r, 1.5, 4), true], [100, 100, between(r, 0.3, 0.8), true], [base, base, 0.8, true]);
  }
  return out;
}
function randomSwivel() {
  const r = seeded(99), out = [];
  for (let i = 0; i < 4; i++) {
    const pct = [50, 60, 70, 80, 90, 100][Math.floor(r() * 6)] * (r() < 0.5 ? 1 : -1);
    out.push([pct, pct, between(r, 2, 6), false], [0, 0, between(r, 0.5, 3), false]);
  }
  return out;
}

// MATCH LIGHTS: each lighting pattern's own motion, side by side like the mask. The left
// intake drives part L (motor A), the right part R (motor B); patterns the mask MIRRORs
// (the right side turning the other way) run B in reverse. Timings come from the mask's
// recipes (src/recipes.js) and firmware (firmware/src/leds.py). f: -1..1 as above.
const sample = (len, step, fn) => {
  const pts = [];
  for (let t = 0; t <= len; t += step) pts.push([t, fn(t / 1000)]);
  return pts;
};
const steady = (len, f) => [[0, f], [len, f]];
const mirror = (pts) => pts.map(([t, f]) => [t, -f]);
const heartCurve = (t) => {                           // leds.py heart(): lub-dub every 1.05 s
  const p = t % 1.05;
  return Math.min(1, Math.exp(-((p / 0.055) ** 2)) + 0.7 * Math.exp(-(((p - 0.24) / 0.06) ** 2)));
};
const breathCurve = (t) => 0.1 + 0.9 * (0.5 - 0.5 * Math.cos(t * 2 * Math.PI / 5.5)) ** 1.6;   // leds.py breath()
function flickerTrack(seed, len, lo, hi) {           // neon buzz: uneven, with the odd drop-out
  const r = seeded(seed), pts = [];
  for (let t = 0; t < len; t += 100) {
    const f = r() < 0.12 ? 0 : lo + (hi - lo) * r();
    pts.push([t, f], [t + 90, f]);
  }
  pts.push([len, pts[0][1]]);
  return pts;
}
function dripTrack(len, offset) {                     // a swell as each drop runs down the side
  const pts = [[0, 0.15]];
  for (let t0 = offset; t0 + 1900 <= len; t0 += 3300) pts.push([t0, 0.15], [t0 + 600, 0.5], [t0 + 1850, 0.15]);
  pts.push([len, 0.15]);
  return pts;
}
const scanTrack = () => [[0, 1], [200, 1], [260, 0.35], [4000, 0.35]];   // lock-on kick, then the sweep's pace
// R is the right side's own shape, before RIGHT (same / mirror / off) is applied.
const MATCH = {
  D: () => ({ len: 4000, L: steady(4000, 0.25), R: steady(4000, 0.25) }),
  X: () => ({ len: 1600, L: glitch(0, false), R: glitch(1, false) }),
  r: () => ({ len: 9900, L: dripTrack(9900, 0), R: dripTrack(9900, 1650) }),
  M: () => ({ len: 1820, L: [[0, 0.35], [300, 0.55], [1820, 0.35]], R: [[0, 0.35], [300, 0.55], [1820, 0.35]] }),
  h: () => { const p = sample(1050, 35, heartCurve); return { len: 1050, L: p, R: p }; },
  n: () => ({ len: 1000, L: steady(1000, 0.75), R: steady(1000, 0.75) }),
  s: () => ({ len: 4000, L: scanTrack(), R: scanTrack() }),
  e: () => ({ len: 3000, L: flickerTrack(31, 3000, 0.45, 0.85), R: flickerTrack(57, 3000, 0.45, 0.85) }),
  o: () => { const p = [[0, 0.3], [3000, 0.9], [6000, 0.3]]; return { len: 6000, L: p, R: p }; },
  R: (s) => {                                         // the rainbow's own speed and direction
    const f = Math.min(0.9, 0.3 * (s?.rainbow?.speed ?? 50) / 50) * (s?.rainbow?.dir === 0 ? -1 : 1);
    return { len: 2000, L: steady(2000, f), R: steady(2000, f) };
  },
  B: () => { const p = sample(5500, 100, breathCurve); return { len: 5500, L: p, R: p }; },
  hack: () => ({ len: 1600, L: glitch(2, false).map(([t, f]) => [t, f && Math.sign(f)]), R: glitch(3, false).map(([t, f]) => [t, f && Math.sign(f)]) }),
};
export const MATCHES = (key) => !!MATCH[key];
// The patterns the mask MIRRORs (the right intake turns the other way): RIGHT defaults to MIRROR.
const MIRRORED = new Set(['D', 's', 'n', 'o']);

/** SET -> MOTORS -> MATCH: per pattern { right: 'same'|'mirror'|'off', level %, speed %,
 *  shift ms (SYNC: + = later) }; only what's changed is stored. */
export const matchDefault = (key) => ({ right: MIRRORED.has(key) ? 'mirror' : 'same', level: 100, speed: 100, shift: 0 });
export const matchCfg = (m, key) => ({ ...matchDefault(key), ...m.match?.[key] });

/** A loop's value at t (straight lines between points), like the plugin plays it. */
function valueAt(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    const [t0, v0] = pts[k - 1], [t1, v1] = pts[k];
    if (t <= t1) return t1 === t0 ? v1 : v0 + (v1 - v0) * (t - t0) / (t1 - t0);
  }
  return pts[pts.length - 1][1];
}
/** SYNC: the loop starts `shift` ms later (+) or earlier (-), wrapping round. */
function shiftLoop(pts, len, shift) {
  const d = ((Math.round(shift) % len) + len) % len;
  if (!d) return pts;
  // The end of the loop moves to the front, then (at d) the start, jump and all.
  const tail = pts.filter(([t]) => t > len - d && t < len).map(([t, f]) => [t + d - len, f]);
  const head = pts.filter(([t]) => t <= len - d).map(([t, f]) => [t + d, f]);
  return [[0, valueAt(pts, len - d)], ...tail, [d, valueAt(pts, len)], ...head, [len, valueAt(pts, len - d)]];
}
function applyMatch(match, cfg) {
  const k = cfg.level / 100, R = cfg.right === 'off' ? [[0, 0], [match.len, 0]] : match.R;
  const side = (pts, sign) => shiftLoop(pts, match.len, cfg.shift).map(([t, f]) => [t, f * k * sign]);
  return { len: match.len, L: side(match.L, 1), R: side(R, cfg.right === 'mirror' ? -1 : 1) };
}

export const MOTION_DEFS = {
  lights: { label: 'MATCH LIGHTS', match: true },
  sound: { label: 'SOUND', live: true },        // the phone's mic, live (motorlive.js)
  // the deck's own
  sway: { label: 'SWAY', len: 4000,
    servo: [[0, -0.5], [2000, 0.5], [4000, -0.5]],
    drive: [[0, 0.3], [1800, 0.3], [2000, -0.3], [3800, -0.3], [4000, 0.3]] },
  scan: { label: 'SCAN', len: 2400,
    servo: [[0, -1], [1200, 1], [2400, -1]],
    drive: [[0, 0.5], [1100, 0.5], [1200, -0.5], [2300, -0.5], [2400, 0.5]] },
  beat: { label: 'HEARTBEAT', len: 1000,
    servo: [[0, 0], [80, 0.4], [160, 0], [260, 0.3], [360, 0], [1000, 0]],
    drive: [[0, 0], [80, 0.7], [160, 0], [260, 0.5], [360, 0], [1000, 0]] },
  spin: { label: 'SPIN', len: 2000,
    servo: [[0, -1], [500, 1], [1000, -1], [1500, 1], [2000, -1]],
    drive: [[0, 0.8], [2000, 0.8]] },
  glitch: { label: 'GLITCH', glitch: true },
  // from the SCMD controller: vibration patterns
  steady:   { label: 'STEADY', steps: [[100, 100, 1, false]] },
  pulse:    { label: 'PULSE', steps: [[100, 100, 0.25, false], [0, 0, 0.35, false]] },
  flutter:  { label: 'FLUTTER', steps: [[100, 100, 0.08, false], [0, 0, 0.08, false]] },
  wave:     { label: 'WAVE', steps: [[100, 100, 2, true], [10, 10, 2, true]] },
  pingpong: { label: 'PING-PONG', steps: [[100, 0, 1, true], [0, 100, 1, true]] },
  rolling:  { label: 'ROLLING', steps: [[100, 50, 0.8, true], [50, 100, 0.8, true], [0, 50, 0.8, true], [50, 0, 0.8, true]] },
  alternate: { label: 'ALTERNATE', steps: [[100, 0, 0.3, false], [0, 100, 0.3, false]] },
  staircase: { label: 'STAIRCASE', steps: [[20, 20, 2, false], [35, 35, 2, false], [50, 50, 2, false],
    [65, 65, 2, false], [80, 80, 2, false], [100, 100, 3, false], [0, 0, 2, false]] },
  burst:    { label: 'BUILD + BURST', steps: [[60, 60, 4, true], [0, 0, 0.6, false], [100, 100, 0.3, false],
    [0, 0, 0.5, false], [100, 100, 0.3, false], [0, 0, 1.5, false]] },
  surge:    { label: 'SURGE', steps: surge() },
  rumble:   { label: 'RUMBLE', steps: rumble() },
  // from the SCMD controller: swivel patterns (speed and direction)
  cycle:    { label: 'ON / OFF', signed: true, steps: [[70, 70, 5, false], [0, 0, 3, false]] },
  speedwave: { label: 'SPEED WAVE', signed: true, steps: [[60, 60, 4, true], [90, 90, 4, true]] },
  backforth: { label: 'BACK + FORTH', signed: true, steps: [[70, 70, 4, false], [0, 0, 0.4, false], [-70, -70, 4, false], [0, 0, 0.4, false]] },
  wander:   { label: 'WANDER', signed: true, steps: randomSwivel() },
};
export const MOTIONS = ['none', ...Object.keys(MOTION_DEFS)];
export const MOTION_LABEL = { none: 'NONE', ...Object.fromEntries(Object.entries(MOTION_DEFS).map(([k, d]) => [k, d.label])) };

export const DEFAULT_TUNE = { speed: 100, size: 100 };     // % of the motion's own timing / swing
export const DEFAULT_MOTORS = {
  on: false,
  cap: 50,               // guests' share of each channel's range / speed, % (0 = no guests)
  sound: { gain: 100, size: 100, right: 'same' },   // SOUND: sensitivity, how hard, motor B's way
  shake: 'buzz',          // a CLUE shake: 'off' | 'buzz' | 'spin'
  links: { A: 'sound', D: 'lights', X: 'lights', r: 'lights', M: 'lights', h: 'lights', n: 'lights', s: 'lights',
    e: 'lights', o: 'lights', R: 'lights', B: 'lights', hack: 'lights' },
  off: {},               // motions switched off in SET -> MOTIONS: key -> true
  tune: {},              // motion -> { speed, size } (only the changed ones)
};

/** Steps -> one loop of [t, f] for the A and B parts. */
function fromSteps(def) {
  const A = [], B = [];
  const last = def.steps[def.steps.length - 1];
  let t = 0, pa = last[0], pb = last[1];                       // it loops: a first ramp comes from the end
  const f = (v) => v / 100;                                    // servos are mapped later
  for (const [a, b, sec, ramp] of def.steps) {
    const ms = Math.max(20, Math.round(sec * 1000));
    if (ramp) {
      if (!A.length) { A.push([0, f(pa)]); B.push([0, f(pb)]); }
      A.push([t + ms, f(a)]); B.push([t + ms, f(b)]);
    } else {
      A.push([t, f(a)], [t + ms - 10, f(a)]);
      B.push([t, f(b)], [t + ms - 10, f(b)]);
    }
    t += ms; pa = a; pb = b;
  }
  A.push([t, A[0][1]]); B.push([t, B[0][1]]);           // loop back to the start
  return { len: t, A, B };
}

function glitch(i, servo) {
  const rnd = seeded(1234 + i * 977), pts = [];
  for (let t = 0; t < 1600; t += 200) {
    const f = servo ? rnd() * 2 - 1 : rnd() < 0.5 ? 0 : (rnd() * 2 - 1) * 0.7;
    pts.push([t, f], [t + 190, f]);
  }
  pts.push([1600, pts[0][1]]);
  return pts;
}

/** A channel's value for f (-1..1): servo angle, or DC / stepper %. */
export function valueOf(ch, f) {
  if (ch.type === 'servo') {
    const span = f < 0 ? ch.home - ch.min : ch.max - ch.home;
    return Math.round(Math.max(ch.min, Math.min(ch.max, ch.home + f * span)));
  }
  return Math.round(Math.max(-1, Math.min(1, f)) * ch.max);
}

/** The pattern the plugin stores: { len, tracks: { "<ch>": [[t, value], ...] } }. */
export function makePattern(motion, channels, tune = DEFAULT_TUNE, use = null, { key, state, cfg } = {}) {
  const def = MOTION_DEFS[motion];
  if (!def) return null;
  const raw = def.match && MATCH[key]?.(state);
  if (def.live) return null;                          // SOUND is driven live, not stored
  if (def.match && !raw) return null;                 // nothing to follow (VU, Watch...): still
  const match = raw && applyMatch(raw, cfg || matchDefault(key));
  if (match) tune = { ...tune, speed: (tune.speed || 100) * (cfg?.speed ?? 100) / 100 };
  // MOTORS A | B | BOTH: the ones left out get a still track (home / stopped), or the
  // plugin would leave them doing whatever they did last.
  const chosen = (ch) => !use || use.includes(ch.i);
  const time = 100 / Math.max(10, tune.speed || 100), size = (tune.size ?? 100) / 100;
  const steps = def.steps && fromSteps(def);
  const len = match ? match.len : def.glitch ? 1600 : steps ? steps.len : def.len;
  const seen = { servo: 0, drive: 0 }, tracks = {};
  for (const ch of channels) {
    // A = left, B = right by position among the motors, whichever ones are chosen.
    const servo = ch.type === 'servo', part = seen[servo ? 'servo' : 'drive']++ % 2 ? 'B' : 'A';
    if (!chosen(ch)) { tracks[ch.i] = [[0, ch.home || 0]]; continue; }
    let pts;
    if (match) pts = match[part === 'A' ? 'L' : 'R'].map(([t, f]) => [t, servo ? f * 2 - 1 : f]);
    else if (def.glitch) pts = glitch(ch.i, servo);
    else if (steps) pts = steps[part].map(([t, f]) => [t, servo && !def.signed ? f * 2 - 1 : f]);
    else pts = def[servo ? 'servo' : 'drive'];
    tracks[ch.i] = pts.map(([t, f]) => [Math.round(t * time), valueOf(ch, f * size)]);
  }
  return { len: Math.round(len * time), tracks };
}

/** The motion a lighting pattern actually plays: its link, unless that motion's switched off. */
export function motionOf(m, key) {
  const motion = m.links[key] || 'none';
  if (motion === 'lights' && !MATCH[key]) return 'none';
  return motion !== 'none' && MOTION_DEFS[motion] && !m.off?.[motion] ? motion : 'none';
}
export const tuneOf = (m, motion) => ({ ...DEFAULT_TUNE, ...m.tune?.[motion] });

/** MOTORS A | B | BOTH: 'all', or one channel's number -> the channel list for makePattern. */
export const useOf = (pick) => (pick === undefined || pick === null || pick === 'all' ? null : [Number(pick)]);

/** Which stored pattern should play now: a mode key, '-' (none: back to home), or
 *  undefined (leave it: a picture / word from the IMAGE tab is only passing through). */
export function motorKey(s) {
  if (s.power === POWER.OFF || s.power === POWER.STANDBY) return '-';
  if (s.egg) return undefined;
  const key = s.hacked ? 'hack' : modeOf(s).key;
  return motionOf(s.motors, key) === 'none' ? '-' : key;
}

/** Everything a pattern can be linked from: each mode once (Sign off excluded), and the virus. */
export const LINKABLE = [
  ...Object.values(SETS).flatMap((st) => st.modes).filter((m) => m.key !== 'P').map((m) => [m.key, m.name]),
  ['hack', 'Virus'],
];
