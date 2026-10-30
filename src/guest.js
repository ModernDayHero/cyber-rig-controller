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

// Who we are on this rig, kept on this phone (closing the tab doesn't lose it): our id, the
// certificate token while it's good, the handle, the language.
let me = {};
try { me = JSON.parse(localStorage.getItem(ME_KEY)) || {}; } catch {}
me.g ||= rand(16);
me.lang ||= guessLang();
const saveMe = () => { try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch {} };
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
  renderAccess();
  buildModes();
}
// What's theirs: each section has a permission (data-perm); patterns / hack / drive are
// also the operator's only, one guest at a time (turns, guests.js).
const TURN_PERMS = new Set(['modes', 'hack', 'drive']);
function renderAccess() {
  document.body.classList.toggle('full', !!me.full);
  $('gAccess').textContent = me.full ? t.accessFull : t.accessGuest;
  $('gSkip').hidden = !!me.full;          // nothing left to skip to
  const perms = me.perms || {};
  for (const el of document.querySelectorAll('[data-perm]')) {
    const p = el.dataset.perm, mine = !!perms[p], wait = mine && TURN_PERMS.has(p) && !me.op;
    el.classList.toggle('locked', !mine || wait);
    el.dataset.lock = !mine ? t.lockedHint : wait ? t.waitTurn : '';
  }
  renderTurn();
}
function renderTurn() {
  const el = $('gTurn'), canOperate = [...TURN_PERMS].some((p) => me.perms?.[p]);
  el.hidden = !canOperate || (!me.op && !me.pos);
  el.classList.toggle('op', !!me.op);
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  el.textContent = me.op ? `${t.opYou} · ${mmss(me.turnUntil - Date.now())}`
    : `${t.inLine.replace('{n}', me.pos).replace('{t}', mmss(me.turnAt - Date.now()))}${me.full ? '' : ' · ' + t.moveUp}`;
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
  if (why !== 'left') me.k = null;       // LEAVE keeps the certificate: TRY AGAIN rejoins
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
// -> true if the relay took it. A refusal (busy, over quota, down) says so instead of hanging.
const post = (msg) => fetch(`${RELAY}/${topic}`, { method: 'POST', body: JSON.stringify({ ...msg, g: me.g, k: me.k }) })
  .then((r) => { if (!r.ok) note(t.relayBusy, 6000); return r.ok; })
  .catch(() => { note(t.noSignal); return false; });

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
      Object.assign(me, { k: m.k, until: m.until, full: !!m.full, perms: m.perms || {} });
      saveMe();
      play();
      break;
    case 'full':
      me.full = true;
      if (m.perms) me.perms = m.perms;
      saveMe();
      renderAccess();
      note(t.fullGranted, 6000);
      break;
    case 'perms':                        // the owner changed what's ours
      me.perms = m.perms || {};
      me.full = !!m.full;
      saveMe();
      renderAccess();
      break;
    case 'turn':                         // OPERATOR now, or our place in line
      Object.assign(me, m.op ? { op: true, turnUntil: m.until, pos: 0 } : { op: false, pos: m.pos, turnAt: Date.now() + (m.eta || 0) });
      renderAccess();
      if (m.op) { note(t.opYou, 5000); try { navigator.vibrate?.([60, 40, 60]); } catch {} }
      break;
    case 'breach':
      note(t.breachYou, 6000);
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
      pwned(m.by, m.stay);
      break;
    case 'deny':
      note({ firewall: t.denyFirewall, hacked: t.denyHacked, busy: t.denyBusy, locked: t.lockedHint,
        wheel: t.denyWheel, parked: t.denyParked, turn: t.waitTurn }[m.why] || t.denied2);
      break;
    case 'res':
      if (m.kind === 'skip') note(t.skipDenied, 6000);
      else if (m.why === 'script') note(t.script, 6000);
      else note(m.kind === 'up' ? (m.ok ? t.okPic : t.noPic) : (m.ok ? t.okWord : t.noWord));
      break;
    case 'news':
      news = { fw: !!m.fw, hacked: !!m.hacked, drive: !!m.drive };
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
  if (!await post({ t: 'join', name, p, lang: me.lang })) {
    $('gWaitHint').textContent = t.relayBusy;
    setTimeout(() => !$('gWait').hidden && screen('gJoin', 'stOffline'), 4000);
    return;
  }
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
// TRY AGAIN: straight back in while the certificate is good; else a fresh password.
$('gAgain').addEventListener('click', () => (me.k ? join(true) : screen('gJoin', 'stOffline')));

// ---------- in ----------
function play() {
  screen('gPlay', 'stIn');
  clearInterval(end.t);
  const tick = () => {
    const s = Math.max(0, Math.ceil((me.until - Date.now()) / 1000));
    $('gTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (me.op && Date.now() > me.turnUntil) { me.op = false; renderAccess(); }   // the deck moves the line on
    else renderTurn();
    if (!s) end('time');
  };
  tick();
  end.t = setInterval(tick, 1000);
  renderNews();
}
$('gLeave').addEventListener('click', () => { post({ t: 'bye' }); end('left'); });

// ---------- PWNED ----------
// About 7 s of this page falling apart: the controls glitch, a fake "exfiltration" log
// scrolls, I PWNED YOU, then the reveal (end('pwned')): only this page. All in the
// guest's language.
// stay: a lost DEBUG game, not a kick: after the reveal they're back where they were.
function pwned(by, stay = false) {
  closeGame();
  if (!stay) {
    me.k = null;
    saveMe();
    clearInterval(end.t);
  }
  document.body.classList.add('glitching');
  try { navigator.vibrate?.([80, 60, 80, 60, 300]); } catch {}
  setTimeout(() => {
    screen('gPwn', '0WN3D');
    $('gPwnBy').textContent = t.pwnBy.replace('{x}', by || 'THE RIG');
    $('gPwnLog').textContent = '';
    // A lost game isn't a revoked certificate: that one opens with BUG.EXE bouncing back.
    const log = stay ? [t.pwnBounce, ...t.pwnLog.slice(1)] : t.pwnLog;
    log.forEach((l, i) =>setTimeout(() => { $('gPwnLog').textContent += l + '\n'; }, i * 450));
  }, 1600);
  setTimeout(() => {
    document.body.classList.remove('glitching');
    if (!stay) return end('pwned');
    screen('gPlay', 'stIn');
    note(me.full ? t.end.pwned[1] : `${t.end.pwned[1]} ${t.tryAgain}`, 9000);   // the reveal, in their language
  }, 8000);
}

// ---------- DEBUG: Byte vs BUG.EXE ----------
function closeGame() {
  $('gGame').hidden = true;
  $('gGameFrame').src = 'about:blank';
}
$('gPlayGame').addEventListener('click', () => {
  if (!me.k) return;
  $('gGameFrame').src = 'viz/byte-vs-bug.html?embed';
  $('gGame').hidden = false;
});
$('gGameClose').addEventListener('click', closeGame);
$('gSkip').addEventListener('click', () => {
  if (!me.k || me.full) return;
  post({ t: 'skip' });
  note(t.skipAsked, 6000);
});
// The game's play-by-play goes to the rig too (its CLUE + mask follow along live).
const LIVE = { 'bvb-start': 'start', 'bvb-hit': 'hit', 'bvb-eat': 'eat' };
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !me.k || !LIVE[e.data?.type]) return;
  post({ t: 'gev', e: LIVE[e.data.type], n: e.data.hits ?? e.data.left ?? 0 });
});
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'bvb-end' || !me.k) return;
  const { win, ms, saved } = e.data;
  post({ t: 'game', won: !!win, ms, saved });
  setTimeout(() => {                    // let them see the game's own ending first
    closeGame();
    note(t.gameSent);
  }, 3500);
});

