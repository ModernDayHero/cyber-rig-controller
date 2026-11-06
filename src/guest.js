// guest.html: a friend's phone, from the invite QR (the badge or the owner's phone) and a
// one-time access code. No Bluetooth here: everything goes as a request through the relay's
// session topic (worker/relay) to the owner's deck (guests.js), which decides. Answers come back
// on <topic>-<our id>, rig news on <topic>-all. A PWN from the owner glitches this page
// (only this page: there's nothing else a web page could touch), then says so.
//
// The link: guest.html#<topic>[&k=<access code>]. An invite's QR carries its
// code (k), so scanning it fills the code in. Signing in goes a step at a time: language +
// I AGREE, the handle, the access code.

import './style.css';
import { SETS, isShown } from './config.js';
import { PICS, indexed } from './library.js';
import { decodeImage, toPic, paintPreview } from './image.js';
import { RELAY } from './guests.js';
import { LANGS, STYLES, guessLang, words } from './i18n.js';

const $ = (id) => document.getElementById(id);
const [main, ...params] = location.hash.slice(1).split('&');
const topic = main.split('@')[0];      // (an old link may still say @<relay>)
const linkCode = (params.find((p) => p.startsWith('k=')) || '').slice(2).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
if (linkCode) history.replaceState(null, '', `${location.pathname}${location.search}#${main}`);   // not left in history
const ME_KEY = `rig-guest-${topic}`;
const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (v) => (v % 36).toString(36)).join('');
const COOL_MS = 1500;                 // the deck ignores faster than ~1.2 s anyway

// Who we are on this rig, kept on this phone (closing the tab doesn't lose it): our id, the
// certificate token while it's good, the handle, the language.
let me = {};
try { me = JSON.parse(localStorage.getItem(ME_KEY)) || {}; } catch {}
me.g ||= rand(16);
me.lang ||= guessLang();
if (!STYLES.includes(me.style)) me.style = 'plain';   // everyday words, unless they pick NIGHT CITY
const saveMe = () => { try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch {} };
saveMe();

