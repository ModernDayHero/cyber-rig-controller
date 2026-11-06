// The motor module's page side: SET -> MOTORS (settings.js), the MOTOR tab (tab.js) and
// its test bench (bench.js). They share one context: the rig, its motor controller, the
// page helpers, the motion selected for tuning, and render().

import { setupSettings } from './ui/settings.js';
import { setupBench } from './ui/bench.js';
import { setupTab } from './ui/tab.js';

export function setupMotors({ rig, $, segPick, segShow, showBanner }) {
  const ui = {
    rig, ctl: rig.motors, $, segPick, segShow, showBanner,
    tuning: 'sway',            // the motion the SPEED / SIZE sliders tune (here and on the bench)
    renders: [],               // each part adds its render(state)
    render() { for (const r of ui.renders) r(rig.state); },
  };
  setupSettings(ui);
  setupBench(ui);
  setupTab(ui);

  rig.addEventListener('change', () => ui.render());
  rig.motor.addEventListener('status', () => ui.render());
  rig.motor.addEventListener('channels', () => ui.render());
  rig.motor.addEventListener('refused', (e) => showBanner(`Motor plugin: ${e.detail}`));
  rig.motor.addEventListener('info', (e) => showBanner(`Motor plugin: ${e.detail}`));
  rig.addEventListener('motornote', (e) => showBanner(e.detail));
  ui.render();
}
