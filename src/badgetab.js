// BADGE tab: the e-ink badge's screens, drawn here at the badge's own 540 x 960
// (portrait) and sent finished into the badge's slots; the badge only shows them.
//   SPLASH  slot 0, between guests: INTRO (the rig introduced) or ARTWORK (your own picture,
//           cropped / contrast / dithered), with an optional QR strip (join + your LINK QR)
//   INVITES the last five access codes; SHOW puts a waiting one back up (slot 6)
//   PHOTO  a guest portrait (slots 2-5, the badge keeps the last four): any picture,
//          cropped (drag it / ZOOM), contrast, 16 greys with dithering
//   SCORES slot 7: HIGH SCORES from DEBUG; refreshed quietly after each win, shown on a
//          NEW RECORD so the winner can photograph it
// INVITE (slot 6) is the guest bar's WANNA EDGERUN?, put up and taken down from main.js.
// The badge's keys open the same screens: KEY 1 SPLASH, KEY 2 SCORES, KEY 3 PORTRAIT (again:
// the next), BOOT the last INVITE. WORN /
// TABLE, HOLD, HANGS, CALLSIGN and LINK QR live in SET → BADGE.

import qrcode from 'qrcode-generator';
import { decodeImage, badgeCrop, toGrey16, packBadge, paintGrey, BADGE } from './image.js';
import { SLOT } from './ble/badge.js';
import { showCode } from './guests.js';
import { words } from './i18n.js';