// ---------- language ----------
let t = words(me.lang, me.style);
let stateKey = 'stOffline';
function applyLang() {
  t = words(me.lang, me.style);
  document.documentElement.lang = me.lang;
  for (const b of $('gStyle').children) {
    b.classList.toggle('on', b.dataset.style === me.style);
    if (b.dataset.style === 'plain') b.textContent = words(me.lang, 'plain').styleName;
  }
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n];
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t[el.dataset.i18nPh];
  for (const b of $('gLang').children) b.classList.toggle('on', b.dataset.lang === me.lang);
  $('gState').textContent = t[stateKey] ?? stateKey;
  renderNews();
  renderAccess();
  buildModes();
  $('gReturning').textContent = t.returning.replace('{name}', me.name || '');
}
// What's theirs: each section has a permission (data-perm); patterns / hack / drive are
// also the operator's only, one guest at a time (turns, guests.js).
const TURN_PERMS = new Set(['modes', 'hack', 'drive', 'motors']);
function renderAccess() {
  document.body.classList.toggle('full', !!me.full);
  $('gAccess').textContent = me.full ? t.accessFull : t.accessGuest;
  $('gSkip').hidden = !!me.full;          // nothing left to skip to
  const perms = me.perms || {};
  for (const el of document.querySelectorAll('[data-perm]')) {
    const p = el.dataset.perm, mine = !!perms[p], wait = mine && TURN_PERMS.has(p) && !me.op;
    el.classList.toggle('locked', !mine || wait);
    el.classList.toggle('ready', mine && !wait && !el.hidden);   // lit up: usable right now
    el.dataset.lock = !mine ? t.lockedHint : wait ? t.waitTurn : '';
    el.dataset.ready = t.readyTag;
  }
  // Once it's all theirs, the game is for the high scores: it moves to the bottom, smaller.
  $('gDebugHint').textContent = me.full ? t.replayHint : t.debugHint;
  renderCan();
  renderTurn();
}
// YOU CAN NOW: a chip per thing, in page order; tap one to scroll to it.
const CAN = ['modes', 'hack', 'drive', 'motors', 'say', 'pic', 'up'];
function renderCan() {
  const perms = me.perms || {};
  $('gCan').replaceChildren(...CAN.filter((p) => (p !== 'drive' || news.drive) && (p !== 'motors' || news.motors)).map((p) => {
    const mine = !!perms[p], wait = mine && TURN_PERMS.has(p) && !me.op;
    const b = document.createElement('button');
    b.className = `chip ${!mine ? 'off' : wait ? 'wait' : 'on'}`;
    b.textContent = `${!mine ? '🔒' : wait ? '⏳' : '✓'} ${t.can[p]}`;
    b.addEventListener('click', () => document.querySelector(`[data-perm="${p}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    return b;
  }));
}
function renderTurn() {
  const el = $('gTurn'), canOperate = [...TURN_PERMS].some((p) => me.perms?.[p]);
  el.hidden = !canOperate || (!me.op && !me.pos);
  el.classList.toggle('op', !!me.op);
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  el.textContent = me.op ? `${t.opYou} · ${mmss(me.turnUntil - Date.now())}`
    : `${t.inLine.replace('{n}', me.pos).replace('{t}', mmss(me.turnAt - Date.now()))}${me.full ? '' : ' · ' + t.moveUp}`;
}
for (const b of $('gStyle').children) {
  b.addEventListener('click', () => { me.style = b.dataset.style; saveMe(); applyLang(); refreshEnd(); });
}
$('gLang').append(...LANGS.map(({ code, label }) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.dataset.lang = code;
  b.lang = code;
  b.addEventListener('click', () => { me.lang = code; saveMe(); applyLang(); });
  return b;
}));
// ---------- signing in, a step at a time ----------
let step = 1;
function setStep(n) {
  step = n;
  $('gStepNo').textContent = `${n} / 3`;
  for (const el of document.querySelectorAll('#gJoin .step')) {
    const s = +el.dataset.step;
    el.classList.toggle('now', s === n);
    el.classList.toggle('done', s < n);
    el.inert = s > n;                    // later steps: dimmed and out of reach until NEXT
  }
  const f = { 2: $('gName'), 3: $('gPass') }[n];
  if (f) setTimeout(() => f.focus(), 50);
}
// A finished step can be tapped to go back to it.
for (const el of document.querySelectorAll('#gJoin .step')) {
  el.addEventListener('click', () => { if (+el.dataset.step < step) setStep(+el.dataset.step); });
}
// ---------- new guest / returning guest ----------
// This phone has been signed in before: the same person picks up where they left off (name
// and agreement kept: just the code, or straight back in while their certificate holds);
// someone new starts clean, with a new guest id of their own.
function askWho() {
  $('gWho').hidden = false;
  $('gSteps').hidden = true;
  $('gReturning').textContent = t.returning.replace('{name}', me.name);
}
function startSteps(n) {
  $('gWho').hidden = true;
  $('gSteps').hidden = false;
  setStep(n);
}
$('gReturning').addEventListener('click', () => {
  if (me.k) return join(true);          // the certificate is still good: knock, straight in
  $('gName').value = me.name;
  startSteps(3);
});
$('gNewGuest').addEventListener('click', () => {
  me = { g: rand(16), lang: me.lang };
  saveMe();
  opened = listen();                     // answers for the new id
  $('gName').value = '';
  startSteps(1);
});
/** The sign-in screen: ask who it is if this phone has a name on it, else from the top. */
function signIn() {
  screen('gJoin', 'stOffline');
  if (me.name && me.agreed) askWho();
  else startSteps(me.agreed ? 2 : 1);
}

$('gAgree').addEventListener('click', (e) => {
  e.stopPropagation();
  me.agreed = true;
  saveMe();
  setStep(2);
});
function nameDone(e) {
  e?.stopPropagation();
  const name = $('gName').value.trim();
  if (!name) return $('gName').focus();
  me.name = name;
  saveMe();
  setStep(3);
}
$('gNext').addEventListener('click', nameDone);
$('gName').addEventListener('keydown', (e) => { if (e.key === 'Enter') nameDone(e); });

// ---------- screens ----------
const SCREENS = ['gJoin', 'gWait', 'gPlay', 'gPwn', 'gEnd'];
function screen(id, state) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  stateKey = state;
  $('gState').textContent = t[state] ?? state;
}
let endWhy = null;
function refreshEnd() {
  if (!endWhy || $('gEnd').hidden) return;
  const [title, text] = t.end[endWhy] || t.end.kicked;
  $('gEndTitle').textContent = title;
  $('gEndWhy').textContent = text;
}
function end(why) {
  endWhy = why;
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
      // Show them what just opened up (once the game's closed).
      setTimeout(() => document.querySelector('[data-perm].ready')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 4000);
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
      startSteps(3);
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
        parked: t.denyParked, motorsOff: t.denyMotors, turn: t.waitTurn }[m.why] || t.denied2);
      break;
    case 'res':
      if (m.kind === 'skip') note(t.skipDenied, 6000);
      else if (m.why === 'script') note(t.script, 6000);
      else note(m.kind === 'up' ? (m.ok ? t.okPic : t.noPic) : (m.ok ? t.okWord : t.noWord));
      break;
    case 'news':
      news = { fw: !!m.fw, hacked: !!m.hacked, drive: !!m.drive, shown: m.shown, motors: Array.isArray(m.motors) && m.motors.length ? m.motors : null };
      renderNews();
      buildModes();
      break;
  }
}

// Our answers come on <topic>-<our id>: a new guest (new id) listens afresh.
// The same watchdog as the deck's: a minute without the relay's 25 s keepalive (or waking
// up after a while) reopens it.
let es = null, alive = Date.now();
function listen() {
  es?.close();
  alive = Date.now();
  es = new EventSource(`${RELAY}/${topic}-${me.g},${topic}-all/sse`);
  const ping = () => { alive = Date.now(); };
  es.addEventListener('keepalive', ping);
  es.onmessage = (e) => {
    ping();
    try {
      const n = JSON.parse(e.data);
      if (n.event === 'message') onAnswer(JSON.parse(n.message));
    } catch {}
  };
  return new Promise((ok) => { es.onopen = () => { ping(); ok(); }; });
}
setInterval(() => { if (topicOk && Date.now() - alive > 70000) opened = listen(); }, 10000);
document.addEventListener('visibilitychange', () => {
  if (topicOk && document.visibilityState === 'visible' && Date.now() - alive > 35000) opened = listen();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The link open, or given up on after a few seconds (reopened once): never a forever wait. */
async function linkReady() {
  const ok = await Promise.race([opened.then(() => true), sleep(6000).then(() => false)]);
  if (ok) return;
  opened = listen();
  await Promise.race([opened, sleep(6000)]);
}

// ---------- knocking ----------
async function join(again = false) {
  const name = $('gName').value.trim() || me.name || '';
  const p = $('gPass').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!again && !me.agreed) return setStep(1);
  if (!name) return setStep(2);
  if (!again && p.length !== 6) return $('gPass').focus();
  me.name = name;
  saveMe();
  $('gJoinNote').hidden = true;
  screen('gWait', 'stKnocking');
  $('gWaitHint').textContent = t.checking;
  await linkReady();
  if (!await post({ t: 'join', name, p, lang: me.lang })) {
    $('gWaitHint').textContent = t.relayBusy;
    setTimeout(() => { if (!$('gWait').hidden) { screen('gJoin', 'stOffline'); startSteps(3); } }, 4000);
    return;
  }
  clearTimeout(join.t);
  join.t = setTimeout(() => {
    if (!$('gWait').hidden) {
      $('gWaitHint').textContent = t.noAnswer;
      setTimeout(() => { if (!$('gWait').hidden) { screen('gJoin', 'stOffline'); startSteps(3); } }, 4000);
    }
  }, 20000);
}
$('gJoinBtn').addEventListener('click', (e) => { e.stopPropagation(); join(); });
$('gPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('gPass').addEventListener('input', () => {        // ABC-DEF as they type
  const v = $('gPass').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  $('gPass').value = v.length > 3 ? `${v.slice(0, 3)}-${v.slice(3)}` : v;
});
// TRY AGAIN: straight back in while the certificate is good; else a fresh access code.
$('gAgain').addEventListener('click', () => (me.k ? join(true) : signIn()));

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
  document.body.classList.remove('gaming');
  $('gGame').hidden = true;
  $('gGameFrame').src = 'about:blank';
}
$('gPlayGame').addEventListener('click', () => {
  if (!me.k) return;
  $('gGameFrame').src = 'viz/byte-vs-bug.html?embed';
  document.body.classList.add('gaming');    // no scrolling the page behind the game
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
  $('gMotors').hidden = !news.motors;
  buildMotors();
  if ($('gCan').childElementCount || me.perms) renderCan();
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
  $('gModes').replaceChildren(...SETS[gSet].modes.map((m, i) => [m, i])
    .filter(([m, i]) => !m.cycle && isShown(news, gSet, i)).map(([m, i]) => {
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

// ---------- MOTORS ----------
// A slider per servo (it stays where it's put), hold-to-run buttons per motor: the deck
// caps them, and the plugin stops a motor 1.5 s after we go quiet, so we repeat while held.
let motorSig = '';
function buildMotors() {
  const chs = news.motors || [], sig = JSON.stringify(chs);
  if (sig === motorSig) return;
  motorSig = sig;
  $('gMotorList').replaceChildren(...chs.map((ch) => {
    const row = document.createElement('div');
    row.className = 'gmotor';
    const name = document.createElement('span');
    name.className = 'label';
    name.textContent = ch.name;
    row.append(name);
    if (ch.type === 'servo') {
      const r = document.createElement('input');
      Object.assign(r, { type: 'range', min: -100, max: 100, step: 5, value: 0 });
      let last = 0, t = null;
      const send = () => { last = Date.now(); post({ t: 'mot', c: ch.i, v: Number(r.value) / 100 }); };
      r.addEventListener('input', () => {
        if (!me.k) return;
        clearTimeout(t);
        if (Date.now() - last > 250) send(); else t = setTimeout(send, 250);
      });
      row.append(r);
    } else {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [dir, txt] of [[-1, '◀'], [1, '▶']]) {
        const b = document.createElement('button');
        b.textContent = txt;
        let beat = null;
        const go = (e) => {
          if (!me.k) return;
          b.setPointerCapture?.(e.pointerId);
          b.classList.add('on');
          post({ t: 'mot', c: ch.i, v: dir });
          clearInterval(beat);
          beat = setInterval(() => post({ t: 'mot', c: ch.i, v: dir }), 700);
        };
        const stop = () => {
          if (!beat) return;
          clearInterval(beat);
          beat = null;
          b.classList.remove('on');
          post({ t: 'mot', c: ch.i, v: 0 });
        };
        b.addEventListener('pointerdown', go);
        for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, stop);
        document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
        seg.append(b);
      }
      row.append(seg);
    }
    return row;
  }));
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

// The keyboard covers the bottom of the screen (the page doesn't resize: viewport
// interactive-widget=resizes-visual); make sure the box being typed in is in view.
document.addEventListener('focusin', (e) => {
  if (!e.target.matches('input.text')) return;
  setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
});

// ---------- start ----------
let opened;
const topicOk = /^cd[a-z0-9]{20}$/.test(topic);
applyLang();
if (!topicOk) {
  end('link');
} else {
  opened = listen();
  if (me.k && me.name) {               // still holding a certificate: knock, the deck re-admits
    $('gName').value = me.name;
    join(true);
  } else {
    if (me.name) $('gName').value = me.name;
    if (linkCode) $('gPass').value = `${linkCode.slice(0, 3)}-${linkCode.slice(3)}`;   // from the invite QR
    signIn();
  }
}
