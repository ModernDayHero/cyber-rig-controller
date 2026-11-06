// The MOTOR tab: STOP / RESUME, the CONNECTION TEST, what the motors are doing now, and
// one hand control per channel (servo slider; hold-to-run for DC motors and steppers).

import { MOTION_LABEL, LINKABLE, motorKey, motionOf, tuneOf } from '../motions.js';

export function setupTab(ui) {
  const { rig, ctl, $, showBanner } = ui;

  $('motorStop').addEventListener('click', () => {
    if (ctl.test) { ctl.endTest(); ctl.emit(); }
    rig.motor.stop();
    rig.dispatchEvent(new Event('stopall'));          // plugins' outputs stop too
    showBanner('Motors stopped. RESUME puts the pattern back.');
  });
  $('motorResume').addEventListener('click', () => {
    ctl.follow(true);
    rig.dispatchEvent(new Event('resumeall'));
  });

  // ---- CONNECTION TEST: phone -> Bluetooth -> board -> driver -> each motor, with what to
  // check where it breaks. The board answers T lines (firmware/MOTOR/main.py selftest()).
  let checkT = null, runRow = {};
  const checks = [];
  const check = (state, text, why = '') => {
    checks.push({ state, text, why });
    drawChecks();
    return checks.length - 1;
  };
  const setCheck = (i, state, text, why) => {
    Object.assign(checks[i], { state }, text ? { text } : {}, why !== undefined ? { why } : {});
    drawChecks();
  };
  function drawChecks() {
    const ul = $('motorChecks');
    ul.hidden = !checks.length;
    ul.replaceChildren(...checks.map(({ state, text, why }) => {
      const li = document.createElement('li');
      li.className = state;
      li.append(Object.assign(document.createElement('span'), { textContent: text }));
      if (why) li.append(Object.assign(document.createElement('span'), { className: 'why', textContent: why }));
      return li;
    }));
  }
  const nameOf = (i) => rig.motor.channels.find((c) => c.i === Number(i))?.name || `motor ${i}`;
  $('motorSelfTest').addEventListener('click', () => {
    checks.length = 0;
    runRow = {};
    clearTimeout(checkT);
    if (!navigator.bluetooth) return check('bad', 'Web Bluetooth not available', 'Use Chrome on Android or a PC, over https:// or localhost.');
    if (!rig.motor.connected) {
      return check('bad', 'Bluetooth: not connected to the motor board',
        rig.motor.status === 'lost' || rig.motor.status === 'connecting'
          ? 'Reconnecting… check the Pico has power and is near; if it keeps failing, tap the Motor chip.'
          : "Tap the Motor chip at the top and pick RIG-MOTOR. Not in the list? The Pico has no power or isn't running the plugin.");
    }
    check('ok', 'Bluetooth: connected to RIG-MOTOR');
    const n = rig.motor.channels.length;
    if (!n) check('bad', 'The board reports no motors', 'Its channels.json is missing or every motor failed to start: see below.');
    else check('ok', `The board reports ${n} motor${n > 1 ? 's' : ''}: ${rig.motor.channels.map((c) => c.name).join(', ')}`);
    if (ctl.test) ctl.stopTest();
    runRow.wait = check('run', 'Asking the board to test its driver and motors…');
    rig.motor.send('T');
    checkT = setTimeout(() => setCheck(runRow.wait, 'bad', "The board didn't answer the test",
      'Its firmware is older than this deck: copy the new firmware/MOTOR/main.py to the Pico.'), 4000);
  });
  rig.motor.addEventListener('selftest', (e) => {
    const [k, ...w] = e.detail;
    clearTimeout(checkT);
    if (runRow.wait !== undefined) { checks.splice(runRow.wait, 1); runRow.wait = undefined; }
    switch (k) {
      case 'cfg':
        if (+w[1] < +w[0]) check('bad', `${+w[0] - +w[1]} of ${w[0]} motors in channels.json didn't start`);
        break;
      case 'skip':
        check('bad', `${w[0].replace(/_/g, ' ')} didn't start`, /not found/i.test(w.slice(1).join(' '))
          ? "The Qwiic Motor Driver isn't answering: check the Qwiic cable to the Pico's Qw/ST port, and that the driver has power (its LED)."
          : w.slice(1).join(' '));
        break;
      case 'i2c':
        if (w[0] === 'error') check('bad', 'Qwiic port error', w.slice(1).join(' '));
        else if (!w[0].includes('0x5D')) check('bad', `Qwiic Motor Driver not found (seen on the port: ${w[0] === '-' ? 'nothing' : w[0]})`,
          'Check the Qwiic cable, and the address jumpers on the driver (default 0x5D).');
        else check('ok', 'Qwiic Motor Driver found on the Qw/ST port (0x5D)');
        break;
      case 'driver':
        if (w[1] === 'notready') check('bad', `The driver at ${w[0]} won't start`, "It's on the cable but not answering properly: check its power (the LED), then the Qwiic cable. The board keeps trying every 2 s.");
        else if (w[1] === 'error') check('bad', `Driver ${w[0]} stopped answering`, w.slice(2).join(' '));
        else if (w[1] !== 'A9') check('bad', `Something at ${w[0]} isn't a Qwiic Motor Driver (ID ${w[1]})`);
        else if (w[2] !== '1') check('bad', "The driver's outputs are disabled", 'It reset (power dip?): the board re-enables it within 2 s. Run the test again.');
        else check('ok', 'Driver outputs enabled');
        break;
      case 'run':
        if (runRow[w[0]] === undefined) runRow[w[0]] = check('run', `${nameOf(w[0])}: forward…`);
        else setCheck(runRow[w[0]], 'run', `${nameOf(w[0])}: reverse…`);
        break;
      case 'ok':
        setCheck(runRow[w[0]], 'ok', `${nameOf(w[0])}: ran forward and reverse`,
          "No movement? The driver took the command, so check the motor supply on the driver's VIN (3–11 V) and the motor wires on its A1/A2 (B1/B2).");
        break;
      case 'fail':
        if (runRow[w[0]] === undefined) runRow[w[0]] = check('bad', '');
        setCheck(runRow[w[0]], 'bad', `${nameOf(w[0])}: the driver refused the command`, w.slice(1).join(' '));
        break;
      case 'both':
        runRow.both = check('run', 'All motors together (started one after another)…');
        break;
      case 'bothok':
        setCheck(runRow.both, 'ok', 'All motors together: ran',
          "One stops or the Pico restarts here? The supply can't feed them all: a stronger battery / supply, or lower the speeds.");
        break;
      case 'done':
        check('info', "Test finished. Motors that didn't move but show ✓: power or motor wiring (see under each).");
        break;
    }
  });

  // ---- hand controls, one per channel
  let built = '';
  function buildControls(chs) {
    const sig = JSON.stringify(chs);
    if (sig === built) return;
    built = sig;
    $('motorChannels').replaceChildren(...chs.map(control));
    $('motorNone').hidden = chs.length > 0;
  }
  function control(ch) {
    const box = document.createElement('section');
    box.className = 'panel mchan';
    const head = document.createElement('div');
    head.className = 'row';
    head.innerHTML = '<span class="label"></span><span class="hint mtype"></span>';
    head.firstChild.textContent = ch.name;
    head.lastChild.textContent = ch.type === 'servo' ? `SERVO ${ch.min}–${ch.max}°` : ch.type === 'dc' ? `DC ≤${ch.max}%` : `STEPPER ≤${ch.max}%`;
    box.append(head);
    if (ch.type === 'servo') {
      const row = document.createElement('div');
      row.className = 'row';
      const r = document.createElement('input');
      Object.assign(r, { type: 'range', min: ch.min, max: ch.max, step: 1, value: ch.home });
      const out = document.createElement('output');
      out.textContent = `${ch.home}°`;
      let t = null;
      r.addEventListener('input', () => {
        out.textContent = `${r.value}°`;
        clearTimeout(t);
        t = setTimeout(() => rig.motor.set(ch.i, Number(r.value), 150), 60);
      });
      const home = document.createElement('button');
      home.className = 'ghost';
      home.textContent = 'HOME';
      home.addEventListener('click', () => { r.value = ch.home; out.textContent = `${ch.home}°`; rig.motor.set(ch.i, ch.home, 400); });
      row.append(r, out, home);
      box.append(row);
      return box;
    }
    // DC / stepper: hold to run at SPEED (the plugin stops it 1.5 s after we stop saying so).
    const row = document.createElement('div');
    row.className = 'row';
    const speed = document.createElement('input');
    Object.assign(speed, { type: 'range', min: 5, max: ch.max, step: 5, value: Math.min(50, ch.max) });
    const out = document.createElement('output');
    out.textContent = `${speed.value}%`;
    speed.addEventListener('input', () => { out.textContent = `${speed.value}%`; });
    row.append(Object.assign(document.createElement('span'), { className: 'label', textContent: 'SPEED' }), speed, out);
    const hold = document.createElement('div');
    hold.className = 'seg mhold';
    for (const [dir, txt] of [[-1, '◀ REV'], [1, 'FWD ▶']]) {
      const b = document.createElement('button');
      b.textContent = txt;
      let beat = null;
      const go = (e) => {
        b.setPointerCapture?.(e.pointerId);
        b.classList.add('on');
        const send = () => rig.motor.set(ch.i, dir * Number(speed.value));
        send();
        clearInterval(beat);
        beat = setInterval(send, 500);
      };
      const letGo = () => {
        if (!beat) return;
        clearInterval(beat);
        beat = null;
        b.classList.remove('on');
        rig.motor.set(ch.i, 0);
      };
      b.addEventListener('pointerdown', go);
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, letGo);
      document.addEventListener('visibilitychange', () => { if (document.hidden) letGo(); });
      hold.append(b);
    }
    box.append(row, hold);
    return box;
  }

  // ---- render: NOW (what the motors are doing) and the hand controls
  ui.renders.push((s) => {
    const m = s.motors, test = ctl.test, drives = ctl.drives, sw = test?.swivel;
    const t = tuneOf(m, ui.tuning);
    const chName = (i) => drives.find((c) => c.i === i)?.name || `#${i}`;
    const key = motorKey(s), lk = LINKABLE.find(([k]) => k === key);
    const [label, name, sub] = !rig.motor.connected ? ['MOTORS', 'NOT CONNECTED', 'Tap the Motor chip']
      : test?.motion ? ['TEST', MOTION_LABEL[test.motion], `speed ${t.speed}% · intensity ${t.size}%`]
        : sw ? ['TEST · SWIVEL', `${Math.abs(sw.pct)}% ${sw.pct < 0 ? 'REV' : 'FWD'}`, sw.chs.map(chName).join(' + ') || "the board hasn't listed its motors: run CONNECTION TEST"]
          : test?.sticks ? ['TEST · CONTROLLER', 'STICK CONTROL', 'left stick = A, right stick = B']
            : test?.stall ? ['TEST · CALIBRATE', 'STALL FINDER', 'raw drive, 5 % a step']
              : ['FOLLOWING THE LIGHTS', key === '-' || !lk ? 'STILL' : MOTION_LABEL[motionOf(m, key)],
                key === '-' || !lk ? 'no motion linked to this pattern' : lk[1]];
    $('nowLabel').textContent = label;
    $('nowName').textContent = name;
    $('nowSub').textContent = sub;
    buildControls(rig.motor.connected ? rig.motor.channels : []);
  });
}
