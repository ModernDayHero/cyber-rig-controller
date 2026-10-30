// Pushed mask animations ("recipes"). The Bluefruits only build in the rig's own
// states (Dark, rainbow, rebreather, scanned colour, VU, virus, sign off, standby);
// everything else is described here as up to 4 layers and sent through the CLUE,
// which passes it on. Each Bluefruit keeps them in NVM, so a restart doesn't lose them.
// The layer format is documented at the top of firmware/src/leds.py.

import { tuneOf } from './config.js';

const FILL = 0, CHASE = 1, WAVE = 2, DRIP = 3, PULSE = 4, SPARKLE = 5, HALF = 6, SWEEP = 7;
const MIRROR = 1, BURST = 2, CUT = 4, BUZZ = 8, MOTION = 16, FLASH = 32, OVER = 64, USE_B = 128;

const MAG = [255, 43, 214], CYAN = [0, 229, 255], RED = [255, 30, 30], GREEN = [34, 255, 102], WHITE = [255, 255, 255];
const GHOST = [150, 160, 200], ORANGE = [255, 80, 0], CANDLE = [255, 170, 20], BLOOD = [200, 0, 10];
const FRANK = [60, 255, 40], SEA = [0, 60, 255], SEA2 = [0, 200, 200], BUG = [255, 45, 202];

// One layer. `speed`, `p1`, `p2` are the raw bytes; the helpers below take real units.
const layer = (shape, { flags = 0, speed = 0, p1 = 0, p2 = 0, lo = 0, hi = 1, gamma = 1, a = WHITE, b = WHITE }) =>
  [shape, flags, speed & 0xff, p1, p2, Math.round(lo * 255), Math.round(hi * 255), Math.round(gamma * 10), ...a, ...b];

const fill = (a, hi, o = {}) => layer(FILL, { a, hi, ...o });
const chase = ({ heads = 1, turns, tail, ...o }) => layer(CHASE, { p1: heads, speed: Math.round(turns * 20), p2: Math.round(tail * 10), ...o });
const sweep = ({ turns, tail, ...o }) => layer(SWEEP, { p1: 1, speed: Math.round(turns * 20), p2: Math.round(tail * 10), ...o });
const wave = ({ rad = 0, perPixel, sides = 0, ...o }) => layer(WAVE, { speed: Math.round(rad * 10), p1: Math.round(perPixel * 10), p2: Math.round(sides * 10), ...o });
const drip = ({ drops, pxPerSec, every, ...o }) => layer(DRIP, { p1: drops, speed: Math.round(pxPerSec * 10), p2: Math.round(every * 10), ...o });
const heart = (o) => layer(PULSE, { p1: 0, ...o });
const strobe = ({ hz, on, ...o }) => layer(PULSE, { p1: 2, speed: Math.round(hz * 10), p2: Math.round(on * 100), ...o });
const flicker = (o) => layer(PULSE, { p1: 3, ...o });
const beat = ({ every, lasts, ...o }) => layer(PULSE, { p1: 4, p2: Math.round(every * 10), speed: Math.round(lasts * 100), ...o });
const sparkle = (chance, a, o = {}) => layer(SPARKLE, { p1: Math.max(1, Math.round(chance * 255)), a, ...o });   // chance a frame
const half = (side, a, o = {}) => layer(HALF, { p1: side, a, ...o });

const pale = (c) => c.map((v) => Math.min(255, (v >> 1) + 128));

