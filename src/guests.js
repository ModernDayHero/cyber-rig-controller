// Guest mode, the host side. "Wanna edgerun?" -> INVITE makes a one-time password (and
// shows the guest QR); they scan, type a handle + the password and they're in, already
// approved, for `minutes`. Each password lets in exactly one phone; that's their
// "certificate" until it runs out, DISCONNECT, or PWN (their screen gets glitched by our
// own page, then a reveal: their phone is fine). Once in, a guest has GUEST access:
//   pic (library pictures) -> straight to the rig;  say (a typed word) -> SHOW / BLOCK here
//   game: DEBUG (Byte vs BUG.EXE, public/viz) - the result decides the rest:
//     win  -> FULL ACCESS: mode / hack (FIREWALL still applies) and up (an uploaded picture,
//             SHOW / BLOCK here); the rig shows BUG FIXED + their time; a hacked rig is purged
//     lose -> BUG.EXE escapes: into the rig (the virus, at most once a minute, never through
//             the FIREWALL) or back at them (a PWN that doesn't kick them; they can play again)
//
// The link is ntfy.sh (no server of our own): guests post to the session topic, this app
// listens to it (EventSource) and answers each guest on <topic>-<guest id>; rig news for
// everyone (firewall, hacked) goes out once on <topic>-all. The topic is random and stays
// the same across GUESTS off / on (so the badge's QR keeps working); NEW LINK replaces it
// and every old QR stops working. Anyone holding the QR can read the topic, so the QR alone
// gets nobody in: the password does, once, and then a token only that phone was sent.
// Every message is checked here before it reaches the rig.

import { SETS } from './config.js';
import { PICS, MINE, lookup } from './library.js';
import { ascii } from './i18n.js';

// Any ntfy server: ntfy.sh to start, our own (e.g. on the NAS) later: SET -> GUESTS.
export const DEFAULT_RELAY = 'https://ntfy.sh';
export const GUEST_MINUTES = [5, 10, 30, 60];
const STORE_KEY = 'rig-guests';
const GAP_MS = 1200;                 // a guest's actions, at most one this often
const QUEUE_MAX = 12;                // waiting words / pictures; more are turned away
const INVITE_MS = 15 * 60000;        // an unused password expires
const MISSES = 5;                    // wrong passwords in a row before logins pause...
const PAUSE_MS = 60000;              // ...for this long
const GAME_GAP = 15000;              // one DEBUG result a guest this often
const BREACH_GAP = 60000;            // a lost game lets the virus loose at most this often
const BOARD_SIZE = 10;
// No 0/O, 1/I/L, 2/Z, 5/S, 8/B: easy to read off a screen and type.
const CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXY34679';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => CODE_CHARS[v % CODE_CHARS.length]).join('');
export const showCode = (c) => `${c.slice(0, 3)}-${c.slice(3)}`;

