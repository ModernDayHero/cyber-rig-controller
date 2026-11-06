// MOTOR tab -> TEST (SET -> MOTORS -> TEST on): a bench for the motors, whatever the lights do.
//   RUMBLE      the motions (one-way levels), with SPEED and INTENSITY (= the motion's SIZE)
//   SWIVEL      the chosen motors at a steady speed + direction, and the two-way motions
//   PAD         a gamepad's sticks drive motors A / B (stops the moment it goes quiet)
//   CALIBRATE   each motor's stall minimum and start-up kick, live; the stall finder; SAVE
//   CONSOLE     what the plugin says, and any command (ours, or the standard Vibrate:10;)

import { MOTION_DEFS, tuneOf } from '../motions.js';
import { useButtons, motionTile, slider, showSlider } from './common.js';

export function setupBench(ui) {
  const { rig, ctl, $, segPick, segShow, showBanner } = ui;

  const BENCH = ['rumble', 'swivel', 'pad', 'cal', 'console'];
  let bench = 'rumble';
  try { if (BENCH.includes(localStorage.getItem('rig-motor-bench'))) bench = localStorage.getItem('rig-motor-bench'); } catch {}
  segPick('benchTabs', 'bench', (b) => {
    bench = b;
    try { localStorage.setItem('rig-motor-bench', b); } catch {}
    ui.render();
  });

  // ---- RUMBLE (one-way motions) and SWIVEL's timed motions (the two-way ones)
  const tile = (key) => [key, motionTile(MOTION_DEFS[key].label, () => {
    ui.tuning = key;                                  // the sliders (here and in SET) follow it
    ctl.testMotion(key);
    ui.render();
  })];
  const twoWay = (k) => !!MOTION_DEFS[k].signed;
  const testEls = [
    ...Object.keys(MOTION_DEFS).filter((k) => !twoWay(k)).map((k) => { const t = tile(k); $('testMotions').append(t[1]); return t; }),
    ...Object.keys(MOTION_DEFS).filter(twoWay).map((k) => { const t = tile(k); $('swivelMotions').append(t[1]); return t; }),
  ];
  for (const [id, prop] of [['testSpeed', 'speed'], ['testSize', 'size']]) {
    slider($, id, '%', 300, (v) => {
      const m = rig.state.motors;
      ctl.set({ tune: { ...m.tune, [ui.tuning]: { ...tuneOf(m, ui.tuning), [prop]: v } } });
    });
  }

  // ---- SWIVEL: steady speed
  let swSpeed = 70, swDir = 1;
  const swivel = () => ctl.testSwivel(swDir * swSpeed);
  for (const p of [50, 60, 70, 80, 90, 100]) {
    const b = document.createElement('button');
    b.textContent = `${p}%`;
    b.dataset.speed = p;
    b.addEventListener('click', () => { swSpeed = p; swivel(); });
    $('testSpeeds').append(b);
  }
  $('swivelDir').addEventListener('click', () => {
    swDir = -swDir;
    if (ctl.test?.swivel) swivel(); else ui.render();
  });

  // ---- PAD: the Gamepad API (pair it with the phone / PC, press a button)
  const DEADZONE = 0.15;
  let sticksOn = false, pad = null, padName = '', prevBtn = [], lastSent = 0, lastMsg = '';
  const axis = (v) => {
    const m = Math.abs(v || 0);
    if (m < DEADZONE) return 0;
    const p = Math.min(100, Math.round(((m - DEADZONE) / (1 - DEADZONE)) * 20) * 5);
    return v < 0 ? p : -p;                            // stick up = forward
  };
  function drawSticks(a, b) {
    for (const [v, id] of [[a, 'A'], [b, 'B']]) {
      const el = $('padBar' + id), h = Math.abs(v) / 2;
      el.style.height = `${h}%`;
      el.style.top = v >= 0 ? `${50 - h}%` : '50%';
      el.classList.toggle('rev', v < 0);
      $('padVal' + id).textContent = `${v}%`;
    }
  }
  const setSticks = (on) => {
    if (on && !pad) return showBanner('No controller: pair one, then press any button on it.');
    sticksOn = on;
    if (!on && ctl.test?.sticks) ctl.stopTest();
    drawSticks(0, 0);
    ui.render();
  };
  $('padSticks').addEventListener('click', () => setSticks(!sticksOn));
  const stepMotion = (dir) => {
    const keys = Object.keys(MOTION_DEFS), cur = keys.indexOf(ctl.test?.motion ?? ui.tuning);
    ui.tuning = keys[(cur + dir + keys.length) % keys.length];
    if (sticksOn) setSticks(false);
    ctl.testMotion(ui.tuning, { again: true });
  };
  const padButton = (i) => {
    if (!rig.state.motors.test) return;
    switch (i) {
      case 0: case 9: ctl.test?.motion ? ctl.stopTest() : ctl.testMotion(ui.tuning, { again: true }); break;  // A / Start
      case 1: case 8: setSticks(false); rig.motor.stop(); ctl.stopTest(); break;                            // B / Back: stop
      case 2: setSticks(!sticksOn); break;                                                                  // X
      case 4: case 14: stepMotion(-1); break;                                                               // LB / left
      case 5: case 15: stepMotion(1); break;                                                                // RB / right
      case 12: case 13: {                                                                                   // up / down: intensity
        const m = rig.state.motors, t = tuneOf(m, ui.tuning);
        const size = Math.max(10, Math.min(100, t.size + (i === 12 ? 10 : -10)));
        ctl.set({ tune: { ...m.tune, [ui.tuning]: { ...t, size } } });
        break;
      }
    }
  };
  function padLoop() {
    pad = [...(navigator.getGamepads?.() || [])].find((p) => p && p.connected) || null;
    const name = pad ? pad.id.replace(/\s*\(.*\)\s*/, '').trim() || 'Controller' : '';
    if (name !== padName) {
      padName = name;
      if (!pad && sticksOn) { setSticks(false); showBanner('Controller lost: motors stopped.'); }
      ui.render();
    }
    if (pad) {
      pad.buttons.forEach((b, i) => { if (b.pressed && !prevBtn[i]) padButton(i); prevBtn[i] = b.pressed; });
      if (sticksOn && rig.motor.connected) {
        const a = axis(pad.axes[1]), b = axis(pad.axes[3]), msg = `${a},${b}`, now = performance.now();
        if ((msg !== lastMsg && now - lastSent >= 50) || now - lastSent >= 250) {   // ≤ 20 / s, a beat every 250 ms
          ctl.testSticks(a, b);
          lastMsg = msg;
          lastSent = now;
        }
        drawSticks(a, b);
      }
    }
    requestAnimationFrame(padLoop);
  }
  if (navigator.getGamepads) requestAnimationFrame(padLoop);
  document.addEventListener('visibilitychange', () => { if (document.hidden && sticksOn) setSticks(false); });

  // ---- CALIBRATE
  let calSig = '';
  function buildCal(drives) {
    const cal = drives.filter((c) => c.floor >= 0), sig = JSON.stringify(cal.map((c) => [c.i, c.name]));
    if (sig === calSig) return;
    calSig = sig;
    $('calRows').replaceChildren(...cal.map((c) => {
      const box = document.createElement('div');
      box.className = 'calrow';
      box.innerHTML = '<span class="label"></span>';
      box.firstChild.textContent = c.name;
      for (const [prop, label, max, step, unit] of [['floor', 'MIN', 90, 1, '%'], ['kick', 'KICK', 500, 10, 'ms']]) {
        const row = document.createElement('div');
        row.className = 'row';
        const r = document.createElement('input');
        Object.assign(r, { type: 'range', min: 0, max, step });
        r.dataset.ch = c.i;
        r.dataset.prop = prop;
        const out = document.createElement('output');
        let t = null;
        r.addEventListener('input', () => {
          out.textContent = `${r.value}${unit}`;
          clearTimeout(t);
          t = setTimeout(() => ctl.setCalibration(c.i, { [prop]: Number(r.value) }), 90);
        });
        row.append(Object.assign(document.createElement('span'), { className: 'label', textContent: label }), r, out);
        box.append(row);
      }
      return box;
    }));
    $('calNone').hidden = cal.length > 0;
  }
  $('calStall').addEventListener('click', () => (ctl.test?.stall ? ctl.stopTest() : ctl.testStall()));
  $('calSave').addEventListener('click', () => rig.motor.saveCalibration());
  setInterval(() => {                                 // the stall finder's step, read off the clock
    const st = ctl.test?.stall;
    if (!st) return;
    const step = Math.floor(((Date.now() - st.at) % st.len) / 1500);
    $('calStatus').textContent = step < 20 ? `STALL FINDER: raw ${(step + 1) * 5}%  (watch which % each motor starts at)` : 'STALL FINDER: resting, then again';
  }, 250);

  // ---- CONSOLE
  const log = (line) => {
    const el = $('motorLog'), atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    el.textContent += line + '\n';
    if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
    if (atEnd) el.scrollTop = el.scrollHeight;
  };
  rig.motor.addEventListener('line', (e) => { if (rig.state.motors.test) log('< ' + e.detail); });
  $('motorCmd').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('motorCmdIn').value.trim();
    if (!v || !rig.motor.connected) return;
    log('> ' + v);
    rig.motor.send(v);
    $('motorCmdIn').value = '';
  });
  $('motorLogClear').addEventListener('click', () => { $('motorLog').textContent = ''; });

  $('testEnd').addEventListener('click', () => { if (sticksOn) setSticks(false); ctl.stopTest(); });

  // ---- render
  let useSig = '';
  ui.renders.push((s) => {
    const m = s.motors, test = ctl.test, drives = ctl.drives;
    $('motorTestPanel').hidden = !m.test;
    if (!m.test) return;
    segShow('benchTabs', 'bench', bench);
    for (const k of BENCH) $(`bench-${k}`).hidden = k !== bench;

    const sig = JSON.stringify(drives.map((c) => [c.i, c.name]));
    if (sig !== useSig) {                             // MOTORS: one button per motor, + BOTH / ALL
      useSig = sig;
      useButtons($, 'benchUse', drives, (v) => ctl.set({ testUse: v }));
      $('padNameA').textContent = `${drives[0]?.name || 'MOTOR A'} · L`;
      $('padNameB').textContent = drives[1] ? `${drives[1].name} · R` : '—';
    }
    segShow('benchUse', 'use', drives.length > 1 && ctl.useList(m.testUse) ? String(m.testUse) : 'all');
    segShow('testSpeeds', 'speed', test?.swivel ? Math.abs(test.swivel.pct) : -1);
    $('swivelDir').textContent = swDir > 0 ? 'DIRECTION: FWD ▶' : 'DIRECTION: ◀ REV';
    for (const [key, b] of testEls) {
      const on = test?.motion === key;
      b.classList.toggle('on', on);
      b.classList.toggle('tuning', key === ui.tuning);
      b.lastChild.textContent = on ? '▶ PLAYING' : key === ui.tuning ? 'SELECTED' : '';
    }
    const t = tuneOf(m, ui.tuning);
    showSlider($, 'testSpeed', t.speed);
    showSlider($, 'testSize', t.size);
    $('padName').textContent = padName || 'No controller found';
    $('padSticks').textContent = sticksOn ? 'STICKS: ON' : 'STICKS: OFF';
    $('padSticks').classList.toggle('on', sticksOn);
    buildCal(drives);
    for (const r of $('calRows').querySelectorAll('input')) {
      const c = drives.find((x) => x.i === Number(r.dataset.ch));
      if (!c || document.activeElement === r) continue;
      r.value = c[r.dataset.prop];
      r.nextSibling.textContent = `${c[r.dataset.prop]}${r.dataset.prop === 'kick' ? 'ms' : '%'}`;
    }
    $('calStall').textContent = test?.stall ? 'STOP STALL FINDER' : 'RUN STALL FINDER';
    $('calStall').classList.toggle('on', !!test?.stall);
    if (!test?.stall) $('calStatus').textContent = '';
    $('testEnd').disabled = !test;
  });
}
