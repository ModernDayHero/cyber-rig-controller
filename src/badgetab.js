// BADGE tab: the e-ink badge's screens, drawn here at the badge's own 540 x 960
// (portrait) and sent finished into the badge's slots; the badge only shows them.
//   LOGIN  slot 0: the guest QR (guests.js link), the callsign and a JACK IN bar
//   CARD   slot 1: the STEAMWorkz card, two QRs: the GitHub repo and the guest page
//   PHOTO  a guest portrait (slots 2-5, the badge keeps the last four): any picture,
//          cropped (drag it / ZOOM), contrast, 16 greys with dithering
// KEY 1 on the badge flips LOGIN <-> CARD; KEY 2 steps through the portraits. WORN /
// TABLE (SET → BADGE) decides what happens after a portrait.

import qrcode from 'qrcode-generator';
import { decodeImage, badgeCrop, toGrey16, packBadge, paintGrey, BADGE } from './image.js';
import { SLOT } from './ble/badge.js';
import { showCode } from './guests.js';
import { words } from './i18n.js';

const STORE_KEY = 'rig-badge';
export const REPO_URL = 'https://github.com/ModernDayHero/cyber-rig-controller';
const DEFAULTS = {
  kind: 'login', callsign: 'MODERNDAYHERO', turn: 'cw', zoom: 1, panX: 0, panY: 0, contrast: 1.2, brightness: 0,
  dither: true, mode: 0, hold: 180, repo: REPO_URL,
};
const KIND_SLOT = { login: SLOT.LOGIN, card: SLOT.CARD, photo: SLOT.GUEST };

