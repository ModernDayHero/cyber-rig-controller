import './style.css';
import { SETS, BREATHE_IDX, RAINBOW_IDX, HACK_IDX, HACK_TIMER, RAINBOW, POWER, TUNE, EGGS, hex, rgb, modeOf, tuneOf } from './config.js';
import { Rig } from './rig.js';
import { decodeImage, toBolt, toHat, paintPreview, paintHat } from './image.js';
import { EFFECTS, rgb323, fromRgb323 } from './ble/spotled.js';
import { Status } from './ble/device.js';
import { setupDrive } from './drive.js';

const $ = (id) => document.getElementById(id);
const rig = new Rig();
setupDrive(rig, $);

// ---------- set tabs + mode tiles ----------
const tabEls = {};
for (const [key, set] of Object.entries(SETS)) {
  const b = document.createElement('button');
  b.textContent = set.label;
  b.addEventListener('click', () => {
    if (!rig.setSet(key)) flashLocked();
  });
  $('tabs').append(b);
  tabEls[key] = b;
}

let tileEls = [];
let tilesFor = null;
function buildTiles(setKey) {
  if (tilesFor === setKey) return;
  tilesFor = setKey;
  $('modes').replaceChildren();
  tileEls = SETS[setKey].modes.map((m, i) => {
    const b = document.createElement('button');
    b.className = 'mode' + (m.rainbow ? ' rainbow' : '') + (m.alt ? ' duo' : '') + (m.breathe ? ' breathe-tile' : '');
    b.style.setProperty('--c', m.color);
    if (m.alt) b.style.setProperty('--c2', m.alt);
    b.innerHTML = `<span class="num">${m.key}</span><span class="name">${m.name}</span>` +
      `<span class="hint">${m.hint}</span><span class="bar"></span>`;
    b.addEventListener('click', () => {
      if (!rig.setMode(setKey, i)) flashLocked();
    });
    $('modes').append(b);
    return b;
  });
}

// ---------- rebreather colors ----------
let pairTimer = null;
function pairFromInputs() {
  return [rgb($('c1').value), rgb($('c2').value)];
}
function sendPairSoon() {
  const pair = pairFromInputs();
  paintPair(pair);
  clearTimeout(pairTimer);
  pairTimer = setTimeout(() => { if (!rig.setPair(pair)) flashLocked(); }, 200);
}
$('c1').addEventListener('input', sendPairSoon);
$('c2').addEventListener('input', sendPairSoon);
$('swap').addEventListener('click', () => {
  [$('c1').value, $('c2').value] = [$('c2').value, $('c1').value];
  sendPairSoon();
});
function paintPair([a, b]) {
  const root = document.documentElement.style;
  root.setProperty('--p1', hex(a));
  root.setProperty('--p2', hex(b));
}

// ---------- rainbow settings ----------
for (const [k, el] of [['speed', $('rbSpeed')], ['width', $('rbWidth')]]) {
  Object.assign(el, { min: RAINBOW[k].min, max: RAINBOW[k].max, step: RAINBOW[k].step });
  el.addEventListener('input', () => {
    rig.setRainbow({ [k]: Number(el.value) });
    paintRainbow(rig.state.rainbow);
  });
}
for (const b of $('rbDir').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    rig.setRainbow({ dir: Number(b.dataset.dir) });
    paintRainbow(rig.state.rainbow);
  });
}
function paintRainbow({ speed, width, dir }) {
  // One trip round the colour wheel takes ~16.7 s at 1x on the mask (0.06 rev/s).
  const p = $('rbpreview').style;
  p.setProperty('--rb-time', `${(16.7 * 50 / speed).toFixed(2)}s`);
  p.setProperty('--rb-size', `${Math.round(10000 / width)}%`);
  p.setProperty('--rb-dir', dir ? 'normal' : 'reverse');
  $('rbSpeedOut').textContent = `${(speed / 50).toFixed(1)}x`;
  $('rbWidthOut').textContent = `${width}%`;
  for (const b of $('rbDir').querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.dir) === dir);
}

