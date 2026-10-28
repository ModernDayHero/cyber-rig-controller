// BOLT drive panel: a touch stick, or phone tilt with the stick held as a dead-man
// switch (touching it also re-centres the tilt). Up on the stick = the way the BOLT
// was aimed; AIM turns it in place and SET makes that "forward". Let go = stop.

const DEAD = 0.12;        // stick / tilt dead zone, fraction of full throw
const TILT_FULL = 25;     // degrees of phone tilt for full speed
const MAX_KEY = 'rig-drive-max';

const clamp = (v) => Math.max(-1, Math.min(1, v));

export function setupDrive(rig, $) {
  const bolt = rig.bolt, stick = $('stick'), knob = $('knob');
  let on = false, tilt = false, held = false;
  let x = 0, y = 0, heading = 0, zero = null, orient = null;
  let max = 40;
  try { max = Number(localStorage.getItem(MAX_KEY)) || 40; } catch {}

  function update() {
    let m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    knob.style.left = `${50 + x * 36}%`;
    knob.style.top = `${50 - y * 36}%`;
    stick.classList.toggle('live', held);
    if (!on) return;
    if (!held || m < DEAD) {
      bolt.drive(0, heading);             // stop, still facing the same way
      return;
    }
    heading = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    bolt.drive(255 * max / 100 * (m - DEAD) / (1 - DEAD), heading);
  }

  function release() {
    held = false;
    x = y = 0;
    update();
  }

  function fromPointer(e) {
    const r = stick.getBoundingClientRect();
    x = clamp((e.clientX - r.left - r.width / 2) / (r.width * 0.36));
    y = clamp(-(e.clientY - r.top - r.height / 2) / (r.height * 0.36));
  }

  stick.addEventListener('pointerdown', (e) => {
    stick.setPointerCapture(e.pointerId);
    held = true;
    if (tilt) zero = orient;              // hold = calibrate: the phone as it is now is "stopped"
    else fromPointer(e);
    update();
  });
  stick.addEventListener('pointermove', (e) => {
    if (!held || tilt) return;
    fromPointer(e);
    update();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(ev, release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  window.addEventListener('deviceorientation', (e) => {
    if (e.beta === null) return;
    orient = { beta: e.beta, gamma: e.gamma };
    if (!tilt || !held || !zero) return;
    x = clamp((e.gamma - zero.gamma) / TILT_FULL);
    y = clamp(-(e.beta - zero.beta) / TILT_FULL);   // top of the phone away from you = forward
    update();
  });

  async function setTilt(v) {
    if (v && typeof DeviceOrientationEvent?.requestPermission === 'function') {
      try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') v = false; } catch { v = false; }
    }
    tilt = v;
    release();
    for (const b of $('driveTilt').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tilt === (v ? '1' : '0'));
    $('driveHint').textContent = v
      ? 'Hold the stick and tilt the phone. Touching it sets "level". Let go to stop.'
      : 'Drag the stick. Let go to stop.';
  }

  function setOn(v) {
    if (on && !v) bolt.drive(0, heading);
    on = v;
    rig.setDriving(v);
    release();
    $('driveBox').hidden = !v;
    for (const b of $('driveOn').querySelectorAll('button')) b.classList.toggle('on', b.dataset.on === (v ? '1' : '0'));
  }

  for (const b of $('driveOn').querySelectorAll('button')) b.addEventListener('click', () => setOn(b.dataset.on === '1'));
  for (const b of $('driveTilt').querySelectorAll('button')) b.addEventListener('click', () => setTilt(b.dataset.tilt === '1'));

  $('driveMax').value = max;
  $('driveMaxOut').textContent = `${max}%`;
  $('driveMax').addEventListener('input', () => {
    max = Number($('driveMax').value);
    $('driveMaxOut').textContent = `${max}%`;
    try { localStorage.setItem(MAX_KEY, String(max)); } catch {}
  });

  // AIM: turn in place 15 degrees at a time, then SET makes that direction forward.
  for (const b of $('driveAim').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      const d = Number(b.dataset.aim);
      if (d) {
        heading = (heading + d + 360) % 360;
        bolt.drive(0, heading);
      } else {
        bolt.resetAim();
        heading = 0;
      }
    });
  }

  setOn(false);
  setTilt(false);
}
