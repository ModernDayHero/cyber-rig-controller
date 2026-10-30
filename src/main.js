import './style.css';
import { SETS, HACK_TIMER, RAINBOW, POWER, TUNE, hex, rgb, modeOf, tuneOf } from './config.js';
import { PICS, MINE, lookup, indexed, addPic, removePic, picId } from './library.js';
import { Rig } from './rig.js';
import { decodeImage, toBolt, toHat, toPic, paintPreview, paintHat } from './image.js';
import { EFFECTS, rgb323, fromRgb323 } from './ble/spotled.js';
import { Status } from './ble/device.js';
import { setupDrive } from './drive.js';
import { GuestHost, GUEST_MINUTES, DEFAULT_RELAY, showCode } from './guests.js';
import { setupBadge } from './badgetab.js';
import { ascii, LANGS } from './i18n.js';
import qrcode from 'qrcode-generator';

const $ = (id) => document.getElementById(id);
const rig = new Rig();
setupDrive(rig, $);

// Segmented buttons: wire a data-* value to fn / light the one that matches.
const segPick = (id, attr, fn) => {
  for (const b of $(id).querySelectorAll('button')) b.addEventListener('click', () => fn(b.dataset[attr]));
};
const segShow = (id, attr, val) => {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === String(val));
};

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
      if (!rig.setMode(setKey, i)) refused();
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

// ---------- SET tab, PATTERNS: a fold per pattern with its brightness + colours ----------
// (Rainbow and Rebreather keep their own controls in theirs.) Built once; renderPatterns
// fills in the values.
const patternEls = {};
const seenKeys = new Set();
// The virus isn't a pattern you pick any more, but its colours live in its own fold (VIRUS).
for (const m of [...Object.values(SETS).flatMap((st) => st.modes), { key: 'H', name: 'Virus' }]) {
  const key = m.key, d = TUNE[key];
  if (!d || seenKeys.has(key)) continue;
  seenKeys.add(key);
  const fold = document.createElement('details');
  fold.className = 'fold';
  fold.dataset.fold = key;
  const sum = document.createElement('summary');
  const dot = document.createElement('span');
  dot.className = 'dot';
  sum.append(dot, m.name.toUpperCase());
  const body = document.createElement('div');
  body.className = 'fold-body';

  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<span class="label">BRIGHT</span><input type="range" min="10" max="100" step="5" /><output></output>';
  const [range, out] = [row.querySelector('input'), row.querySelector('output')];
  range.addEventListener('input', () => {
    out.textContent = `${range.value}%`;
    rig.setTune(key, { bright: Number(range.value) });
  });
  body.append(row);

  const swatches = d.labels.map((label, i) => {
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
    return inp;
  });
  if (swatches.length) {
    const box = document.createElement('div');
    box.className = 'tunecolors';
    box.append(...swatches.map((inp) => inp.parentElement));
    body.append(box);
  }
  if (key === 'R') { $('rbpanel').hidden = false; body.append($('rbpanel')); }
  if (key === 'B') { $('breathe').hidden = false; body.append($('breathe')); }
  if (key === 'r') {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = 'Hat lightning strikes: SET → HAT → BOLTS.';
    body.append(h);
  }
  const reset = document.createElement('button');
  reset.className = 'ghost reset';
  reset.textContent = 'RESET TO DEFAULT';
  reset.addEventListener('click', () => rig.resetTune(key));
  body.append(reset);

  fold.append(sum, body);
  if (key === 'H') $('virusBody').append(...body.childNodes);   // inside the VIRUS fold
  else $('patternFolds').append(fold);
  patternEls[key] = { fold, dot, range, out, swatches, reset };
}
function renderPatterns(s) {
  for (const [key, el] of Object.entries(patternEls)) {
    const t = tuneOf(s, key);
    const c = key === 'B' ? s.pair[0] : t.colors[0];
    el.dot.style.background = key === 'R' ? 'linear-gradient(90deg,#ff1e1e,#22ff66,#00e5ff,#a03cff)' : c ? hex(c) : '#888';
    if (document.activeElement !== el.range) el.range.value = t.bright;
    el.out.textContent = `${t.bright}%`;
    el.swatches.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = hex(t.colors[i]); });
    el.reset.disabled = !s.tunes[key];
  }
}
// RIG tab shortcut: straight to the current pattern's fold.
$('tuneLink').addEventListener('click', () => {
  const m = modeOf(rig.state), el = patternEls[m.lookAs && !TUNE[m.key] ? m.lookAs : m.key];
  showView('set');
  if (el) {
    el.fold.open = true;
    el.fold.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});

// ---------- the virus (SET tab): release it now, how often it hijacks on its own ----------
$('hackNow').addEventListener('click', () => { if (!rig.hack()) refused(); });
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
const alertText = () => ascii($('alertText').value).toUpperCase().replace(/\s+/g, ' ').trim();
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
    MODE_CMDS[m.name.toLowerCase().replace(/[^a-z0-9]/g, '')] = () => { if (!rig.setMode(set, i)) refused(); };
  });
}
MODE_CMDS.audio = MODE_CMDS.vu;
const SLASH = {
  ...MODE_CMDS,
  hack: () => { if (!rig.hack()) refused(); },   // the HACK mode is the virus: same thing
  purge: () => rig.purge(),
};
const LISTED = ['/hack', '/purge', ...Object.keys(PICS).filter((id) => PICS[id].cmd !== false).map((id) => '/' + id),
  ...Object.keys(MODE_CMDS).filter((n) => n !== 'audio').map((n) => '/' + n)].join(' ');