// ---------- tune: brightness + colours for the selected mode ----------
let tuneKey = null;
$('tuneBright').addEventListener('input', () => {
  $('tuneBrightOut').textContent = `${$('tuneBright').value}%`;
  if (tuneKey) rig.setTune(tuneKey, { bright: Number($('tuneBright').value) });
});
$('tuneReset').addEventListener('click', () => tuneKey && rig.resetTune(tuneKey));
function renderTune(s) {
  const m = modeOf(s), key = m.key, t = tuneOf(s, key), d = TUNE[key];
  $('tunepanel').hidden = !d || s.power !== POWER.ON;
  if (!d) return;
  $('tuneName').textContent = m.name.toUpperCase();
  if (document.activeElement !== $('tuneBright')) $('tuneBright').value = t.bright;
  $('tuneBrightOut').textContent = `${t.bright}%`;
  $('tuneReset').disabled = !s.tunes[key];
  if (tuneKey !== key) {                    // rebuild the colour swatches for this mode
    tuneKey = key;
    $('tuneColors').replaceChildren(...d.labels.map((label, i) => {
      const wrap = document.createElement('label');
      wrap.className = 'swatch';
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.addEventListener('input', () => {
        const colors = tuneOf(rig.state, key).colors.map(hex);
        colors[i] = inp.value;
        rig.setTune(key, { colors });
      });
      const span = document.createElement('span');
      span.textContent = label;
      wrap.append(inp, span);
      return wrap;
    }));
  }
  [...$('tuneColors').querySelectorAll('input')].forEach((inp, i) => {
    if (document.activeElement !== inp) inp.value = hex(t.colors[i]);
  });
}

// ---------- hack timer (how often the virus hijacks on its own) ----------
const hackBtns = HACK_TIMER.map((p) => {
  const b = document.createElement('button');
  b.textContent = p.label;
  b.addEventListener('click', () => rig.setHackTimer({ min: p.min, max: p.max }));
  $('hackTimer').append(b);
  return b;
});
function renderHackTimer(t) {
  const i = HACK_TIMER.findIndex((p) => p.min === t.min && p.max === t.max);
  hackBtns.forEach((b, j) => b.classList.toggle('on', j === i));
  $('hackTimerHint').textContent = i >= 0 ? `Random hijack: ${HACK_TIMER[i].hint}`
    : t.max ? `Random hijack: every ${t.min}–${t.max} s` : 'Random hijack: off';
}

// ---------- incoming call / message, slash commands ----------
// The CLUE's terminal font is plain ASCII, so the text goes over upper-cased and stripped.
const alertText = () => $('alertText').value.toUpperCase().replace(/[^ -~]/g, '').replace(/\s+/g, ' ').trim();
function sendAlert(kind) {
  rig.alert(kind, alertText());
  const b = $('alertSend').querySelector(`[data-kind="${kind}"]`);
  b.classList.add('on');
  setTimeout(() => b.classList.remove('on'), kind === 'c' ? 5200 : 1000);
}
for (const b of $('alertSend').querySelectorAll('button')) b.addEventListener('click', () => sendAlert(b.dataset.kind));
for (const b of $('mute').querySelectorAll('button')) b.addEventListener('click', () => rig.setMuted(b.dataset.muted === '1'));
for (const b of $('showCmd').querySelectorAll('button')) b.addEventListener('click', () => rig.setShowCmd(b.dataset.show === '1'));

// Every mode is a command too, by its name: /dark /matrix /rainbow /signoff ...
const MODE_CMDS = {};
for (const [set, { modes }] of Object.entries(SETS)) {
  modes.forEach((m, i) => {
    MODE_CMDS[m.name.toLowerCase().replace(/[^a-z0-9]/g, '')] = () => { if (!rig.setMode(set, i)) flashLocked(); };
  });
}
MODE_CMDS.audio = MODE_CMDS.vu;
const SLASH = {
  ...MODE_CMDS,
  hack: () => rig.hack(),               // the HACK mode is the virus: same thing
  purge: () => rig.purge(),
  ...Object.fromEntries(Object.keys(EGGS).filter((n) => !EGGS[n].notCmd).map((name) => [name, () => rig.egg(name)])),
};
const LISTED = Object.keys(SLASH).filter((n) => !EGGS[n]?.hidden && n !== 'audio').map((n) => '/' + n).join(' ');
// Enter: /command runs it, anything else goes out as a message. A /word that isn't
// a command still gets a show: the word, then a big ? on the rig.
$('alertText').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const v = $('alertText').value.trim();
  if (!v.startsWith('/')) { sendAlert('m'); return; }
  const word = v.slice(1).split(/\s+/)[0] || '?';
  const run = SLASH[word.toLowerCase()];
  if (run) run();
  else {
    rig.egg('huh', word);
    showBanner(`Unknown command /${word}. Try ${LISTED}`);
  }
  $('alertText').value = '';
});

