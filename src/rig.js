// Rig state + fan-out. The phone only sends state changes; devices animate locally.

import { Clue } from './ble/clue.js';
import { Bolt } from './ble/bolt.js';
import { SpotLed } from './ble/spotled.js';
import { BRIGHTNESS, POWER, cmd } from './config.js';

const STORE_KEY = 'rig-state-v1';

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}

export class Rig extends EventTarget {
  constructor() {
    super();
    const saved = load();
    this.state = {
      mode: saved.mode ?? 0,
      brightness: saved.brightness ?? BRIGHTNESS.default,
      hunt: saved.hunt ?? 0,
      seed: 0,
      power: POWER.AWAKE,
    };
    this.cap = new SpotLed();
    this.bolt = new Bolt();
    this.clue = new Clue();
    this.devices = [this.cap, this.bolt, this.clue]; // also the Connect-all order

    for (const d of this.devices) {
      // A device that (re)joins gets the full current state.
      d.addEventListener('ready', () => d.applyState(this.state));
    }

    // Mode picked on the watch: the CLUE has already applied it to the mask.
    this.clue.addEventListener('watchmode', (e) => {
      this._update({ mode: e.detail }, { skip: this.clue });
    });

    this._brightTimer = null;
  }

  _save() {
    const { mode, brightness, hunt } = this.state;
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ mode, brightness, hunt })); } catch {}
  }

  _update(patch, { skip } = {}) {
    Object.assign(this.state, patch);
    this._save();
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
    return this.devices.filter((d) => d !== skip && d.connected);
  }

  setMode(id) {
    const seed = id === 1 ? Math.floor(Math.random() * 10000) : this.state.seed;
    const targets = this._update({ mode: id, seed, power: POWER.AWAKE });
    for (const d of targets) {
      if (d === this.clue) d.send(id === 1 ? cmd.modeWithSeed(id, seed) : cmd.mode(id));
      else d.applyState(this.state);
    }
  }

  setHunt(style) {
    const targets = this._update({ hunt: style });
    for (const d of targets) {
      if (d === this.clue) d.send(cmd.hunt(style));
      else if (this.state.mode === 2) d.applyState(this.state);
    }
  }

  /** Debounced so dragging the slider doesn't flood the links. */
  setBrightness(pct) {
    this.state.brightness = pct;
    clearTimeout(this._brightTimer);
    this._brightTimer = setTimeout(() => {
      const targets = this._update({ brightness: pct });
      for (const d of targets) {
        if (d === this.clue) d.send(cmd.brightness(pct));
        else d.applyState(this.state);
      }
    }, 150);
  }

  setPower(p) {
    const targets = this._update({ power: p });
    for (const d of targets) {
      if (d === this.clue) d.send(cmd.power(p));
      else d.applyState(this.state);
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
