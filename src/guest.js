// guest.html: a friend's phone, from the invite QR (the badge or the owner's phone) and a
// one-time password. No Bluetooth here: everything goes as a request through the relay
// (ntfy) session topic to the owner's deck (guests.js), which decides. Answers come back
// on <topic>-<our id>, rig news on <topic>-all. A PWN from the owner glitches this page
// (only this page: there's nothing else a web page could touch), then says so.
//
// The link: guest.html#<topic>, or #<topic>@<relay host> when the deck uses its own relay.
// The first screen picks the language (i18n.js) and asks for consent.

import './style.css';
import { SETS } from './config.js';
import { PICS, indexed } from './library.js';
import { decodeImage, toPic, paintPreview } from './image.js';
import { DEFAULT_RELAY } from './guests.js';
import { LANGS, guessLang, words } from './i18n.js';

const $ = (id) => document.getElementById(id);
const [topic, relayHost] = location.hash.slice(1).split('@');
const RELAY = relayHost && /^[a-z0-9.-]+(:\d+)?$/i.test(relayHost) ? `https://${relayHost}` : DEFAULT_RELAY;
const ME_KEY = `rig-guest-${topic}`;
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (v) => (v % 36).toString(36)).join('');
const COOL_MS = 1500;                 // the deck ignores faster than ~1.2 s anyway

let me = {};
try { me = JSON.parse(sessionStorage.getItem(ME_KEY)) || {}; } catch {}
me.g ||= rand(16);
me.lang ||= guessLang();
const saveMe = () => { try { sessionStorage.setItem(ME_KEY, JSON.stringify(me)); } catch {} };
saveMe();

// ---------- language ----------
let t = words(me.lang);
let stateKey = 'stOffline';
function applyLang() {
  t = words(me.lang);
  document.documentElement.lang = me.lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n];
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t[el.dataset.i18nPh];
  for (const b of $('gLang').children) b.classList.toggle('on', b.dataset.lang === me.lang);
  $('gState').textContent = t[stateKey] ?? stateKey;
  renderNews();
}
$('gLang').append(...LANGS.map(({ code, label }) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.lang = code;
  b.lang = code;
  b.addEventListener('click', () => { me.lang = code; saveMe(); applyLang(); });
  return b;
}));
$('gConsent').addEventListener('change', () => { $('gJoinBtn').disabled = !$('gConsent').checked; });

// ---------- screens ----------
const SCREENS = ['gJoin', 'gWait', 'gPlay', 'gPwn', 'gEnd'];
function screen(id, state) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  stateKey = state;
  $('gState').textContent = t[state] ?? state;
}
function end(why) {
  const [title, text] = t.end[why] || t.end.kicked;
  me.k = null;
  saveMe();
  clearInterval(end.t);
  $('gEndTitle').textContent = title;
  $('gEndWhy').textContent = text;
  $('gAgain').hidden = why === 'link';
  screen('gEnd', 'stOffline');
}

function note(msg, ms = 4000) {
  $('gNote').textContent = msg;
  $('gNote').hidden = false;
  clearTimeout(note.t);
  note.t = setTimeout(() => ($('gNote').hidden = true), ms);
}

// ---------- the link ----------
const post = (msg) => fetch(`${RELAY}/${topic}`, { method: 'POST', body: JSON.stringify({ ...msg, g: me.g, k: me.k }) })
  .catch(() => note(t.noSignal));

let cooling = false;
function act(msg) {
  if (cooling || !me.k) return;
  post(msg);
  cooling = true;
  document.body.classList.add('cooling');
  setTimeout(() => { cooling = false; document.body.classList.remove('cooling'); }, COOL_MS);
}

let news = { fw: false, hacked: false };
function onAnswer(m) {
  switch (m.t) {
    case 'ok':
      Object.assign(me, { k: m.k, until: m.until });
      saveMe();
      play();
      break;
    case 'nope':
      screen('gJoin', 'stOffline');
      $('gJoinNote').hidden = false;
      $('gJoinNote').textContent = m.why === 'pause' ? t.pause : t.denied;
      $('gPass').select();
      break;
    case 'end':
      end(m.why);
      break;
    case 'pwn':
      pwned(m.by);
      break;
    case 'deny':
      note({ firewall: t.denyFirewall, hacked: t.denyHacked, busy: t.denyBusy }[m.why] || t.denied2);
      break;
    case 'res':
      if (m.why === 'script') note(t.script, 6000);
      else note(m.kind === 'up' ? (m.ok ? t.okPic : t.noPic) : (m.ok ? t.okWord : t.noWord));
      break;
    case 'news':
      news = { fw: !!m.fw, hacked: !!m.hacked };
      renderNews();
      break;
  }
}

function listen() {
  const es = new EventSource(`${RELAY}/${topic}-${me.g},${topic}-all/sse`);
  es.onmessage = (e) => {
    try {
      const n = JSON.parse(e.data);
      if (n.event === 'message') onAnswer(JSON.parse(n.message));
    } catch {}
  };
  return new Promise((ok) => { es.onopen = ok; });
}

// ---------- knocking ----------
async function join(again = false) {
  const name = $('gName').value.trim() || me.name || '';
  const p = $('gPass').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!name) return $('gName').focus();
  if (!again && (p.length !== 6 || !$('gConsent').checked)) return $('gPass').focus();
  me.name = name;
  saveMe();
  $('gJoinNote').hidden = true;
  screen('gWait', 'stKnocking');
  $('gWaitHint').textContent = t.checking;
  await opened;
  post({ t: 'join', name, p, lang: me.lang });
  clearTimeout(join.t);
  join.t = setTimeout(() => {
    if (!$('gWait').hidden) {
      $('gWaitHint').textContent = t.noAnswer;
      setTimeout(() => !$('gWait').hidden && screen('gJoin', 'stOffline'), 4000);
    }
  }, 20000);
}
$('gJoinBtn').addEventListener('click', () => join());
$('gName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('gPass').focus(); });
$('gPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('gPass').addEventListener('input', () => {        // ABC-DEF as they type
  const v = $('gPass').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  $('gPass').value = v.length > 3 ? `${v.slice(0, 3)}-${v.slice(3)}` : v;
});
$('gAgain').addEventListener('click', () => screen('gJoin', 'stOffline'));