function renderNews() {
  $('gDrive').hidden = !news.drive;
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
    b.querySelector('.hint').textContent = t.hints[m.key] ?? m.hint;
    b.addEventListener('click', () => {
      act({ t: 'mode', set: gSet, i });
      for (const el of $('gModes').children) el.classList.toggle('active', el === b);
    });
    return b;
  }));
}
$('gHack').addEventListener('click', () => act({ t: 'hack' }));

// ---------- DRIVE THE BOLT ----------
// Hold and drag; the deck drives at the owner's MAX and stops if we go quiet for 1.5 s.
// Through the relay it lags a bit, so: only real changes, a heartbeat while moving, and
// the stop goes at once.
{
  const stick = $('gStick'), knob = $('gKnob');
  let held = false, x = 0, y = 0, sent = { s: 0, h: 0, at: 0 }, beat = null;
  const DEAD = 0.15;
  const send = (s, h, now = Date.now()) => {
    sent = { s, h, at: now };
    post({ t: 'drv', s: Math.round(s * 100) / 100, h: Math.round(h) });
  };
  const update = (force = false) => {
    knob.style.left = `${50 + x * 36}%`;
    knob.style.top = `${50 - y * 36}%`;
    stick.classList.toggle('live', held);
    const m = Math.min(1, Math.hypot(x, y));
    const s = held && m > DEAD ? (m - DEAD) / (1 - DEAD) : 0;
    const h = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    const now = Date.now(), dh = Math.abs(((h - sent.h + 540) % 360) - 180);
    if (s === 0) { if (sent.s !== 0 || force) send(0, sent.h, now); return; }
    if (force || now > sent.at + 300 && (Math.abs(s - sent.s) > 0.15 || dh > 12)) send(s, h, now);
  };
  const at = (e) => {
    const r = stick.getBoundingClientRect();
    x = Math.max(-1, Math.min(1, (e.clientX - r.left - r.width / 2) / (r.width * 0.36)));
    y = Math.max(-1, Math.min(1, -(e.clientY - r.top - r.height / 2) / (r.height * 0.36)));
  };
  const release = () => {
    if (!held) return;
    held = false;
    x = y = 0;
    clearInterval(beat);
    update(true);
  };
  stick.addEventListener('pointerdown', (e) => {
    if (!me.k) return;
    stick.setPointerCapture(e.pointerId);
    held = true;
    at(e);
    update(true);
    beat = setInterval(() => { if (held && sent.s > 0) send(sent.s, sent.h); }, 1000);   // still here
  });
  stick.addEventListener('pointermove', (e) => { if (held) { at(e); update(); } });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(ev, release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
}

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
  if (me.k && me.name) {               // still holding a certificate: knock, the deck re-admits
    $('gName').value = me.name;
    join(true);
  } else {
    if (me.name) $('gName').value = me.name;
    screen('gJoin', 'stOffline');
  }
}
