// SET -> MOTORS: the plugin on / off, guests' cap, TEST, MOTORS A | B | BOTH for the lights,
// MATCH (one pattern's MATCH LIGHTS), SOUND, SHAKE, MOTIONS (which are offered, and their
// SPEED / SIZE), the link from each lighting pattern to a motion, and FIRMWARE.
// With TEST on, changing a setting also plays it on the motors (via the controller).

import { MOTION_DEFS, MOTIONS, MOTION_LABEL, LINKABLE, MATCHES, matchCfg, matchDefault, motionOf, tuneOf } from '../motions.js';
import { bundledFirmware } from '../ble.js';
import { modeOf } from '../../config.js';
import { useButtons, motionTile, slider, showSlider } from './common.js';

export function setupSettings(ui) {
  const { rig, ctl, $, segPick, segShow, showBanner } = ui;

  segPick('motorsOn', 'on', (v) => ctl.set({ on: v === '1' }));
  segPick('motorCap', 'cap', (v) => ctl.set({ cap: Number(v) }));
  segPick('motorTestOn', 'on', (v) => ctl.set({ test: v === '1' }));
  $('setTestStop').addEventListener('click', () => ctl.stopTest());

  // ---- MOTIONS: a tile per motion (on = offered in the links); 1st tap tunes it, 2nd toggles it
  const motionEls = Object.entries(MOTION_DEFS).map(([key, d]) => {
    const b = motionTile(d.label, () => {
      if (ui.tuning !== key) {
        ui.tuning = key;
        if (rig.state.motors.test) ctl.testMotion(key, { again: true });   // TEST on: and feel it
        return ui.render();
      }
      const off = { ...rig.state.motors.off };
      if (off[key]) delete off[key]; else off[key] = true;
      ctl.set({ off });
    });
    $('motionGrid').append(b);
    return [key, b];
  });
  for (const [id, prop] of [['motionSpeed', 'speed'], ['motionSize', 'size']]) {
    slider($, id, '%', 300, (v) => {
      const m = rig.state.motors;
      ctl.set({ tune: { ...m.tune, [ui.tuning]: { ...tuneOf(m, ui.tuning), [prop]: v } } });
    });
  }
  $('motionReset').addEventListener('click', () => {
    const tune = { ...rig.state.motors.tune };
    delete tune[ui.tuning];
    ctl.set({ tune });
  });

  // ---- links: one row per lighting pattern
  const linkEls = LINKABLE.map(([key, name]) => {
    const row = document.createElement('div');
    row.className = 'mlink';
    const label = document.createElement('span');
    label.textContent = name.toUpperCase();
    const sel = document.createElement('select');
    sel.className = 'text';
    for (const m of MOTIONS) sel.append(new Option(MOTION_LABEL[m], m));
    sel.addEventListener('change', () => {
      ctl.set({ links: { ...rig.state.motors.links, [key]: sel.value } });
      if (!rig.state.motors.test) return;                               // TEST on: play the new link
      if (sel.value === 'none') ctl.stopTest(); else ctl.testMotion(sel.value, { again: true, key });
    });
    row.append(label, sel);
    $('motorLinks').append(row);
    return [key, sel];
  });
  $('motorMatchAll').addEventListener('click', () => {
    const links = { ...rig.state.motors.links };
    for (const [key] of LINKABLE) links[key] = key === 'A' ? 'sound' : MATCHES(key) ? 'lights' : 'none';
    const off = { ...rig.state.motors.off };
    delete off.lights;
    ctl.set({ links, off });
    showBanner('Every pattern now moves the motors like its lights (left = A, right = B).');
  });

  // ---- MATCH: one pattern's MATCH LIGHTS (follows what the rig shows until one is picked)
  const matchKeys = LINKABLE.filter(([k]) => MATCHES(k));
  for (const [k, name] of matchKeys) $('matchKey').append(new Option(name.toUpperCase(), k));
  let matchKey = matchKeys[0][0], matchPicked = false;
  const playMatch = () => { if (rig.state.motors.test) ctl.testMotion('lights', { again: true, key: matchKey }); };
  $('matchKey').addEventListener('change', () => {
    matchKey = $('matchKey').value;
    matchPicked = true;
    playMatch();
    ui.render();
  });
  const setMatch = (patch) => {
    const m = rig.state.motors, cur = { ...m.match?.[matchKey], ...patch };
    const playing = ctl.test?.motion === 'lights' && ctl.test.key === matchKey;
    ctl.set({ match: { ...m.match, [matchKey]: cur } });                 // (replays it if it's playing)
    if (!playing) playMatch();
  };
  const signed = (v, unit) => `${v > 0 ? '+' : ''}${v}${unit}`;
  segPick('matchRight', 'right', (v) => setMatch({ right: v }));
  slider($, 'matchLevel', '%', 300, (v) => setMatch({ level: v }));
  slider($, 'matchSpeed', '%', 300, (v) => setMatch({ speed: v }));
  slider($, 'matchShift', ' ms', 300, (v) => setMatch({ shift: v }));
  $('matchShift').addEventListener('input', () => { $('matchShiftOut').textContent = signed(Number($('matchShift').value), ' ms'); });
  $('matchReset').addEventListener('click', () => {
    const match = { ...rig.state.motors.match };
    delete match[matchKey];
    ctl.set({ match });
  });

  // ---- SOUND and SHAKE
  slider($, 'soundGain', '%', 150, (v) => ctl.set({ sound: { ...rig.state.motors.sound, gain: v } }));
  slider($, 'soundSize', '%', 150, (v) => ctl.set({ sound: { ...rig.state.motors.sound, size: v } }));
  segPick('soundRight', 'right', (v) => ctl.set({ sound: { ...rig.state.motors.sound, right: v } }));
  segPick('motorShake', 'shake', (v) => {
    ctl.set({ shake: v });
    if (rig.state.motors.test && v !== 'off') ctl.shake(6, { preview: true });   // TEST on: feel it
  });
  ctl.sound.addEventListener('level', () => { $('soundBar').style.width = `${Math.round(ctl.sound.level * 100)}%`; });

  // ---- FIRMWARE: is the board's plugin this deck's? If not, update it over Bluetooth.
  let bundled = null, updating = false;
  async function renderFirmware() {
    const m = rig.motor, el = $('fwState'), btn = $('fwUpdate');
    if (!m.connected) { el.textContent = 'connect the plugin to check'; btn.hidden = $('fwHint').hidden = true; return; }
    bundled ??= await bundledFirmware().catch(() => null);
    const same = bundled && m.fwCrc === bundled.crc;
    el.textContent = updating ? 'updating…'
      : !m.fwCrc ? (m.channels.length || m.status === 'connected' ? "the board's firmware is too old to update over Bluetooth: copy main.py over USB once" : 'checking…')
        : same ? `up to date (${m.fwCrc})` : `update available: board ${m.fwCrc}, deck ${bundled?.crc ?? '?'}`;
    btn.hidden = $('fwHint').hidden = !m.fwCrc || same;
    btn.disabled = updating;
  }
  $('fwUpdate').addEventListener('click', async () => {
    if (updating || !bundled) return;
    updating = true;
    ctl.stopTest();
    const bar = $('fwBar');
    renderFirmware();
    try {
      await rig.motor.upload('main.py', bundled.bytes, (p) => { bar.style.width = `${Math.round(p * 100)}%`; });
      showBanner('Motor firmware updated: the board is restarting and reconnects by itself.');
    } catch (e) {
      showBanner(`Motor update failed: ${e.message}. Nothing changed on the board; try again.`);
    } finally {
      updating = false;
      bar.style.width = '0';
      renderFirmware();
    }
  });
  for (const ev of ['firmware', 'status', 'channels']) rig.motor.addEventListener(ev, renderFirmware);

  // ---- render
  let useSig = '';
  ui.renders.push((s) => {
    const m = s.motors;
    segShow('motorsOn', 'on', m.on ? 1 : 0);
    segShow('motorCap', 'cap', m.cap);
    segShow('motorTestOn', 'on', m.test ? 1 : 0);
    $('motorsBody').hidden = !m.on;

    // the green TEST strip
    const t = ctl.test;
    $('setTestBar').hidden = !m.test;
    if (m.test) {
      const pat = (k) => LINKABLE.find(([x]) => x === k)?.[1].toUpperCase() ?? k;
      $('setTestNow').textContent = !rig.motor.connected ? 'TEST: connect the plugin to feel the settings'
        : t?.motion ? `TESTING ${MOTION_LABEL[t.motion]}${t.motion === 'lights' ? ` · ${pat(t.key)}` : ''}`
          : t?.swivel ? 'TESTING SWIVEL' : t?.sticks ? 'TESTING STICKS' : t?.stall ? 'TESTING STALL FINDER'
            : 'TEST: tap a motion, a link or a MATCH setting to feel it';
      $('setTestStop').disabled = !t;
    }

    // MOTORS A | B | BOTH for the lights
    const drives = ctl.drives, sig = JSON.stringify(drives.map((c) => [c.i, c.name]));
    if (sig !== useSig) { useSig = sig; useButtons($, 'motorUse', drives, (v) => ctl.set({ use: v })); }
    segShow('motorUse', 'use', ctl.useList(m.use) ? String(m.use) : 'all');
    $('motorUseHint').hidden = drives.length < 2;

    // MATCH
    const now = s.hacked ? 'hack' : modeOf(s).key;
    if (!matchPicked && MATCHES(now)) matchKey = now;
    $('matchKey').value = matchKey;
    const c = matchCfg(m, matchKey), d = matchDefault(matchKey);
    segShow('matchRight', 'right', c.right);
    showSlider($, 'matchLevel', c.level);
    showSlider($, 'matchSpeed', c.speed);
    showSlider($, 'matchShift', c.shift, signed(c.shift, ' ms'));
    const adjusted = JSON.stringify(c) !== JSON.stringify(d);
    $('matchReset').disabled = !adjusted;
    $('matchNote').textContent = `${adjusted ? 'Adjusted' : 'Default'}: right side ${c.right}${d.right === 'mirror' ? ' (the mask mirrors this one)' : ''}.`;

    // SOUND / SHAKE
    showSlider($, 'soundGain', m.sound.gain);
    showSlider($, 'soundSize', m.sound.size);
    segShow('soundRight', 'right', m.sound.right);
    segShow('motorShake', 'shake', m.shake);

    // MOTIONS
    for (const [key, b] of motionEls) {
      const on = !m.off[key], tuning = key === ui.tuning;
      b.classList.toggle('on', on);
      b.classList.toggle('tuning', tuning);
      b.setAttribute('aria-pressed', String(on));
      b.lastChild.textContent = tuning ? (on ? 'ON · TUNING' : 'OFF · TUNING') : on ? 'ON' : 'OFF';
    }
    $('motionCount').textContent = `${motionEls.filter(([k]) => !m.off[k]).length} / ${motionEls.length} ON`;
    const tune = tuneOf(m, ui.tuning);
    $('motionTuning').textContent = MOTION_LABEL[ui.tuning];
    showSlider($, 'motionSpeed', tune.speed);
    showSlider($, 'motionSize', tune.size);

    // links: only motions switched on (and MATCH LIGHTS only where there's something to follow)
    for (const [key, sel] of linkEls) {
      for (const o of sel.options) o.hidden = o.value !== 'none' && (!!m.off[o.value] || (o.value === 'lights' && !MATCHES(key)));
      if (document.activeElement !== sel) sel.value = motionOf(m, key);
    }
  });
}