// ---------- views: RIG / BOLT / HAT ----------
const VIEW_KEY = 'rig-view';
let view = localStorage.getItem(VIEW_KEY) || 'rig';
function showView(v) {
  view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
  for (const b of $('views').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
  for (const k of ['rig', 'bolt', 'hat']) $(`view-${k}`).hidden = k !== v;
}
for (const b of $('views').querySelectorAll('button')) b.addEventListener('click', () => showView(b.dataset.view));
showView(view);

// ---------- BOLT tab ----------
const BOLT_LOOKS = [
  ['D', 'Dark'], ['X', 'Glitch'], ['r', 'Rainfall'], ['M', 'Matrix'],
  ['A', 'VU'], ['R', 'Rainbow'], ['B', 'Rebreather'], ['hack', 'Hack'],
  ['h', 'Heartbeat'], ['P', 'Sign off'],
];
const boltLookEls = BOLT_LOOKS.map(([key, name]) => {
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => rig.setBolt({ follow: false, content: { type: 'look', key } }, { now: true }));
  $('boltLooks').append(b);
  return [key, b];
});
const segPick = (id, attr, fn) => {
  for (const b of $(id).querySelectorAll('button')) b.addEventListener('click', () => fn(b.dataset[attr]));
};
const segShow = (id, attr, val) => {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === String(val));
};
segPick('boltFollow', 'follow', (v) => rig.setBolt({ follow: v === '1' }, { now: true }));
segPick('boltShake', 'shake', (v) => rig.setBolt({ shake: v === '1' }, { now: true }));
let boltPane = rig.state.bolt.content.type;
segPick('boltType', 'type', (t) => { boltPane = t; render(rig.state); });

$('boltColor').addEventListener('input', () =>
  rig.setBolt({ follow: false, content: { type: 'color', rgb: rgb($('boltColor').value) } }));
$('boltTextSpeed').addEventListener('input', () => { $('boltTextSpeedOut').textContent = $('boltTextSpeed').value; });
$('boltTextSend').addEventListener('click', () => rig.setBolt({
  follow: false,
  content: { type: 'text', text: $('boltText').value || ' ', rgb: rgb($('boltTextColor').value), speed: Number($('boltTextSpeed').value) },
}, { now: true }));
$('boltSense').addEventListener('input', () => rig.setBolt({ sensitivity: Number($('boltSense').value) }));
$('boltBright').addEventListener('input', () => rig.setBolt({ brightness: Number($('boltBright').value) }));

// Image -> 8x8, up to 16 colours. Re-converted when the fit mode changes.
let boltFrames = null, boltAnim = null, boltFit = 'contain';
async function convertBolt() {
  if (!boltFrames) return;
  boltAnim = toBolt(boltFrames, boltFit);
  paintPreview($('boltPreview'), boltAnim.frames[0], (i) => boltAnim.palette[i]);
  $('boltImgInfo').textContent = `${boltAnim.frames.length} frame${boltAnim.frames.length > 1 ? 's' : ''}, ` +
    `${boltAnim.palette.length} colours, ${boltAnim.fps} fps`;
  $('boltImgSend').disabled = false;
  // Animate the preview the way the BOLT will.
  clearInterval(convertBolt.t);
  if (boltAnim.frames.length > 1) {
    let f = 0;
    convertBolt.t = setInterval(() => {
      f = (f + 1) % boltAnim.frames.length;
      paintPreview($('boltPreview'), boltAnim.frames[f], (i) => boltAnim.palette[i]);
    }, 1000 / boltAnim.fps);
  }
}
$('boltFile').addEventListener('change', async () => {
  const file = $('boltFile').files[0];
  if (!file) return;
  try {
    boltFrames = await decodeImage(file, 16);
    await convertBolt();
  } catch (err) {
    showBanner(`Couldn't read that image: ${err.message}`);
  }
});
segPick('boltFit', 'fit', (f) => { boltFit = f; segShow('boltFit', 'fit', f); convertBolt(); });
segShow('boltFit', 'fit', boltFit);
$('boltImgSend').addEventListener('click', () => boltAnim && rig.setBoltImage(boltAnim));