// IMAGE tab text box: a /command runs (a mode, /hack, /purge); a picture word (with or without the /)
// shows its picture; any other word shows as text; an unknown /word gets the "?".
function say() {
  const v = $('alertText').value.trim();
  if (!v) return;
  const slash = v.startsWith('/'), body = slash ? v.slice(1) : v;
  const run = slash && SLASH[body.split(/\s+/)[0].toLowerCase()];
  const pic = !run && lookup(body);
  if (run) run();
  else if (pic) rig.showPic(pic, v);
  else if (slash) {
    rig.showPic(PICS.huh, v);
    showBanner(`Unknown command ${v}. Try ${LISTED}`);
  } else rig.sayText(v);
  $('alertText').value = '';
}
$('alertText').addEventListener('keydown', (e) => { if (e.key === 'Enter') say(); });
$('sayGo').addEventListener('click', say);

// The picture library, one button each, drawn from the same art the CLUE gets. Your
// saved pictures come first, with an x to delete them.
function picCanvas(p) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d'), { palette, rows } = indexed(p);
  rows.forEach((r, y) => r.forEach((v, x) => { if (v) { g.fillStyle = palette[v]; g.fillRect(x, y, 1, 1); } }));
  return cv;
}
function buildPics() {
  const mine = [...MINE.values()], built = Object.values(PICS).filter((p) => p.cmd !== false && !MINE.has(p.id));
  $('picGrid').replaceChildren(...[...mine, ...built].map((p) => {
    const b = document.createElement('button');
    const label = document.createElement('span');
    label.textContent = p.id.toUpperCase();
    b.append(picCanvas(p), label);
    b.setAttribute('aria-label', `Show ${p.id}`);
    b.addEventListener('click', () => rig.showPic(p));
    if (MINE.has(p.id)) {
      b.classList.add('mine');
      const x = document.createElement('span');
      x.className = 'del';
      x.textContent = '×';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', `Delete ${p.id}`);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete ${p.id.toUpperCase()} from the library?`)) return;
        removePic(p.id);
        buildPics();
      });
      b.append(x);
    }
    return b;
  }));
}
buildPics();

// ---------- new picture: upload -> 16x16 library picture (CLUE, hat, BOLT) ----------
let picSrc = null, picFit = 'contain', picNew = null;
$('picMask').append(new Option('KEEP ITS MODE', '-'),
  ...Object.values(SETS).flatMap((s) => s.modes)
    .filter((m) => m.key !== 'H' && m.key !== 'W')
    .map((m) => new Option(m.name.toUpperCase(), m.key)));
const clean = (v) => ascii(v).toUpperCase().replace(/\s+/g, ' ').trim();
function picFromForm() {
  if (!picNew) return null;
  const name = $('picName').value.trim(), id = picId(name);
  return { id, words: [name], caption: clean($('picCaption').value), mask: $('picMask').value,
    sound: 'm', ...picNew };
}
function renderPicForm() {
  const ok = !!picNew;
  $('picShow').disabled = !ok;
  $('picSave').disabled = !ok || !picId($('picName').value);
  $('picSave').textContent = MINE.has(picId($('picName').value)) ? 'REPLACE IN LIBRARY' : 'SAVE TO LIBRARY';
}
function convertPic() {
  if (!picSrc) return;
  picNew = toPic(picSrc, picFit);
  const { palette, rows } = indexed(picNew);
  paintPreview($('picPreview'), rows, (i) => rgb(palette[i]));
  $('picInfo').textContent = `16×16, ${palette.length - 1} colour${palette.length === 2 ? '' : 's'}`;
  renderPicForm();
}
$('picFile').addEventListener('change', async () => {
  const file = $('picFile').files[0];
  if (!file) return;
  try {
    [{ image: picSrc }] = await decodeImage(file, 1);
    if (!$('picName').value) $('picName').value = file.name.replace(/\.[^.]*$/, '').slice(0, 16);
    convertPic();
  } catch (err) {
    showBanner(`Couldn't read that image: ${err.message}`);
  }
});
segPick('picFit', 'fit', (f) => { picFit = f; segShow('picFit', 'fit', f); convertPic(); });
segShow('picFit', 'fit', picFit);
$('picName').addEventListener('input', renderPicForm);
$('picShow').addEventListener('click', () => {
  const p = picFromForm();
  if (p) rig.showPic({ ...p, id: p.id || 'pic' });
});
$('picSave').addEventListener('click', () => {
  const p = picFromForm();
  if (!p?.id) return;
  if (!addPic(p)) return showBanner("The phone's storage is full: delete a picture first.");
  buildPics();
  renderPicForm();
  showBanner(`${p.id.toUpperCase()} saved. Type ${p.id} (or /${p.id}) to show it.`);
});