/** Each mode's layers, with the user's tuned colours (the mask still applies brightness). */
const RECIPES = {
  X: ([mg, cy]) => [                                          // glitch: bursts + cutouts
    fill(cy, 0.22, { flags: CUT }),
    sparkle(0.07, mg, { hi: 0.85, flags: OVER | CUT }),
    sparkle(0.7, mg, { b: cy, flags: BURST | USE_B | OVER | CUT }),
  ],
  r: ([a, z], tuned) => [                                     // rainfall + lightning
    drip({ drops: 3, pxPerSec: 2.7, every: 9, lo: 0.04, a, b: z, flags: USE_B }),
    fill(tuned ? a : MAG, 1, { b: z, flags: FLASH | OVER | USE_B }),
  ],
  M: ([g], tuned) => [                                        // matrix drip, pale head
    chase({ turns: 0.55, tail: 5, gamma: 1.6, lo: 0.03, a: g, b: tuned ? pale(g) : [200, 255, 216], flags: USE_B }),
  ],
  h: ([c]) => [heart({ lo: 0.06, a: c })],                    // lub-dub
  n: ([c, trace]) => [                                        // netrun: packets over a trace
    fill(trace, 0.05),
    chase({ heads: 3, turns: 1.6, tail: 2.5, a: c, flags: MIRROR }),
  ],
  s: ([c]) => [                                               // scanner: sweep, green lock-on
    sweep({ turns: 0.3, tail: 1.5, gamma: 2, lo: 0.03, hi: 0.98, a: c, flags: MIRROR }),
    beat({ every: 4, lasts: 0.2, hi: 0.8, a: GREEN, flags: OVER }),
  ],
  e: ([pink, cyan]) => [                                      // neon: two buzzing halves
    half(0, pink, { lo: 0.1, hi: 0.95, flags: BUZZ | CUT }),
    half(1, cyan, { hi: 0.95, flags: BUZZ }),
  ],
  o: ([c]) => [                                               // overclock: heats as it moves
    wave({ perPixel: 0.9, lo: 0.15, a: c, flags: MOTION | MIRROR }),
    sparkle(0.15, WHITE, { flags: MOTION | OVER }),
  ],
  G: () => [                                                  // /boo: wisps, the odd flare
    wave({ rad: 1.3, perPixel: 0.9, sides: 2, lo: 0.04, hi: 0.34, gamma: 3, a: GHOST }),
    fill(GHOST, 0.9, { flags: FLASH | OVER }),
  ],
  J: () => [flicker({ a: ORANGE, b: CANDLE, flags: USE_B })], // /pumpkin: candle
  v: () => [drip({ drops: 1, pxPerSec: 1.2, every: 6, lo: 0.08, a: BLOOD, flags: CUT })],   // /vamp
  k: () => [                                                  // /frank: glow + sparks
    wave({ rad: 2, perPixel: 0.6, lo: 0.05, hi: 0.55, a: FRANK }),
    sparkle(0.3, [200, 220, 255], { flags: BURST | OVER }),
  ],
  f: () => [                                                  // /fish: rolling sea, bubbles
    wave({ rad: 1.5, perPixel: 0.9, lo: 0.3, hi: 0.8, a: SEA, b: SEA2, flags: USE_B | MIRROR }),
    sparkle(0.004, [180, 220, 255], { flags: OVER }),
  ],
  u: () => [strobe({ hz: 3, on: 0.3, lo: 0.06, a: RED, b: MAG, flags: USE_B })],   // /middle
  c: () => [strobe({ hz: 8, on: 0.5, lo: 0.12, a: MAG })],   // censored
  // DEBUG (a guest playing Byte vs BUG.EXE): the bug hunting round a dim cyan field,
  // a white flash for each hit, a red glitch when it eats an Octlet.
  g: () => [fill(CYAN, 0.1), chase({ turns: 0.45, tail: 3, a: BUG, flags: MIRROR })],
  w: () => [fill(WHITE, 1)],
  y: () => [fill(RED, 0.45, { flags: CUT }), sparkle(0.5, RED, { flags: BURST | OVER })],
};
export const RECIPE_KEYS = Object.keys(RECIPES);

/** The bytes for mode `key`'s recipe, for cmd.recipe(). */
export function recipe(s, key) {
  const t = tuneOf(s, key);
  return RECIPES[key](t.colors, t.tuned).flat();
}