function renderBolt(b) {
  segShow('boltFollow', 'follow', b.follow ? 1 : 0);
  segShow('boltShake', 'shake', b.shake ? 1 : 0);
  segShow('boltType', 'type', boltPane);
  $('boltOwn').classList.toggle('dim', b.follow);
  $('boltLooks').hidden = boltPane !== 'look';
  for (const p of $('boltOwn').querySelectorAll('.pane')) p.hidden = p.dataset.pane !== boltPane;
  for (const [key, el] of boltLookEls) {
    el.classList.toggle('on', !b.follow && b.content.type === 'look' && b.content.key === key);
  }
  const c = b.content;
  if (document.activeElement !== $('boltColor')) $('boltColor').value = hex(c.rgb);
  if (document.activeElement !== $('boltTextColor')) $('boltTextColor').value = hex(c.rgb);
  if (!$('boltText').value) $('boltText').value = c.text;
  $('boltTextSpeed').value = c.speed;
  $('boltTextSpeedOut').textContent = c.speed;
  $('boltSense').value = b.sensitivity;
  $('boltSenseOut').textContent = b.sensitivity;
  $('boltBright').value = b.brightness;
  $('boltBrightOut').textContent = `${b.brightness}%`;
}

// ---------- HAT tab ----------
EFFECTS.forEach((name, i) => $('hatEffect').append(new Option(name.toUpperCase(), i)));
segPick('hatFollow', 'show', (v) => rig.setHat({ follow: v === 'rig', clock: v === 'clock' }, { now: true }));
segPick('hatClockStyle', 'style', (v) => rig.setHat({ clockStyle: v }, { now: true }));
segPick('hatScreen', 'screen', (v) => rig.setHat({ screen: Number(v) }));
segPick('hatLightning', 'lightning', (v) => rig.setHat({ lightning: Number(v) }));
$('hatBright').addEventListener('input', () => rig.setHat({ brightness: Number($('hatBright').value) }));
$('hatEffect').addEventListener('change', () => rig.setHat({ effect: Number($('hatEffect').value) }));
$('hatMs').addEventListener('input', () => {
  $('hatMsOut').textContent = `${$('hatMs').value}ms`;
  rig.setHat({ ms: Number($('hatMs').value) });
});

let hatSrc = null, hatFrames = null, hatFit = 'contain', hatDither = false;
function convertHat() {
  if (!hatSrc) return;
  const { width: w, height: h, frameLimit } = rig.cap.info;
  hatFrames = toHat(hatSrc.slice(0, frameLimit), w, h, { fit: hatFit, dither: hatDither, rgb323, fromRgb323 });
  $('hatInfo').textContent = `${w}×${h}, ${hatFrames.length} frame${hatFrames.length > 1 ? 's' : ''}` +
    (hatSrc.length > frameLimit ? ` (first ${frameLimit})` : '');
  $('hatSend').disabled = false;
  clearInterval(convertHat.t);
  let f = 0;
  paintHat($('hatPreview'), hatFrames[0].px, w, h, fromRgb323);
  if (hatFrames.length > 1) {
    convertHat.t = setInterval(() => {
      f = (f + 1) % hatFrames.length;
      paintHat($('hatPreview'), hatFrames[f].px, w, h, fromRgb323);
    }, rig.state.hat.ms);
  }
}
$('hatFile').addEventListener('change', async () => {
  const file = $('hatFile').files[0];
  if (!file) return;
  try {
    hatSrc = await decodeImage(file, rig.cap.info.frameLimit);
    // A GIF brings its own timing; use it as the starting frame time.
    if (hatSrc.length > 1) rig.setHat({ ms: Math.round(hatSrc[0].ms / 20) * 20 || 100 });
    convertHat();
  } catch (err) {
    showBanner(`Couldn't read that image: ${err.message}`);
  }
});
segPick('hatFit', 'fit', (f) => { hatFit = f; segShow('hatFit', 'fit', f); convertHat(); });
segPick('hatDither', 'dither', (v) => { hatDither = v === '1'; segShow('hatDither', 'dither', v); convertHat(); });
segShow('hatFit', 'fit', hatFit);
segShow('hatDither', 'dither', '0');
$('hatSend').addEventListener('click', () => {
  if (!rig.cap.available) return showBanner('Pick the hat first (tap the Hat chip).');
  if (hatFrames) rig.setHatImage(hatFrames);
});
rig.cap.addEventListener('progress', (e) => {
  $('hatBar').style.width = `${Math.round(e.detail * 100)}%`;
  $('hatSend').classList.toggle('busy', e.detail < 1);
});
rig.cap.addEventListener('info', () => convertHat());