export function setupBadge({ rig, host, $, segPick, segShow, showBanner }) {
  const badge = rig.badge;
  let st = { ...DEFAULTS };
  try { st = { ...st, ...JSON.parse(localStorage.getItem(STORE_KEY)) }; } catch {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch {} };
  let photo = null, grey = null;
  const work = document.createElement('canvas');
  work.width = BADGE.w;
  work.height = BADGE.h;
  const g = work.getContext('2d', { willReadFrequently: true });
  const font = getComputedStyle(document.body).fontFamily;

  /** The login screen: black on white, the QR big enough to scan across a room. */
  function drawLogin() {
    const { w, h } = BADGE;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 26px ${font}`;
    g.fillText('STEAMWorkz // NETRUNNER', w / 2, 62);

    const qr = qrcode(0, 'M');
    qr.addData(host.link);
    qr.make();
    const n = qr.getModuleCount(), size = 460, cell = Math.floor(size / n), q = cell * n;
    const x0 = (w - q) / 2, y0 = 110 + (size - q) / 2;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(x0 + c * cell, y0 + r * cell, cell, cell);

    let px = 64;                                  // callsign, as big as fits
    do g.font = `700 ${px--}px ${font}`; while (g.measureText(st.callsign).width > w - 50 && px > 20);
    g.fillText(st.callsign, w / 2, 640);

    g.fillRect(24, 700, w - 48, 110);
    g.fillStyle = '#fff';
    g.font = `700 64px ${font}`;
    g.fillText('JACK IN', w / 2, 757);
    g.fillStyle = '#555';
    g.font = `22px ${font}`;
    g.fillText('scan  ·  ask to jack in  ·  play the rig', w / 2, 860);
    g.fillText(host.enabled ? 'GUEST PORT OPEN' : 'guest port opens at the party', w / 2, 900);
  }

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

  /** The STEAMWorkz card: who's wearing it, the code behind it, and the way in. */
  function drawCard() {
    const { w, h } = BADGE;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, 120);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 52px ${font}`;
    g.fillText('STEAMWorkz', w / 2, 50);
    g.font = `22px ${font}`;
    g.fillText('CYBER RIG // NIGHT CITY', w / 2, 96);
    g.fillStyle = '#000';
    let px = 46;
    do g.font = `700 ${px--}px ${font}`; while (g.measureText(st.callsign).width > w - 60 && px > 18);
    g.fillText(st.callsign, w / 2, 168);

    const size = 290;
    g.font = `700 24px ${font}`;
    g.fillText('BUILD ONE // THE CODE', w / 2, 226);
    drawQr(st.repo || REPO_URL, w / 2, 250, size);
    g.fillText('JACK IN // GUESTS', w / 2, 590);
    drawQr(host.link, w / 2, 614, size);
    g.fillStyle = '#555';
    g.font = `20px ${font}`;
    g.fillText('ask the netrunner for a password', w / 2, 936);
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
    drawQr(host.link, w / 2, 190, 420);
    g.font = `700 26px ${font}`;
    g.fillText('PASSWORD', w / 2, 650);
    g.font = `700 104px ${font}`;
    g.fillText(showCode(v.code), w / 2, 735);
    g.fillRect(40, 800, w - 80, 4);
    g.font = `24px ${font}`;
    g.fillText('one phone  ·  15 min  ·  scan, then type it', w / 2, 846);
    g.font = `700 30px ${font}`;
    g.fillText(st.callsign, w / 2, 908);
  }

  function render() {
    if (st.kind === 'login') drawLogin();
    else if (st.kind === 'card') drawCard();
    else if (photo) badgeCrop(g, photo, st);
    else { g.fillStyle = '#fff'; g.fillRect(0, 0, BADGE.w, BADGE.h); }
    const img = g.getImageData(0, 0, BADGE.w, BADGE.h);
    // The QR screens are already black and white: no dither, no contrast games.
    grey = st.kind !== 'photo' ? toGrey16(img, { dither: false }) : toGrey16(img, st);
    paintGrey($('badgePreview'), grey);
  }
  let pending = 0;
  const renderSoon = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(render); };

  function show() {
    segShow('badgeKind', 'kind', st.kind);
    segShow('badgeDither', 'dither', st.dither ? 1 : 0);
    segShow('badgeTurn', 'turn', st.turn);
    for (const p of document.querySelectorAll('#view-badge [data-pane]')) p.hidden = !p.dataset.pane.split(' ').includes(st.kind);
    $('badgeSend').firstChild.textContent = { login: 'SAVE AS LOGIN SCREEN', card: 'SAVE AS CARD', photo: 'SEND AS PORTRAIT' }[st.kind];
    segShow('badgeMode', 'mode', st.mode);
    $('badgeHold').value = st.hold;
    $('badgeHoldOut').textContent = st.hold >= 60 ? `${Math.round(st.hold / 6) / 10} min` : `${st.hold} s`;
    $('badgeRepo').value = st.repo;
    $('badgeCall').value = st.callsign;
    for (const [id, k, f] of [['badgeZoom', 'zoom', (v) => `${Math.round(v * 100)}%`],
      ['badgeContrast', 'contrast', (v) => `${Math.round(v * 100)}%`], ['badgeBright', 'brightness', (v) => `${v > 0 ? '+' : ''}${v}`]]) {
      $(id).value = st[k];
      $(id + 'Out').textContent = f(st[k]);
    }
    renderSoon();
  }

  segPick('badgeKind', 'kind', (k) => { st.kind = k; save(); show(); });
  segPick('badgeDither', 'dither', (v) => { st.dither = v === '1'; save(); show(); });
  segPick('badgeTurn', 'turn', (v) => { st.turn = v; save(); show(); });
  $('badgeRepo').addEventListener('change', () => { st.repo = $('badgeRepo').value.trim() || REPO_URL; save(); show(); });
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
    $(id).addEventListener('input', () => { st[k] = Number($(id).value); save(); show(); });
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
    if (st.kind !== 'photo' || !photo) return;
    drag = { x: e.clientX, y: e.clientY, panX: st.panX, panY: st.panY };
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = cv.getBoundingClientRect();
    // Moving a full preview width shifts the photo by its whole spare width (pan -1..1).
    const k = 2 / Math.max(0.2, st.zoom);
    st.panX = Math.max(-1, Math.min(1, drag.panX + ((e.clientX - drag.x) / r.width) * k * -1));
    st.panY = Math.max(-1, Math.min(1, drag.panY + ((e.clientY - drag.y) / r.height) * k * -1));
    renderSoon();
  });
  const endDrag = () => { if (drag) { drag = null; save(); } };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  // ---------- sending ----------
  $('badgeSend').addEventListener('click', async () => {
    if (!badge.connected) return showBanner('Connect the badge first (tap the Badge chip).');
    if (st.kind === 'photo' && !photo) return showBanner('Pick a photo first.');
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
  $('badgeShowLogin').addEventListener('click', showSlot(SLOT.LOGIN, 'login screen'));
  $('badgeShowCard').addEventListener('click', showSlot(SLOT.CARD, 'card'));
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
        (i ? `. Saved: ${i.slots & 1 ? 'login' : 'no login'}, ${i.slots & 2 ? 'card' : 'no card'}, ${portraits} portrait${portraits === 1 ? '' : 's'}.` : '.') +
        ' A full picture takes about 10–20 s; showing a saved one is instant.'
      : 'Not linked: tap the Badge chip at the top.';
  };
  badge.addEventListener('info', info);
  badge.addEventListener('status', info);
  host.addEventListener('change', () => { if (st.kind === 'login') renderSoon(); });   // OPEN / closed line
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
      if (onBadge !== v.code) await badge.show(SLOT.LOGIN);   // used up while it was sending
      return true;
    } catch (err) {
      showBanner(`Badge: ${err.message}`);
      return false;
    }
  }
  // The password is gone (used, revoked, expired, GUESTS off): the login QR goes back up.
  host.addEventListener('change', () => {
    if (!onBadge || host.invites.some((v) => v.code === onBadge)) return;
    onBadge = null;
    if (badge.connected && !badge.busy) badge.show(SLOT.LOGIN).catch(() => {});
  });
  return { sendInvite };
}
