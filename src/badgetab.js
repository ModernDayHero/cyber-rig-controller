// BADGE tab: the e-ink badge's picture. Two kinds, both drawn here at the badge's own
// 540 x 960 (portrait) and sent finished; the badge only shows what it's given.
//   LOGIN  the guest QR (guests.js link), the callsign and a JACK IN bar
//   PHOTO  any picture, cropped (drag it / ZOOM), contrast, 16 greys with dithering
// The badge keeps its last picture with the power off, so it can sit on one all night.

import qrcode from 'qrcode-generator';
import { decodeImage, badgeCrop, toGrey16, packBadge, paintGrey, BADGE } from './image.js';

const STORE_KEY = 'rig-badge';
const DEFAULTS = { kind: 'login', callsign: 'MODERNDAYHERO', turn: 'cw', zoom: 1, panX: 0, panY: 0, contrast: 1.2, brightness: 0, dither: true };

export function setupBadge({ rig, host, $, segPick, segShow, showBanner }) {
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

  function render() {
    if (st.kind === 'login') drawLogin();
    else if (photo) badgeCrop(g, photo, st);
    else { g.fillStyle = '#fff'; g.fillRect(0, 0, BADGE.w, BADGE.h); }
    const img = g.getImageData(0, 0, BADGE.w, BADGE.h);
    // The login screen is already black and white: no dither, no contrast games.
    grey = st.kind === 'login' ? toGrey16(img, { dither: false }) : toGrey16(img, st);
    paintGrey($('badgePreview'), grey);
  }
  let pending = 0;
  const renderSoon = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(render); };

  function show() {
    segShow('badgeKind', 'kind', st.kind);
    segShow('badgeDither', 'dither', st.dither ? 1 : 0);
    segShow('badgeTurn', 'turn', st.turn);
    for (const p of document.querySelectorAll('#view-badge [data-pane]')) p.hidden = p.dataset.pane !== st.kind;
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
  const badge = rig.badge;
  $('badgeSend').addEventListener('click', async () => {
    if (!badge.connected) return showBanner('Connect the badge first (tap the Badge chip).');
    if (st.kind === 'photo' && !photo) return showBanner('Pick a photo first.');
    render();
    $('badgeSend').disabled = true;
    try {
      const bytes = await badge.sendFrame(packBadge(grey, st.turn));
      showBanner(`On the badge (${Math.round(bytes / 1024)} KB sent).`);
    } catch (err) {
      showBanner(`Badge: ${err.message}`);
    } finally {
      $('badgeSend').disabled = false;
    }
  });
  $('badgeClear').addEventListener('click', () => badge.clear().catch((err) => showBanner(`Badge: ${err.message}`)));
  badge.addEventListener('progress', (e) => {
    $('badgeBar').style.width = `${Math.round(e.detail * 100)}%`;
    $('badgeSend').classList.toggle('busy', e.detail < 1);
  });
  const info = () => {
    const i = badge.info;
    $('badgeInfo').textContent = badge.connected
      ? `Linked${i?.mv ? `, battery ${(i.mv / 1000).toFixed(2)} V` : ''}. A full frame takes about 10–20 s.`
      : 'Not linked: tap the Badge chip at the top.';
  };
  badge.addEventListener('info', info);
  badge.addEventListener('status', info);
  host.addEventListener('change', () => { if (st.kind === 'login') renderSoon(); });   // OPEN / closed line
  info();
  show();
}