function renderHat(h) {
  segShow('hatFollow', 'show', h.clock ? 'clock' : h.follow ? 'rig' : 'own');
  segShow('hatClockStyle', 'style', h.clockStyle);
  $('hatClock').hidden = !h.clock;
  segShow('hatScreen', 'screen', h.screen);
  segShow('hatLightning', 'lightning', h.lightning);
  $('hatOwn').classList.toggle('dim', h.follow || h.clock);
  $('hatEffect').value = h.effect;
  $('hatMs').value = h.ms;
  $('hatMsOut').textContent = `${h.ms}ms`;
  $('hatBright').value = h.brightness;
  $('hatBrightOut').textContent = `${h.brightness}%`;
}

// ---------- hack / purge ----------
$('purge').addEventListener('click', () => rig.purge());
function flashLocked() {
  const a = $('alert');
  a.classList.remove('shake');
  void a.offsetWidth; // restart the animation
  a.classList.add('shake');
}

// ---------- power ----------
const asleep = (p) => p === POWER.STANDBY || p === POWER.OFF;
$('standby').addEventListener('click', () => {
  if (asleep(rig.state.power)) rig.wake();
  else rig.standby();
});
// Shut down needs a second tap within 3 s, so a stray tap can't kill the rig.
let offArmed = null;
$('off').addEventListener('click', () => {
  const b = $('off');
  if (offArmed) {
    clearTimeout(offArmed);
    offArmed = null;
    b.classList.remove('armed');
    rig.shutDown();
    render(rig.state);
    return;
  }
  b.classList.add('armed');
  b.textContent = 'TAP TO CONFIRM';
  offArmed = setTimeout(() => {
    offArmed = null;
    b.classList.remove('armed');
    render(rig.state);
  }, 3000);
});

// ---------- render ----------
const POWER_LABEL = { [POWER.WAKING]: 'BOOTING', [POWER.STANDBY]: 'STANDBY', [POWER.OFF]: 'OFFLINE' };

function render(s) {
  const m = modeOf(s);
  const tc = tuneOf(s, m.key).colors[0];
  const accent = s.hacked ? '#FF1E1E' : m.breathe ? hex(s.pair[0]) : tc ? hex(tc) : m.color;
  document.documentElement.style.setProperty('--accent', accent);
  document.body.classList.toggle('hacked', s.hacked);
  document.body.classList.toggle('asleep', asleep(s.power));

  $('current').textContent = s.hacked ? 'HACKED' : POWER_LABEL[s.power] || m.name.toUpperCase();

  for (const [k, el] of Object.entries(tabEls)) el.classList.toggle('on', k === s.set);
  buildTiles(s.set);
  tileEls.forEach((el, i) => el.classList.toggle('active', i === s.idx[s.set] && s.power === POWER.ON));
  tileEls.forEach((el, i) => {                // tiles show the tuned colours
    const m = SETS[s.set].modes[i], t = tuneOf(s, m.key);
    if (t.colors[0]) el.style.setProperty('--c', hex(t.colors[0]));
    if (t.colors[1]) el.style.setProperty('--c2', hex(t.colors[1]));
  });

  const showBreathe = s.set === 'alt' && s.idx.alt === BREATHE_IDX;
  $('rbpanel').hidden = !(s.set === 'alt' && s.idx.alt === RAINBOW_IDX);
  $('hackpanel').hidden = !(s.set === 'alt' && s.idx.alt === HACK_IDX);
  renderHackTimer(s.hackTimer);
  segShow('mute', 'muted', s.muted ? 1 : 0);
  segShow('showCmd', 'show', s.showCmd ? 1 : 0);
  renderTune(s);
  if (document.activeElement !== $('rbSpeed')) $('rbSpeed').value = s.rainbow.speed;
  if (document.activeElement !== $('rbWidth')) $('rbWidth').value = s.rainbow.width;
  paintRainbow(s.rainbow);
  $('breathe').hidden = !showBreathe;
  paintPair(s.pair);
  if (document.activeElement !== $('c1')) $('c1').value = hex(s.pair[0]);
  if (document.activeElement !== $('c2')) $('c2').value = hex(s.pair[1]);

  $('alert').hidden = !s.hacked;

  renderBolt(s.bolt);
  renderHat(s.hat);

  $('standby').textContent = asleep(s.power) ? 'WAKE' : 'STANDBY';
  $('standby').classList.toggle('on', asleep(s.power));
  if (!offArmed) $('off').textContent = s.power === POWER.OFF ? 'OFF' : 'SHUT DOWN';
  $('off').disabled = s.power === POWER.OFF;
}
rig.addEventListener('change', (e) => render(e.detail));
render(rig.state);