const rand = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (v) => (v % 36).toString(36)).join('');
// For the rig's little screens: English letters only (accents come off, other scripts go).
const clean = (v, n) => ascii(v).toUpperCase().replace(/\s+/g, ' ').trim().slice(0, n);
// A handle as they typed it, any script (only shown on this phone): no control characters.
const handle = (v) => [...String(v ?? '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 12).join('');
const LANG_CODES = ['en', 'ko', 'ja', 'zh-TW', 'vi'];
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// The owner's callsign (BADGE tab), for PWN signatures.
const signature = () => { try { return JSON.parse(localStorage.getItem('rig-badge'))?.callsign || 'THE RIG'; } catch { return 'THE RIG'; } };
const isId = (g) => typeof g === 'string' && /^[a-z0-9]{16}$/.test(g);

/** A guest's uploaded picture, checked: 16 rows of 16 from '.' + its palette letters. */
export function checkPic(m) {
  const pal = m?.pal, art = m?.art;
  if (!pal || typeof pal !== 'object' || !Array.isArray(art) || art.length !== 16) return null;
  const keys = Object.keys(pal);
  if (keys.length > 15 || !keys.every((k) => /^[a-o]$/.test(k) && /^#[0-9a-f]{6}$/i.test(pal[k]))) return null;
  if (!art.every((r) => typeof r === 'string' && r.length === 16 && [...r].every((c) => c === '.' || c in pal))) return null;
  const rgb = Array.isArray(m.rgb) && m.rgb.length === 3 ? m.rgb.map((v) => Math.max(0, Math.min(255, v | 0))) : [0, 229, 255];
  return { pal: { ...pal }, art: [...art], rgb };
}

export class GuestHost extends EventTarget {
  constructor(rig) {
    super();
    this.rig = rig;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch {}
    this.minutes = GUEST_MINUTES.includes(saved.minutes) ? saved.minutes : 10;
    this.topic = saved.topic || null;
    this.relay = saved.relay || DEFAULT_RELAY;
    this.open = false;
    // Guests in (a reload of this page keeps them) and passwords not used yet.
    this.guests = new Map((saved.guests || []).filter(([, x]) => x.until > Date.now()));
    for (const x of this.guests.values()) x.last = 0;
    this.invites = (saved.invites || []).filter((v) => v.until > Date.now());   // { code, until }
    this.queue = [];                 // { n, g, kind: 'say' | 'up', text | pic }
    this._n = 0;
    this._misses = 0;
    this._pausedUntil = 0;
    this._breachAt = 0;
    this.board = saved.board || [];  // fastest DEBUG wins: { name, ms, saved }
    if (saved.open) this.enable();

    // Firewall / virus news for every guest (their HACK IT ALL button follows it).
    this._news = '';
    rig.addEventListener('change', () => this._sendNews());
    setInterval(() => this._expire(), 1000);
  }

  get enabled() { return this.open; }
  /** The guest page's address for this session (made on first use, kept after). */
  get link() {
    if (!this.topic) { this.topic = 'cd' + rand(20); this._save(); }
    let here = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
    // Dev on localhost: guests' phones can't reach "localhost", so use the PC's Wi-Fi address.
    if (import.meta.env?.DEV && typeof __LAN_HOST__ === 'string' && __LAN_HOST__ && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      here = here.replace(location.hostname, __LAN_HOST__);
    }
    const via = this.relay === DEFAULT_RELAY ? '' : '@' + new URL(this.relay).host;
    return `${here}guest.html#${this.topic}${via}`;
  }

  _save() {
    const { topic, relay, open, minutes, invites, board } = this;
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ topic, relay, open, minutes, invites, board, guests: [...this.guests] })); } catch {}
  }
  _changed() {
    this._save();
    this.dispatchEvent(new Event('change'));
  }

  enable() {
    void this.link;                              // makes the topic if there isn't one yet
    this.open = true;
    this.es?.close();
    this.es = new EventSource(`${this.relay}/${this.topic}/sse`);
    this.es.onmessage = (e) => {
      try {
        const n = JSON.parse(e.data);
        if (n.event === 'message' && n.topic === this.topic) this._onGuest(JSON.parse(n.message));
      } catch {}
    };
    this._news = '';
    this._sendNews();
    this._changed();
  }

  /** GUESTS off: everyone is sent home and unused passwords die; the link stays. */
  disable() {
    for (const g of this.guests.keys()) this._to(g, { t: 'end', why: 'closed' });
    this.es?.close();
    this.es = null;
    this.open = false;
    this.guests.clear();
    this.invites = [];
    this.queue = [];
    this._changed();
  }

  /** "Wanna edgerun?": a new one-time password (opens the port if it was shut). */
  invite() {
    if (!this.open) this.enable();
    const v = { code: newCode(), until: Date.now() + INVITE_MS };
    this.invites.push(v);
    this._changed();
    return v;
  }

  revokeInvite(code) {
    this.invites = this.invites.filter((v) => v.code !== code);
    this._changed();
  }

  /** NEW LINK: a fresh topic. Everyone is sent home and every old QR stops working. */
  newLink() {
    const was = this.open;
    if (was) this.disable();
    this.topic = null;
    void this.link;
    if (was) this.enable();
    this._changed();
  }

  /** Another ntfy server (https://...). The QR changes with it, so everyone is sent home. */
  setRelay(url) {
    let u;
    try { u = new URL(url.trim()); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    const was = this.open;
    if (was) this.disable();
    this.relay = u.origin;
    if (was) this.enable();
    this._changed();
    return true;
  }

  setMinutes(m) {
    this.minutes = m;
    this._changed();
  }

  _post(topic, msg) {
    fetch(`${this.relay}/${topic}`, { method: 'POST', body: JSON.stringify(msg) }).catch(() => {});
  }
  _to(g, msg) { if (this.topic) this._post(`${this.topic}-${g}`, msg); }

  _sendNews() {
    if (!this.open) return;
    const s = this.rig.state, news = { t: 'news', fw: s.sandbox, hacked: s.hacked };
    const sig = JSON.stringify(news);
    if (sig === this._news) return;
    this._news = sig;
    clearTimeout(this._newsT);                 // a burst of changes = one message
    this._newsT = setTimeout(() => this._post(`${this.topic}-all`, news), 400);
  }

  // ---------- from a guest ----------
  _onGuest(m) {
    if (!m || !isId(m.g)) return;
    const x = this.guests.get(m.g);
    if (m.t === 'join') return this._join(m.g, x, m);
    if (!x || m.k !== x.token) return;          // not let in (or not them): ignored
    if (m.t === 'bye') return this.kick(m.g, 'left');
    if (m.t === 'game') return this._game(m.g, x, m);
    const now = Date.now();
    if (now < x.last + GAP_MS) return;
    x.last = now;
    const deny = (why) => this._to(m.g, { t: 'deny', why });
    if (['mode', 'hack', 'up'].includes(m.t) && !x.full) return deny('locked');   // win DEBUG first
    switch (m.t) {
      case 'mode': {
        const set = SETS[m.set], i = m.i | 0;
        if (!set || i < 0 || i >= set.modes.length) return;
        if (!this.rig.setMode(m.set, i)) deny(this.rig.locked ? 'hacked' : 'firewall');
        break;
      }
      case 'hack':
        if (this.rig.locked) deny('hacked');
        else if (!this.rig.hack()) deny('firewall');
        break;
      case 'pic': {
        const p = PICS[m.id] || MINE.get(m.id);
        if (p && p.cmd !== false) this.rig.showPic(p, '');
        break;
      }
      case 'say': {
        // Kept as typed for this phone's queue; the rig gets clean() of it.
        const text = [...String(m.text ?? '').replace(/[\p{C}]/gu, '').trim()].slice(0, 24).join('').replace(/^\/+/, '');
        if (!text) break;
        if (!clean(text, 24)) this._to(m.g, { t: 'res', kind: 'say', ok: false, why: 'script' });
        else this._ask(m.g, { kind: 'say', text });
        break;
      }
      case 'up': {
        const pic = checkPic(m);
        if (pic) this._ask(m.g, { kind: 'up', pic: { ...pic, id: 'guest', caption: clean(m.caption, 20) } });
        break;
      }
    }
  }

  _join(g, x, m) {
    if (x) {                                     // their page reloaded: same phone, same token
      if (m.k === x.token) this._to(g, { t: 'ok', k: x.token, until: x.until, name: x.name, full: !!x.full });
      return;
    }
    const now = Date.now();
    if (now < this._pausedUntil) return this._to(g, { t: 'nope', why: 'pause' });
    const code = String(m.p ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const v = this.invites.find((i) => i.code === code && i.until > now);
    if (!v) {
      if (++this._misses >= MISSES) { this._misses = 0; this._pausedUntil = now + PAUSE_MS; }
      return this._to(g, { t: 'nope', why: 'code' });
    }
    this._misses = 0;
    this.invites = this.invites.filter((i) => i !== v);   // one phone per password
    const guest = {
      name: handle(m.name) || 'GUEST',
      lang: LANG_CODES.includes(m.lang) ? m.lang : 'en',
      code, until: now + this.minutes * 60000, token: rand(16), last: 0, full: false, lastGame: 0,
    };
    this.guests.set(g, guest);
    this._to(g, { t: 'ok', k: guest.token, until: guest.until, name: guest.name });
    this._news = '';
    this._sendNews();                            // so they know the firewall state
    this._buzz();
    this._changed();
  }

  /** A DEBUG result (on trust: it's a party). */
  _game(g, x, m) {
    const now = Date.now(), ms = m.ms | 0, saved = Math.max(0, Math.min(6, m.saved | 0));
    if (now < x.lastGame + GAME_GAP || ms < 3000 || ms > 30 * 60000) return;
    x.lastGame = now;
    const tag = clean(x.name, 12) || 'RUNNER';
    if (m.won) {
      x.full = true;
      this._to(g, { t: 'full' });
      this.board = [...this.board, { name: x.name, ms, saved }].sort((a, b) => a.ms - b.ms).slice(0, BOARD_SIZE);
      if (this.rig.locked) this.rig.purge();     // debugging the rig fixes the rig
      this.rig.sayText(`BUG FIXED ${tag} ${mmss(ms)}`);
    } else if (!this.rig.state.sandbox && !this.rig.locked && now > this._breachAt + BREACH_GAP && Math.random() < 0.5) {
      this._breachAt = now;                      // BUG.EXE escapes into the rig
      this.rig.hack();
      this._to(g, { t: 'breach' });
    } else {
      this._to(g, { t: 'pwn', by: clean(signature(), 16) || 'THE RIG', stay: true });   // ...or into them
    }
    this._buzz();
    this._changed();
  }

  _ask(g, item) {
    if (this.queue.length >= QUEUE_MAX) return this._to(g, { t: 'deny', why: 'busy' });
    this.queue.push({ n: ++this._n, g, ...item });
    this._buzz();
    this._changed();
  }

  _buzz() { try { navigator.vibrate?.(120); } catch {} }

  // ---------- the host's answers ----------
  /** DISCONNECT (or their time ran out, or they left): the certificate is void. */
  kick(g, why = 'kicked') {
    if (!this.guests.has(g)) return;
    if (why !== 'left') this._to(g, { t: 'end', why });
    this.guests.delete(g);
    this.queue = this.queue.filter((q) => q.g !== g);
    this._changed();
  }

  /** A waiting word / picture: show it on the rig (yes) or turn it down. */
  decide(n, yes) {
    const q = this.queue.find((v) => v.n === n);
    if (!q) return;
    this.queue = this.queue.filter((v) => v !== q);
    if (yes) {
      if (q.kind === 'up') this.rig.showPic(q.pic, '');
      else {
        const text = clean(q.text, 24);
        const p = lookup(text);
        if (p) this.rig.showPic(p, text);
        else this.rig.sayText(text);
      }
    }
    this._to(q.g, { t: 'res', kind: q.kind, ok: yes });
    this._changed();
  }

  /** PWN: their (our) page glitches out, "I PWNED YOU", the reveal, then they're out. */
  pwn(g, by = signature()) {
    if (!this.guests.has(g)) return;
    this._to(g, { t: 'pwn', by: clean(by, 16) || 'THE RIG' });
    this.kick(g, 'left');                        // 'left': the pwn is their goodbye
  }

  _expire() {
    const now = Date.now();
    for (const [g, x] of this.guests) if (now > x.until) this.kick(g, 'time');
    const n = this.invites.length;
    this.invites = this.invites.filter((v) => v.until > now);
    if (this.invites.length !== n) this._changed();
    if (this.guests.size || this.invites.length) this.dispatchEvent(new Event('tick'));   // countdowns
  }
}
