// SET -> CYCLE: the sequence editor. A sequence is steps of { key, s }: a mode (by its key in
// config.js SETS) for s seconds, round and round. The CLUE runs it (firmware U / G), so the
// rig keeps cycling with the phone away; any pick by hand stops it. Presets live on this
// phone: AUTO, PARTY, CHILL, PHOTO built in, plus any saved here.

import { SETS } from './config.js';

const STORE_KEY = 'rig-cycles';
const MAX_STEPS = 16;
export const BUILT_IN = {
  AUTO: [['D', 180], ['M', 120], ['R', 120], ['X', 60], ['s', 90], ['e', 90]],
  PARTY: [['X', 45], ['r', 60], ['M', 45], ['n', 45], ['e', 60], ['o', 45], ['R', 60]],
  CHILL: [['D', 300], ['B', 240], ['R', 240], ['h', 120]],
  PHOTO: [['e', 90], ['R', 90], ['M', 90], ['n', 90]],
};
// What a step can be: every mode but CYCLE itself and SIGN OFF (a power-down, not a look).
export const STEP_MODES = Object.entries(SETS).flatMap(([set, s]) =>
  s.modes.map((m, i) => ({ ...m, set, i })).filter((m) => !m.cycle && m.key !== 'P'));
const byKey = (k) => STEP_MODES.find((m) => m.key === k);

export function setupCycle({ rig, $, showBanner }) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch {}
  const presets = { ...saved.presets };
  let name = saved.name && (BUILT_IN[saved.name] || presets[saved.name]) ? saved.name : 'AUTO';
  let steps = (presets[name] || BUILT_IN[name]).map(([k, s]) => ({ k, s }));
  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ name, presets })); } catch {}
  };

  function fillPresets() {
    const sel = $('cycPreset');
    sel.replaceChildren(...[...Object.keys(BUILT_IN), ...Object.keys(presets).filter((n) => !BUILT_IN[n])]
      .map((n) => new Option(n, n)));
    sel.value = name;
    $('cycDelete').disabled = !!BUILT_IN[name];
  }

  function renderSteps() {
    $('cycSteps').replaceChildren(...steps.map((st, j) => {
      const row = document.createElement('div');
      row.className = 'cycstep';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = j + 1;
      const sel = document.createElement('select');
      sel.className = 'select';
      sel.append(...STEP_MODES.map((m) => new Option(m.name.toUpperCase(), m.key)));
      sel.value = st.k;
      sel.addEventListener('change', () => { st.k = sel.value; });
      const secs = document.createElement('input');
      secs.className = 'text secs';
      secs.type = 'number';
      secs.inputMode = 'numeric';
      secs.min = 5;
      secs.max = 3600;
      secs.value = st.s;
      secs.setAttribute('aria-label', 'seconds');
      secs.addEventListener('change', () => { st.s = Math.max(5, Math.min(3600, Math.round(+secs.value) || 60)); secs.value = st.s; });
      const s = document.createElement('span');
      s.className = 'unit';
      s.textContent = 's';
      const btn = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'ghost';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', () => { fn(); renderSteps(); });
        return b;
      };
      row.append(n, sel, secs, s,
        btn('↑', 'Move up', () => j > 0 && steps.splice(j - 1, 0, steps.splice(j, 1)[0])),
        btn('↓', 'Move down', () => j < steps.length - 1 && steps.splice(j + 1, 0, steps.splice(j, 1)[0])),
        btn('✕', 'Remove', () => steps.length > 1 && steps.splice(j, 1)));
      return row;
    }));
    $('cycAdd').disabled = steps.length >= MAX_STEPS;
    const total = steps.reduce((a, st) => a + st.s, 0);
    $('cycTotal').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'} · one round ${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  $('cycPreset').addEventListener('change', () => {
    name = $('cycPreset').value;
    steps = (presets[name] || BUILT_IN[name]).map(([k, s]) => ({ k, s }));
    save();
    fillPresets();
    renderSteps();
  });
  $('cycAdd').addEventListener('click', () => {
    if (steps.length < MAX_STEPS) steps.push({ k: 'D', s: 60 });
    renderSteps();
  });
  $('cycSave').addEventListener('click', () => {
    const n = (prompt('Save this sequence as:', BUILT_IN[name] ? '' : name) || '').trim().toUpperCase().slice(0, 16);
    if (!n) return;
    if (BUILT_IN[n]) return showBanner(`${n} is built in: pick another name.`);
    presets[n] = steps.map((st) => [st.k, st.s]);
    name = n;
    save();
    fillPresets();
  });
  $('cycDelete').addEventListener('click', () => {
    if (BUILT_IN[name] || !confirm(`Delete the ${name} sequence?`)) return;
    delete presets[name];
    name = 'AUTO';
    steps = BUILT_IN.AUTO.map(([k, s]) => ({ k, s }));
    save();
    fillPresets();
    renderSteps();
  });
  $('cycStart').addEventListener('click', () => {
    if (!rig.clue.connected) return showBanner('Connect the CLUE first: it runs the sequence.');
    rig.runCycle(steps.map((st) => ({ ...byKey(st.k), s: st.s })));
  });
  $('cycStop').addEventListener('click', () => rig.stopCycle());

  function status(s) {
    const c = s.cycle;
    $('cycStatus').textContent = !rig.clue.connected ? 'The CLUE runs it: connect it to start or stop.'
      : c?.on ? `RUNNING: step ${c.i + 1} of ${c.n}. Any pick by hand stops it.` : 'Stopped.';
  }
  rig.addEventListener('change', (e) => status(e.detail));
  fillPresets();
  renderSteps();
  status(rig.state);
}