// ---------- in ----------
function play() {
  screen('gPlay', 'stIn');
  clearInterval(end.t);
  const tick = () => {
    const s = Math.max(0, Math.ceil((me.until - Date.now()) / 1000));
    $('gTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (!s) end('time');
  };
  tick();
  end.t = setInterval(tick, 1000);
  renderNews();
}
$('gLeave').addEventListener('click', () => { post({ t: 'bye' }); end('left'); });

// ---------- PWNED ----------
// About 7 s of this page falling apart: the controls glitch, a fake "exfiltration" log
// scrolls, I PWNED YOU, then the reveal (end('pwned')) in their language: only this page.
const PWN_LINES = [
  '> cert revoked by host', '> injecting octlet.exe ........ OK', '> rerouting your handle ...... OK',
  '> copying selfies ............ 37%', '> copying selfies ............ 88%',
  '> uploading to the cyber rig .. OK', '> just kidding.',
];
function pwned(by) {
  me.k = null;
  saveMe();
  clearInterval(end.t);
  document.body.classList.add('glitching');
  try { navigator.vibrate?.([80, 60, 80, 60, 300]); } catch {}
  setTimeout(() => {
    screen('gPwn', '0WN3D');
    $('gPwnBy').textContent = `by ${by || 'THE RIG'}`;
    $('gPwnLog').textContent = '';
    PWN_LINES.forEach((l, i) => setTimeout(() => { $('gPwnLog').textContent += l + '\n'; }, i * 450));
  }, 1600);
  setTimeout(() => {
    document.body.classList.remove('glitching');
    end('pwned');
  }, 8000);
}

function renderNews() {
  $('gHack').disabled = news.fw;
  $('gHack').textContent = news.fw ? t.fwOn : t.hackAll;
  $('gHackHint').textContent = news.fw ? t.fwHint : news.hacked ? t.hackedHint : t.hackHint;
  document.body.classList.toggle('hacked', news.hacked);
}

// Mode tiles, both sets, like the deck's (names stay as the rig calls them).
let gSet = 'os';
function buildModes() {
  $('gTabs').replaceChildren(...Object.entries(SETS).map(([key, set]) => {
    const b = document.createElement('button');
    b.textContent = set.label;
    b.classList.toggle('on', key === gSet);
    b.addEventListener('click', () => { gSet = key; buildModes(); });
    return b;
  }));
  $('gModes').replaceChildren(...SETS[gSet].modes.map((m, i) => {
    const b = document.createElement('button');
    b.className = 'mode' + (m.rainbow ? ' rainbow' : '') + (m.alt ? ' duo' : '');
    b.style.setProperty('--c', m.color);
    if (m.alt) b.style.setProperty('--c2', m.alt);
    b.innerHTML = `<span class="name"></span><span class="hint"></span><span class="bar"></span>`;
    b.querySelector('.name').textContent = m.name;
    b.querySelector('.hint').textContent = m.hint;
    b.addEventListener('click', () => {
      act({ t: 'mode', set: gSet, i });
      for (const el of $('gModes').children) el.classList.toggle('active', el === b);
    });
    return b;
  }));
}
buildModes();

$('gHack').addEventListener('click', () => act({ t: 'hack' }));

function say() {
  const text = $('gText').value.trim();
  if (!text || !me.k) return;
  act({ t: 'say', text });
  $('gText').value = '';
  note(t.sentWord);
}
$('gSay').addEventListener('click', say);
$('gText').addEventListener('keydown', (e) => { if (e.key === 'Enter') say(); });

for (const p of Object.values(PICS)) {
  if (p.cmd === false) continue;
  const b = document.createElement('button');
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d'), { palette, rows } = indexed(p);
  rows.forEach((r, y) => r.forEach((v, x) => { if (v) { g.fillStyle = palette[v]; g.fillRect(x, y, 1, 1); } }));
  const label = document.createElement('span');
  label.textContent = p.id.toUpperCase();
  b.append(cv, label);
  b.addEventListener('click', () => act({ t: 'pic', id: p.id }));
  $('gPics').append(b);
}

let upPic = null;
$('gUpFile').addEventListener('change', async () => {
  const file = $('gUpFile').files[0];
  if (!file) return;
  try {
    const [{ image }] = await decodeImage(file, 1);
    upPic = toPic(image);
    const { palette, rows } = indexed(upPic);
    paintPreview($('gUpPreview'), rows, (i) => [1, 3, 5].map((j) => parseInt(palette[i].slice(j, j + 2), 16)));
    $('gUpSend').disabled = false;
  } catch {
    note(t.badImage);
  }
});
$('gUpSend').addEventListener('click', () => {
  if (!upPic) return;
  act({ t: 'up', ...upPic, caption: $('gUpCaption').value });
  note(t.sentPic);
});

// ---------- start ----------
let opened;
applyLang();
if (!/^cd[a-z0-9]{20}$/.test(topic)) {
  end('link');
} else {
  opened = listen();
  if (me.k && me.name) {               // a reload while in: knock again, the deck re-admits
    $('gName').value = me.name;
    join(true);
  } else {
    if (me.name) $('gName').value = me.name;
    screen('gJoin', 'stOffline');
  }
}
