// Single source of truth for the modes, palette and the phone <-> CLUE protocol.
// Mirrors the CLUE firmware (edgerunner_firmware/src/rig.py, SETS + phone_cmd).

// The two sets the CLUE cycles with A/B; pad 1 (or the tabs here) switches set.
// `key` is the byte the CLUE sends the mask for that mode.
export const SETS = {
  os: {
    label: 'STEAMWorkz OS',
    modes: [
      { key: 'D', name: 'Dark',     color: '#A03CFF', hint: 'purple breathing' },
      { key: 'X', name: 'Glitch',   color: '#FF2BD6', alt: '#00E5FF', hint: 'bursts + cutouts' },
      { key: 'r', name: 'Rainfall', color: '#B040FF', alt: '#00E5FF', hint: 'rain + lightning' },
      { key: 'M', name: 'Matrix',   color: '#22FF66', hint: 'green digital rain' },
    ],
  },
  alt: {
    label: 'ALT',
    modes: [
      { key: 'A', name: 'VU',         color: '#FFC800', hint: 'mic level meter' },
      { key: 'R', name: 'Rainbow',    color: '#00E5FF', rainbow: true, hint: 'slow wave' },
      { key: 'B', name: 'Rebreather', color: '#00E5FF', breathe: true, hint: 'breathes two colors' },
      { key: 'H', name: 'Hack',       color: '#FF1E1E', alt: '#FF2BD6', hint: 'release the virus' },
    ],
  },
};
export const BREATHE_IDX = 2; // Rebreather's slot in the ALT set
export const RAINBOW_IDX = 1; // Rainbow's slot in the ALT set
export const HACK_IDX = 3;    // Hack's slot in the ALT set

// How often the virus hijacks the rig on its own (seconds, random in the range).
// The CLUE runs the timer; max 0 = off.
export const HACK_TIMER = [
  { key: 'off',    label: 'OFF',    min: 0,   max: 0,   hint: 'only when you pick Hack' },
  { key: 'rare',   label: 'RARE',   min: 600, max: 900, hint: 'every 10–15 min' },
  { key: 'normal', label: 'NORMAL', min: 180, max: 300, hint: 'every 3–5 min' },
  { key: 'often',  label: 'OFTEN',  min: 60,  max: 120, hint: 'every 1–2 min' },
  { key: 'chaos',  label: 'CHAOS',  min: 20,  max: 60,  hint: 'every 20–60 s' },
];
export const DEFAULT_HACK_TIMER = { min: 180, max: 300 };

// Default rebreather pair (CLUE boots with this too).
export const DEFAULT_PAIR = [[160, 60, 255], [0, 229, 255]];

// Rainbow settings, same numbers the CLUE and mask use (bytes):
//   speed 5-250 (50 = 1x), width 5-200 (% of the colour wheel across the rig), dir 1 / 0
export const RAINBOW = {
  speed: { min: 5, max: 250, step: 5, default: 50 },
  width: { min: 5, max: 200, step: 5, default: 30 },
};
export const DEFAULT_RAINBOW = { speed: 50, width: 30, dir: 1 };

// BOLT + hat brightness default; the mask has its own fixed brightness cap.
export const BRIGHTNESS = { min: 10, max: 100, default: 35 };

// CLUE power states as it reports them.
export const POWER = { ON: 'on', WAKING: 'waking', STANDBY: 'blink', OFF: 'off' };

// Phone -> CLUE text lines (newline-terminated) over Nordic UART.
export const cmd = {
  mode: (set, i) => `M ${set} ${i}`,
  colors: ([a, b]) => `C ${[...a, ...b].join(' ')}`,
  rainbow: ({ speed, width, dir }) => `R ${speed} ${width} ${dir}`,
  hackTimer: ({ min, max }) => `T ${min} ${max}`,
  standby: () => 'P standby',
  off: () => 'P off',
  wake: () => 'P wake',
  hack: () => 'H',
  purge: () => 'K',
  query: () => '?',
};

export const modeOf = (s) => SETS[s.set].modes[s.idx[s.set]];

export const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
export const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** What the cap and BOLT should show for the current rig state: one key + colour. */
export function look(s) {
  if (s.power === POWER.OFF || s.power === POWER.STANDBY) return { key: s.power, rgb: [0, 0, 0], on: false };
  if (s.hacked) return { key: 'hack', rgb: [255, 30, 30], on: true };
  const m = modeOf(s);
  const c = m.breathe ? s.pair[0] : rgb(m.color);
  return { key: m.key, rgb: c, on: true };
}