const STORE_KEY = 'rig-badge';
const DEFAULTS = {
  kind: 'splash', look: 'intro', qrStrip: true,
  art: { zoom: 1, panX: 0, panY: 0, contrast: 1.2, brightness: 0, dither: true },
  callsign: 'MODERNDAYHERO', turn: 'cw', zoom: 1, panX: 0, panY: 0, contrast: 1.2, brightness: 0,
  dither: true, mode: 0, hold: 180, link: '',
};
const KIND_SLOT = { splash: SLOT.SPLASH, scores: SLOT.SCORES, photo: SLOT.GUEST, invites: null };
const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function setupBadge({ rig, host, $, segPick, segShow, showBanner, showInvite }) {
  const badge = rig.badge;
  let st = { ...DEFAULTS };
  try { st = { ...st, ...JSON.parse(localStorage.getItem(STORE_KEY)) }; } catch {}
  delete st.repo;                       // the old CODE QR (the repo is private now)
  if (!(st.kind in KIND_SLOT)) st.kind = 'splash';   // LOGIN QR / CARD / HOME became SPLASH
  st.art = { ...DEFAULTS.art, ...st.art };
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch {} };
  let photo = null, art = null, grey = null;    // the portrait / the splash artwork (memory only)
  // The picture being adjusted (ZOOM, drag...) and its settings: the portrait's or the artwork's.
  const pic = () => (st.kind === 'splash' ? art : photo);
  const adj = () => (st.kind === 'splash' ? st.art : st);
  const adjusting = () => st.kind === 'photo' || (st.kind === 'splash' && st.look === 'art');
  const work = document.createElement('canvas');
  work.width = BADGE.w;
  work.height = BADGE.h;
  const g = work.getContext('2d', { willReadFrequently: true });
  const font = getComputedStyle(document.body).fontFamily;

  /** The address a QR goes to, short enough to read and type: jack.steamworkz.net */
  const shortUrl = (u) => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/(guest\.html)?$/, ''); } catch { return u; } };

  /** One QR, black on white, `size` px square, centred at (cx, y). */
  function drawQr(text, cx, y, size) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), cell = Math.floor(size / n), q = cell * n, x0 = cx - q / 2;
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(x0 + c * cell, y + r * cell, cell, cell);
    return q;
  }

  /** The QR strip along the bottom: the join QR, and your LINK QR beside it if there is one. */
  function drawQrStrip(top) {
    const { w, h } = BADGE;
    g.fillStyle = '#fff';
    g.fillRect(0, top, w, h - top);
    g.fillStyle = '#000';
    g.fillRect(0, top, w, 4);
    const size = Math.min(170, h - top - 70), y = top + 22;
    const cells = st.link ? [[st.link, 'FOLLOW'], [host.link, 'JOIN IN']] : [[host.link, 'JOIN IN']];
    cells.forEach(([url, label], k) => {
      const cx = st.link ? (k ? w * 0.72 : w * 0.28) : w * 0.3;
      const q = drawQr(url, cx, y, size);
      g.textAlign = 'center';
      g.font = `700 22px ${font}`;
      g.fillText(label, cx, y + q + 22);
    });
    if (!st.link) {                         // one QR: the callsign beside it
      g.textAlign = 'left';
      g.font = `700 28px ${font}`;
      g.fillText('SCAN TO', w * 0.55, y + 50);
      g.fillText('JOIN IN', w * 0.55, y + 86);
      g.font = `20px ${font}`;
      g.fillText('ask for an access code', w * 0.55, y + 126);
    }
  }

  /** SPLASH: the badge between guests. INTRO introduces the rig; ARTWORK is your picture. */
  function drawSplash() {
    const { w, h } = BADGE, strip = st.qrStrip ? 740 : h;
    g.textBaseline = 'middle';
    if (st.look === 'art') {
      if (art) badgeCrop(g, art, st.art);
      else {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#000';
        g.textAlign = 'center';
        g.font = `700 30px ${font}`;
        g.fillText('PICK ARTWORK', w / 2, strip / 2);
      }
      if (st.qrStrip) drawQrStrip(strip);
      return;
    }
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, 150);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = `700 60px ${font}`;
    g.fillText('STEAMWorkz', w / 2, 60);
    g.font = `24px ${font}`;
    g.fillText('CYBER RIG  //  NIGHT CITY EDITION', w / 2, 118);
    g.fillStyle = '#000';
    g.font = `700 26px ${font}`;
    g.fillText('A LIGHT-UP CYBERPUNK COSTUME', w / 2, 200);
    const parts = [['MASK', 'reactive light intakes'], ['HAT', '32×16 LED display'], ['WATCH', 'runs the whole rig'],
      ['BOLT', 'a rolling robot sidekick'], ['BADGE', 'this e-ink screen']];
    const gap = st.qrStrip ? 72 : 96, y0 = st.qrStrip ? 270 : 300;
    parts.forEach(([name, what], k) => {
      const y = y0 + k * gap;
      g.textAlign = 'left';
      g.font = `700 30px ${font}`;
      g.fillText(name, 56, y);
      g.font = `24px ${font}`;
      g.fillText(what, 190, y);
      g.fillRect(56, y + 26, w - 112, 1);
    });
    g.textAlign = 'center';
    let px = 40;                             // the callsign, as big as fits
    do g.font = `700 ${px--}px ${font}`; while (g.measureText(st.callsign).width > w - 60 && px > 18);
    g.fillText(st.callsign, w / 2, st.qrStrip ? 690 : 860);
    if (st.qrStrip) drawQrStrip(strip);
    else {
      g.font = `22px ${font}`;
      g.fillText('ask about the rig  ·  ask to play', w / 2, 910);
    }
  }

  /** INVITES' preview: the newest code still waiting, as the badge shows it. */
  function drawInvitesPreview() {
    const v = host.recentInvites().find((r) => r.live);
    if (v) return drawInvite(v.live);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, BADGE.w, BADGE.h);
    g.fillStyle = '#000';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 30px ${font}`;
    g.fillText('NO CODE WAITING', BADGE.w / 2, 440);
    g.font = `24px ${font}`;
    g.fillText('INVITE (guest bar) makes one', BADGE.w / 2, 490);
  }

  /** INVITE: WANNA EDGERUN?, the guest QR and this guest's one-time password, big. */
  function drawInvite(v) {
    const { w, h } = BADGE;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, 150);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 50px ${font}`;
    g.fillText('WANNA EDGERUN?', w / 2, 58);
    g.font = `24px ${font}`;                     // Night City: every script on the street
    g.fillText(['ja', 'ko', 'zh-TW', 'vi'].map((l) => words(l).jackIn).join('  ·  '), w / 2, 112);
    g.fillStyle = '#000';
    drawQr(host.inviteLink(v), w / 2, 190, 420);   // scanning it fills the code in
    g.font = `700 26px ${font}`;
    g.fillText('ACCESS CODE', w / 2, 650);
    g.font = `700 104px ${font}`;
    g.fillText(showCode(v.code), w / 2, 735);
    g.fillRect(40, 800, w - 80, 4);
    g.font = `24px ${font}`;
    g.fillText('one phone  ·  15 min  ·  scan, then type it', w / 2, 846);
    g.font = `700 30px ${font}`;
    g.fillText(st.callsign, w / 2, 908);
  }

  /** HIGH SCORES: the top eight from DEBUG, handles in their own script, and a way in. */
  function drawScores() {
    const { w } = BADGE, board = host.board.slice(0, 8);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, BADGE.h);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, 140);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 58px ${font}`;
    g.fillText('HIGH SCORES', w / 2, 56);
    g.font = `22px ${font}`;
    g.fillText('DEBUG // BYTE vs BUG.EXE', w / 2, 108);
    g.fillStyle = '#000';
    if (!board.length) {
      g.font = `700 34px ${font}`;
      g.fillText('NO RUNNERS YET', w / 2, 380);
      g.font = `26px ${font}`;
      g.fillText('be the first to beat BUG.EXE', w / 2, 430);
    }
    board.forEach((b, i) => {
      const y = 196 + i * 68, top = i === 0;
      if (top) { g.fillRect(24, y - 32, w - 48, 64); g.fillStyle = '#fff'; }
      g.textAlign = 'left';
      g.font = `700 ${top ? 40 : 34}px ${font}`;
      g.fillText(String(i + 1), 44, y);
      let px = top ? 36 : 32;                  // the handle, as big as fits beside the time
      do g.font = `700 ${px--}px ${font}`; while (g.measureText(b.name).width > 300 && px > 16);
      g.fillText(b.name, 96, y);
      g.textAlign = 'right';
      g.font = `700 ${top ? 40 : 34}px ${font}`;
      g.fillText(mmss(b.ms), w - 44, y);
      g.fillStyle = '#000';
      if (!top) g.fillRect(40, y + 32, w - 80, 1);
    });
    drawQr(host.link, 130, 760, 170);           // think you're faster? the way in
    g.textAlign = 'left';
    g.font = `700 30px ${font}`;
    g.fillText('THINK YOU', 240, 790);
    g.fillText('CAN BEAT IT?', 240, 830);
    g.font = `24px ${font}`;
    g.fillText('ask for an access code', 240, 874);
    g.font = `700 22px ${font}`;
    g.fillText(st.callsign, 240, 912);
  }

  function render() {
    if (st.kind === 'splash') drawSplash();
    else if (st.kind === 'scores') drawScores();
    else if (st.kind === 'invites') drawInvitesPreview();
    else if (photo) badgeCrop(g, photo, st);
    else { g.fillStyle = '#fff'; g.fillRect(0, 0, BADGE.w, BADGE.h); }
    const img = g.getImageData(0, 0, BADGE.w, BADGE.h);
    // Pictures get contrast + dithering; the text / QR screens are black and white already.
    grey = adjusting() ? toGrey16(img, adj()) : toGrey16(img, { dither: false });
    paintGrey($('badgePreview'), grey);
  }
  let pending = 0;
  const renderSoon = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(render); };

  function show() {
    segShow('badgeKind', 'kind', st.kind);
    segShow('badgeDither', 'dither', adj().dither ? 1 : 0);
    segShow('badgeTurn', 'turn', st.turn);
    for (const p of document.querySelectorAll('#view-badge [data-pane]')) p.hidden = !p.dataset.pane.split(' ').includes(st.kind);
    $('badgeAdjust').hidden = !adjusting();
    segShow('splashLook', 'look', st.look);
    segShow('splashQr', 'qr', st.qrStrip ? 1 : 0);
    $('splashArtPick').hidden = st.look !== 'art';
    $('badgeSend').parentElement.hidden = st.kind === 'invites';
    $('badgeSend').firstChild.textContent = { splash: 'SAVE AS SPLASH', scores: 'SAVE AS SCORES', photo: 'SEND AS PORTRAIT' }[st.kind] || '';
    renderInvites();
    segShow('badgeMode', 'mode', st.mode);
    $('badgeHold').value = st.hold;
    $('badgeHoldOut').textContent = st.hold >= 60 ? `${Math.round(st.hold / 6) / 10} min` : `${st.hold} s`;
    $('badgeLink').value = st.link;
    $('badgeCall').value = st.callsign;
    for (const [id, k, f] of [['badgeZoom', 'zoom', (v) => `${Math.round(v * 100)}%`],
      ['badgeContrast', 'contrast', (v) => `${Math.round(v * 100)}%`], ['badgeBright', 'brightness', (v) => `${v > 0 ? '+' : ''}${v}`]]) {
      $(id).value = adj()[k];
      $(id + 'Out').textContent = f(adj()[k]);
    }
    renderSoon();
  }

  segPick('badgeKind', 'kind', (k) => { st.kind = k; save(); show(); });
  segPick('badgeDither', 'dither', (v) => { adj().dither = v === '1'; save(); show(); });
  segPick('splashLook', 'look', (v) => { st.look = v; save(); show(); });
  segPick('splashQr', 'qr', (v) => { st.qrStrip = v === '1'; save(); show(); });
  $('splashFile').addEventListener('change', async () => {
    const file = $('splashFile').files[0];
    if (!file) return;
    try {
      [{ image: art }] = await decodeImage(file, 1);
      Object.assign(st.art, { zoom: 1, panX: 0, panY: 0 });
      st.look = 'art';
      save();
      show();
    } catch (err) {
      showBanner(`Couldn't read that image: ${err.message}`);
    }
  });
  segPick('badgeTurn', 'turn', (v) => { st.turn = v; save(); show(); });
  $('badgeLink').addEventListener('change', () => {
    const v = $('badgeLink').value.trim();
    st.link = !v || /^https?:\/\//i.test(v) ? v : `https://${v}`;   // instagram.com/you works too
    save();
    show();
  });
  const sendMode = () => badge.connected && badge.setMode(st.mode, st.hold).catch((err) => showBanner(`Badge: ${err.message}`));
  segPick('badgeMode', 'mode', (v) => { st.mode = Number(v); save(); show(); sendMode(); });
  $('badgeHold').addEventListener('input', () => { st.hold = Number($('badgeHold').value); save(); show(); });
  $('badgeHold').addEventListener('change', sendMode);
  $('badgeCall').addEventListener('input', () => {
    st.callsign = $('badgeCall').value.toUpperCase().replace(/[^ -~]/g, '').slice(0, 16) || DEFAULTS.callsign;
    save();
    renderSoon();
  });
  for (const [id, k] of [['badgeZoom', 'zoom'], ['badgeContrast', 'contrast'], ['badgeBright', 'brightness']]) {
    $(id).addEventListener('input', () => { adj()[k] = Number($(id).value); save(); show(); });
  }
  $('badgeFile').addEventListener('change', async () => {
    const file = $('badgeFile').files[0];
    if (!file) return;
    try {
      [{ image: photo }] = await decodeImage(file, 1);
      Object.assign(st, { kind: 'photo', zoom: 1, panX: 0, panY: 0 });
      save();
      show();
    } catch (err) {
      showBanner(`Couldn't read that image: ${err.message}`);
    }
  });

  // Drag the preview to move the photo inside the frame.
  let drag = null;
  const cv = $('badgePreview');
  cv.addEventListener('pointerdown', (e) => {
    if (!adjusting() || !pic()) return;
    drag = { x: e.clientX, y: e.clientY, panX: adj().panX, panY: adj().panY };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = cv.getBoundingClientRect();
    // Moving a full preview width shifts the photo by its whole spare width (pan -1..1).
    const a = adj(), k = 2 / Math.max(0.2, a.zoom);
    a.panX = Math.max(-1, Math.min(1, drag.panX + ((e.clientX - drag.x) / r.width) * k * -1));
    a.panY = Math.max(-1, Math.min(1, drag.panY + ((e.clientY - drag.y) / r.height) * k * -1));
    renderSoon();
  });
  const endDrag = () => { if (drag) { drag = null; save(); } };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  // ---------- sending ----------
  $('badgeSend').addEventListener('click', async () => {
    if (!badge.connected) return showBanner('Connect the badge first (tap the Badge chip).');
    if (st.kind === 'photo' && !photo) return showBanner('Pick a photo first.');
    if (st.kind === 'splash' && st.look === 'art' && !art) return showBanner('Pick the artwork first.');
    render();
    $('badgeSend').disabled = true;
    try {
      const bytes = await badge.sendFrame(packBadge(grey, st.turn), KIND_SLOT[st.kind]);
      showBanner(`On the badge (${Math.round(bytes / 1024)} KB sent).`);
    } catch (err) {
      showBanner(`Badge: ${err.message}`);
    } finally {
      $('badgeSend').disabled = false;
    }
  });
  $('badgeClear').addEventListener('click', () => badge.clear().catch((err) => showBanner(`Badge: ${err.message}`)));
  const showSlot = (slot, what) => () => {
    if (!badge.connected) return showBanner('Connect the badge first (tap the Badge chip).');
    badge.show(slot).catch(() => showBanner(`The badge has no ${what} yet: SAVE one first.`));
  };
  $('badgeShowSplash').addEventListener('click', showSlot(SLOT.SPLASH, 'splash screen'));

  // ---------- INVITES: the last five codes ----------
  const INV_STATE = { waiting: 'waiting', used: 'used', revoked: 'revoked', expired: 'expired' };
  function renderInvites() {
    if (st.kind !== 'invites') return;
    const rows = host.recentInvites().map((r) => {
      const row = document.createElement('div');
      row.className = `gitem ${r.live ? 'pending' : ''}`;
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = showCode(r.code);
      const sub = document.createElement('small');
      sub.textContent = r.live ? `waiting · ${mmss(r.live.until - Date.now())} left` : r.by ? `used by ${r.by}` : INV_STATE[r.state];
      who.append(sub);
      row.append(who);
      if (r.live) {
        const b = document.createElement('button');
        b.className = 'yes';
        b.textContent = 'SHOW';
        b.addEventListener('click', () => showInvite?.(r.live));
        row.append(b);
      }
      return row;
    });
    $('badgeInvites').replaceChildren(...rows);
    if (!rows.length) $('badgeInvites').textContent = 'No codes yet: INVITE in the guest bar makes one.';
  }
  setInterval(() => { if (st.kind === 'invites') { renderInvites(); renderSoon(); } }, 5000);
  $('badgeShowScores').addEventListener('click', showSlot(SLOT.SCORES, 'scores'));
  badge.addEventListener('ready', sendMode);           // the badge learns WORN / TABLE on connect
  badge.addEventListener('progress', (e) => {
    $('badgeBar').style.width = `${Math.round(e.detail * 100)}%`;
    $('badgeSend').classList.toggle('busy', e.detail < 1);
  });
  const info = () => {
    const i = badge.info;
    const portraits = i ? [2, 3, 4, 5].filter((s) => i.slots & (1 << s)).length : 0;
    $('badgeInfo').textContent = badge.connected
      ? `Linked${i?.mv ? `, battery ${(i.mv / 1000).toFixed(2)} V` : ''}` +
        (i ? `. Saved: ${i.slots & 1 ? 'splash' : 'no splash'}, ${i.slots & 128 ? 'scores' : 'no scores'}, ${portraits} portrait${portraits === 1 ? '' : 's'}.` : '.') +
        ' A full picture takes about 10–20 s; showing a saved one is instant.'
      : 'Not linked: tap the Badge chip at the top.';
  };
  badge.addEventListener('info', info);
  badge.addEventListener('status', info);
  host.addEventListener('change', () => {
    if (st.kind !== 'photo') renderSoon();
    renderInvites();
  });
  info();
  show();

  // ---------- invites (main.js INVITE): the badge shows WANNA EDGERUN? + the password ----------
  let onBadge = null;                   // the invite code the badge is showing, if any
  async function sendInvite(v) {
    if (!badge.connected) return false;
    if (badge.busy) { showBanner('Badge busy: the invite shows on your phone only.'); return false; }
    drawInvite(v);
    const img = g.getImageData(0, 0, BADGE.w, BADGE.h);
    const frame = packBadge(toGrey16(img, { dither: false }), st.turn);
    render();                           // the preview goes back to what the tab was showing
    onBadge = v.code;
    try {
      await badge.sendFrame(frame, SLOT.INVITE);
      if (onBadge !== v.code) await badge.show(SLOT.SPLASH);  // used up while it was sending
      return true;
    } catch (err) {
      showBanner(`Badge: ${err.message}`);
      return false;
    }
  }
  // The code is gone (used, revoked, expired, GUESTS off): SPLASH goes back up.
  host.addEventListener('change', () => {
    if (!onBadge || host.invites.some((v) => v.code === onBadge)) return;
    onBadge = null;
    if (badge.connected && !badge.busy) badge.show(SLOT.SPLASH).catch(() => {});
  });
  // ---------- HIGH SCORES on the badge: refreshed after every win ----------
  // A new top time puts them on the badge (WORN: for HOLD, then back to SPLASH); any other
  // change is saved quietly for KEY 1 / the slideshow. A busy badge gets it on the next try.
  let scoresSig = JSON.stringify(host.board), topSig = JSON.stringify(host.board[0] || null), scoresDue = null;
  async function sendScores(show) {
    if (!badge.connected) return;
    if (badge.busy) { scoresDue = !!(scoresDue || show); return; }   // a NEW RECORD stays a show
    scoresDue = null;
    drawScores();
    const frame = packBadge(toGrey16(g.getImageData(0, 0, BADGE.w, BADGE.h), { dither: false }), st.turn);
    render();
    try { await badge.sendFrame(frame, SLOT.SCORES, { quiet: !show }); } catch {}
  }
  host.addEventListener('change', () => {
    const sig = JSON.stringify(host.board), top = JSON.stringify(host.board[0] || null);
    if (sig === scoresSig) return;
    const record = top !== topSig && host.board.length > 0;
    scoresSig = sig;
    topSig = top;
    sendScores(record);
  });
  setInterval(() => { if (scoresDue !== null) sendScores(scoresDue); }, 5000);

  return { sendInvite };
}