// ---------- views: RIG / BOLT / HAT / BADGE / IMAGE / SET ----------
const VIEW_KEY = 'rig-view', VIEWS = ['rig', 'bolt', 'hat', 'badge', 'image', 'set'];
let view = localStorage.getItem(VIEW_KEY);
if (!VIEWS.includes(view)) view = view === 'say' ? 'image' : 'rig';
function showView(v) {
  view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch {}
  for (const b of $('views').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === v);
  for (const k of VIEWS) $(`view-${k}`).hidden = k !== v;
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
// CLOCK puts the whole rig in WATCH: the CLUE's clock face and the hat's clock together.
segPick('hatFollow', 'show', (v) => {
  if (v === 'clock') { if (!rig.watch()) flashLocked(); } else rig.setHat({ follow: v === 'rig' }, { now: true });
});
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
  const clock = h.follow && rig.watching();
  segShow('hatFollow', 'show', clock ? 'clock' : h.follow ? 'rig' : 'own');
  segShow('hatClockStyle', 'style', h.clockStyle);
  $('hatClock').hidden = !clock;
  segShow('hatScreen', 'screen', h.screen);
  segShow('hatLightning', 'lightning', h.lightning);
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
// A command the rig turned down: hacked (the alert shakes) or the FIREWALL is up.
function refused() {
  if (rig.locked) flashLocked();
  else if (rig.state.sandbox) showBanner('FIREWALL engaged: the virus is shut out. Flip FIREWALL off to let it loose.');
}
$('fwSwitch').addEventListener('click', () => rig.setSandbox(!rig.state.sandbox));

// ---------- GUESTS: friends jack in from their own phones (guests.js) ----------
// "Wanna edgerun?" -> INVITE: a one-time password + the guest QR. They're in when they
// type it; DISCONNECT ends it, PWN ends it with a show on their screen.
const host = new GuestHost(rig);
$('guestSwitch').addEventListener('click', () => {
  if (!host.enabled) return host.enable();
  if (confirm('Turn GUESTS off? Everyone is disconnected and unused passwords stop working.')) host.disable();
});
GUEST_MINUTES.forEach((m) => {
  const b = document.createElement('button');
  b.textContent = `${m} MIN`;
  b.dataset.min = m;
  b.addEventListener('click', () => host.setMinutes(m));
  $('guestTime').append(b);
});
let shownInvite = null;
function openInvite() {
  shownInvite = host.invite();
  const qr = qrcode(0, 'M');
  qr.addData(host.link);
  qr.make();
  $('inviteQr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
  $('inviteCode').textContent = showCode(shownInvite.code);
  $('inviteOpen').href = host.link;           // this phone / PC: a guest tab, for testing
  tickInvite();
  if (!$('invite').open) $('invite').showModal();
  badgeTab?.sendInvite(shownInvite);          // and on the badge, if it's linked
}
function tickInvite() {
  if (!shownInvite || !$('invite').open) return;
  const used = !host.invites.includes(shownInvite);
  $('inviteLeft').textContent = used ? 'USED: they’re in. Tap NEW for the next one.'
    : `one phone · valid ${mmss(shownInvite.until - Date.now())}`;
  $('invite').classList.toggle('used', used);
}
$('inviteBtn').addEventListener('click', openInvite);
$('inviteBtn2').addEventListener('click', openInvite);
$('inviteNew').addEventListener('click', openInvite);
$('guestRelay').value = host.relay;
$('guestRelay').addEventListener('change', () => {
  const v = $('guestRelay').value.trim() || DEFAULT_RELAY;
  if (v === host.relay) return;
  if (!confirm('Switch the guest relay? Everyone is disconnected and the QR changes (resend the badge).')) {
    $('guestRelay').value = host.relay;
    return;
  }
  if (!host.setRelay(v)) {
    showBanner('The relay needs a full https:// address of an ntfy server.');
    $('guestRelay').value = host.relay;
  }
});
$('guestNewLink').addEventListener('click', () => {
  if (confirm('Make a new guest link? Everyone is disconnected and old QR codes (the badge’s too) stop working.')) host.newLink();
});
$('inviteClose').addEventListener('click', () => $('invite').close());

// PWN signs it with the badge's callsign.
const callsign = () => { try { return JSON.parse(localStorage.getItem('rig-badge'))?.callsign; } catch { return null; } };

const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
function gItem(cls, who, sub, ...buttons) {
  const row = document.createElement('div');
  row.className = 'gitem ' + cls;
  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  if (sub) { const s = document.createElement('small'); s.textContent = sub; w.append(s); }
  row.append(w);
  for (const [label, kind, fn] of buttons) {
    const b = document.createElement('button');
    b.className = kind;
    b.textContent = label;
    b.addEventListener('click', fn);
    row.append(b);
  }
  return row;
}
const left = (until) => mmss(until - Date.now()) + ' left';
function renderGuests() {
  $('guestSwitch').setAttribute('aria-checked', String(host.enabled));
  $('guestbar').hidden = !host.enabled;
  segShow('guestTime', 'min', host.minutes);
  if (!host.enabled) { $('guestList').replaceChildren(); return; }
  const n = host.guests.size;
  $('guestCount').textContent = n ? `${n} RUNNER${n > 1 ? 'S' : ''} JACKED IN` : 'PORT OPEN';
  const rows = [];
  for (const v of host.invites) {
    const r = gItem('pending', `PASS ${showCode(v.code)}`, left(v.until), ['REVOKE', 'ghost', () => host.revokeInvite(v.code)]);
    r.dataset.until = v.until;
    rows.push(r);
  }
  for (const [g, x] of host.guests) {
    const tag = LANGS.find((l) => l.code === x.lang)?.label || 'EN';
    const r = gItem(x.full ? 'full' : '', `${x.name} · ${tag}${x.full ? ' · FULL' : ''}`, left(x.until),
      ['DISCONNECT', 'ghost', () => host.kick(g)],
      ['PWN', 'pwn', () => host.pwn(g, callsign())]);
    r.dataset.until = x.until;
    rows.push(r);
  }
  for (const q of host.queue) {
    const name = host.guests.get(q.g)?.name || 'GUEST';
    const r = gItem('ask', q.kind === 'up' ? `${name}: ${q.pic.caption || 'a picture'}` : `${name}: “${q.text}”`,
      q.kind === 'up' ? 'sent a picture' : 'wants to show a word',
      ['SHOW', 'yes', () => host.decide(q.n, true)], ['BLOCK', 'ghost', () => host.decide(q.n, false)]);
    if (q.kind === 'up') r.prepend(picCanvas(q.pic));
    rows.push(r);
  }
  if (host.board.length) {
    const top = document.createElement('div');
    top.className = 'gboard';
    top.textContent = 'TOP DEBUGGERS  ' + host.board.slice(0, 3).map((b, i) => `${i + 1}. ${b.name} ${mmss(b.ms)}`).join('   ');
    rows.push(top);
  }
  $('guestList').replaceChildren(...rows);
  tickInvite();
}
host.addEventListener('change', renderGuests);
host.addEventListener('tick', () => {        // just the countdowns, so buttons don't jump under a finger
  for (const r of $('guestList').querySelectorAll('[data-until]')) r.querySelector('small').textContent = left(+r.dataset.until);
  tickInvite();
});
renderGuests();
const badgeTab = setupBadge({ rig, host, $, segPick, segShow, showBanner });

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

  renderHackTimer(s.hackTimer);
  $('hackNow').disabled = s.sandbox || s.hacked || s.power !== POWER.ON;
  $('hackTimer').classList.toggle('dim', s.sandbox);
  $('fwSwitch').setAttribute('aria-checked', String(s.sandbox));
  segShow('mute', 'muted', s.muted ? 1 : 0);
  segShow('showCmd', 'show', s.showCmd ? 1 : 0);
  renderPatterns(s);
  { const k = modeOf(s); $('tuneLink').textContent = `TUNE ${k.name.toUpperCase()} ⚙`; }
  if (document.activeElement !== $('rbSpeed')) $('rbSpeed').value = s.rainbow.speed;
  if (document.activeElement !== $('rbWidth')) $('rbWidth').value = s.rainbow.width;
  paintRainbow(s.rainbow);
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
chip('badge', 'Badge', () => pick(rig.badge));

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
