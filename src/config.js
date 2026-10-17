// Single source of truth for modes, palette and the rig command format.
// Matches claude/cyber-rig-lighting.md (sections 1–4).

export const MODES = [
  { id: 0, name: 'Dark',      color: '#A03CFF', rgb: [160, 60, 255] },
  { id: 1, name: 'Glitch',    color: '#FF2BD6', rgb: [255, 43, 214], alt: '#00E5FF' },
  { id: 2, name: 'Hunt',      color: '#FF1E1E', rgb: [255, 30, 30] },
  { id: 3, name: 'Matrix',    color: '#22FF66', rgb: [34, 255, 102] },
  { id: 4, name: 'Rainbow',   color: '#FFFFFF', rgb: [255, 255, 255], rainbow: true },
  { id: 5, name: 'Peace out', color: '#FFFFFF', rgb: [255, 255, 255] },
];

export const HUNT_STYLES = [
  { id: 0, name: 'Sweep' },
  { id: 1, name: 'Heartbeat' },
];

export const BRIGHTNESS = { min: 10, max: 100, default: 35 };

// Plain-text lines sent to the CLUE over Nordic UART. The CLUE relays them to the mask.
export const cmd = {
  mode: (id) => `M${id}`,
  modeWithSeed: (id, seed) => `M${id} S${seed}`, // Glitch: shared seed so bursts line up
  brightness: (pct) => `B${pct}`,
  hunt: (style) => `H${style}`,
  power: (state) => `P${state}`,                  // 0 deep sleep, 1 standby, 2 awake
  tick: () => 'T',
};

export const POWER = { DEEP_SLEEP: 0, STANDBY: 1, AWAKE: 2 };
