import './style.css';
import { MODES, HUNT_STYLES, POWER } from './config.js';
import { Rig } from './rig.js';
import { Status } from './ble/device.js';

const $ = (id) => document.getElementById(id);
const rig = new Rig();

// ---------- mode buttons ----------
const modeEls = MODES.map((m) => {
  const b = document.createElement('button');
  b.className = 'mode' + (m.rainbow ? ' rainbow' : '') + (m.id === 1 ? ' glitch' : '') + (m.id === 5 ? ' peace' : '');
  b.style.setProperty('--c', m.color);
  b.innerHTML = `<span class="num">M${m.id}</span><span class="name">${m.name}</span><span class="bar"></span>`;
  b.addEventListener('click', () => rig.setMode(m.id));
  $('modes').append(b);
  return b;
});

// ---------- hunt toggle ----------
const huntEls = HUNT_STYLES.map((h) => {
  const b = document.createElement('button');
  b.textContent = h.name;
  b.addEventListener('click', () => rig.setHunt(h.id));
  $('huntSeg').append(b);
  return b;
});

// ---------- brightness ----------
const bright = $('bright');
bright.addEventListener('input', () => {
  $('brightOut').textContent = `${bright.value}%`;
  rig.setBrightness(Number(bright.value));
});

// ---------- standby ----------
$('standby').addEventListener('click', () => {
  rig.setPower(rig.state.power === POWER.STANDBY ? POWER.AWAKE : POWER.STANDBY);
});

// ---------- render ----------
function render(s) {
  const m = MODES[s.mode];
  const accent = m.rainbow ? '#00E5FF' : m.color;
  document.documentElement.style.setProperty('--accent', accent);
  $('current').textContent = s.power === POWER.STANDBY ? 'STANDBY' : m.name.toUpperCase();
  modeEls.forEach((el, i) => el.classList.toggle('active', i === s.mode && s.power !== POWER.STANDBY));
  huntEls.forEach((el, i) => el.classList.toggle('on', i === s.hunt));
  $('hunt').classList.toggle('off', s.mode !== 2);
  bright.value = s.brightness;
  $('brightOut').textContent = `${s.brightness}%`;
  $('standby').classList.toggle('on', s.power === POWER.STANDBY);
  $('standby').textContent = s.power === POWER.STANDBY ? 'WAKE' : 'STANDBY';
}
rig.addEventListener('change', (e) => render(e.detail));
render(rig.state);

// ---------- device status ----------
const statusEls = {};
function card(key, label, onTap) {
  const el = document.createElement('button');
  el.className = 'dev';
  el.dataset.s = 'idle';
  el.innerHTML = `<span class="dot"></span><span>${label}</span>`;
  if (onTap) el.addEventListener('click', onTap);
  $('status').append(el);
  statusEls[key] = el;
  return el;
}

for (const d of rig.devices) {
  card(d.key, d.label, () => pick(d));
  d.addEventListener('status', (e) => {
    statusEls[d.key].dataset.s = e.detail.status;
    updateConnect();
    if (d === rig.clue) updateMask();
  });
}
card('mask', 'Mask');

function updateMask() {
  const { L, R } = rig.clue.mask;
  const el = statusEls.mask;
  if (!rig.clue.connected) el.dataset.s = 'idle';
  else el.dataset.s = L && R ? 'connected' : L || R ? 'partial' : 'lost';
  el.querySelector('span:last-child').textContent = L && !R ? 'Mask L' : R && !L ? 'Mask R' : 'Mask';
}
rig.clue.addEventListener('mask', updateMask);

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
  const total = rig.devices.length;
  const next = rig.nextUnconnected();
  if (!next) {
    btn.textContent = 'ALL LINKED';
    btn.disabled = true;
    return;
  }
  const n = rig.devices.indexOf(next) + 1;
  btn.textContent = `CONNECT ${next.label.toUpperCase()} ${n}/${total}`;
  btn.disabled = false;
}

// Chrome needs a fresh tap for each device picker, so Connect all steps through them.
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
  b.textContent = 'Web Bluetooth is not available. Open this page in Chrome on Android, over HTTPS.';
  b.hidden = false;
  $('connect').disabled = true;
} else {
  updateConnect();
  rig.restoreAll().then(updateConnect);
}

// Keep the screen on while the controller is open.
let wakeLock = null;
async function holdWake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') holdWake();
});
holdWake();

export { rig, Status };