// ---------- device status ----------
const statusEls = {};
function chip(key, label, onTap) {
  const el = document.createElement('button');
  el.className = 'dev';
  el.dataset.s = 'idle';
  el.innerHTML = `<span class="dot"></span><span>${label}</span>`;
  if (onTap) el.addEventListener('click', onTap);
  $('status').append(el);
  statusEls[key] = el;
  return el;
}

chip('clue', 'CLUE', () => pick(rig.clue));
chip('maskL', 'Mask L');
chip('maskR', 'Mask R');
chip('cap', 'Hat', () => pick(rig.cap));
chip('bolt', 'BOLT', () => pick(rig.bolt));

for (const d of rig.devices) {
  d.addEventListener('status', (e) => {
    statusEls[d.key].dataset.s = e.detail.status;
    updateConnect();
    if (d === rig.clue) updateMask();
  });
}

function updateMask() {
  for (const side of ['L', 'R']) {
    statusEls['mask' + side].dataset.s =
      !rig.clue.connected ? 'idle' : rig.clue.mask[side] ? 'connected' : 'lost';
  }
}
rig.clue.addEventListener('mask', updateMask);
rig.clue.addEventListener('refused', (e) => {
  if (e.detail === 'locked') flashLocked();
  else if (e.detail === 'asleep') showBanner('The rig is in standby. Tap WAKE first.');
});

// ---------- connecting ----------
async function pick(d) {
  if (!navigator.bluetooth) return;
  try {
    await d.pick();
  } catch (err) {
    if (err.name !== 'NotFoundError') showBanner(`${d.label}: ${err.message}`); // NotFound = picker cancelled
  }
}

function updateConnect() {
  const btn = $('connect');
  const next = rig.nextUnconnected();
  if (!next) {
    btn.textContent = 'ALL LINKED';
    btn.disabled = true;
    return;
  }
  // The CLUE is the one that matters; cap + BOLT are optional extras.
  btn.textContent = `CONNECT ${next.label.toUpperCase()}`;
  btn.disabled = false;
}

// Chrome needs a fresh tap for each device picker, so Connect steps through them.
$('connect').addEventListener('click', () => {
  const next = rig.nextUnconnected();
  if (next) pick(next);
});

function showBanner(msg) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = false;
  clearTimeout(showBanner.t);
  showBanner.t = setTimeout(() => (b.hidden = true), 6000);
}

// ---------- startup ----------
if (!navigator.bluetooth) {
  const b = $('banner');
  b.textContent = 'Web Bluetooth is not available. Open this page in Chrome (Android or desktop), over HTTPS.';
  b.hidden = false;
  $('connect').disabled = true;
} else {
  updateConnect();
  rig.restoreAll().then(updateConnect);
}

// Keep the screen on while the controller is open.
async function holdWake() {
  try { await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') holdWake();
});
holdWake();

export { rig, Status };
