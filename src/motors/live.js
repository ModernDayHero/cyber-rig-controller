// Live motor drives, for what the motor board can't play by itself from a stored pattern:
//   SOUND  the phone's microphone level drives the motors (VU, or anything linked to SOUND)
//   SHAKE  a shake of the CLUE (its "S <strength>" report) gives the motors a short burst
// Both use the plugin's hand control (V), which stops by itself if the deck goes quiet.

/** Sound -> motors, about 12 times a second. Auto-levelling: it follows the room's quiet and
 *  loud, so it reacts to the music rather than to how loud the party is. */
export class SoundDrive extends EventTarget {
  constructor(ctl) {
    super();
    this.ctl = ctl;            // the MotorController: its rig, motors and settings
    this.on = false;
    this.level = 0;          // 0..1, after levelling and smoothing (for the meter)
  }

  /** owner: who wants the level ('motors' drives the motor board; others just read .level).
   *  The mic stays on while anyone still wants it. */
  async start(owner = 'motors') {
    (this.users ??= new Set()).add(owner);
    if (this.on) return;
    this.on = true;
    try {
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        this.ctx = new AudioContext();
        this.an = this.ctx.createAnalyser();
        this.an.fftSize = 1024;
        this.ctx.createMediaStreamSource(this.stream).connect(this.an);
        this.buf = new Float32Array(this.an.fftSize);
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
        // Some browsers only start audio from a tap: the next one starts it.
        if (this.ctx.state === 'suspended') document.addEventListener('pointerdown', () => this.ctx?.resume(), { once: true });
      }
    } catch (e) {
      this.on = false;
      this.ctl.note(`SOUND needs the microphone: ${e.name === 'NotAllowedError' ? 'allow it for this page (the lock / site settings by the address)' : e.message}`);
      return;
    }
    if (!this.on) return this._release();     // stopped while the permission prompt was up
    this.floor = -60;
    this.peak = -25;
    this.env = 0;
    this.sent = {};
    this.timer = setInterval(() => this._tick(), 80);
  }

  stop(owner = 'motors') {
    this.users?.delete(owner);
    if (owner === 'motors') this._quiet();          // the motor board stops either way
    if (!this.on || this.users?.size) return;
    this.on = false;
    clearInterval(this.timer);
    this.level = 0;
    this.dispatchEvent(new Event('level'));
    this._release();
  }

  _quiet() {
    const m = this.ctl.motor;
    if (m.connected) for (const i of Object.keys(this.sent ?? {})) m.set(+i, 0);
    this.sent = {};
  }

  _release() {                               // the mic off (and its indicator) when not in use
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.stream = this.ctx = this.an = null;
  }

  _tick() {
    if (!this.an) return;
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / this.buf.length) + 1e-9);
    // The quiet floor drops at once and creeps back up; the loud peak jumps up and sinks slowly.
    this.floor = db < this.floor ? db : this.floor + 0.03;
    this.peak = db > this.peak ? db : this.peak - 0.06;
    if (this.peak < this.floor + 18) this.peak = this.floor + 18;     // silence isn't "loud"
    const m = this.ctl.state, gain = (m.sound?.gain ?? 100) / 100;
    const lvl = Math.max(0, Math.min(1, ((db - this.floor) / (this.peak - this.floor)) * gain));
    this.env = lvl > this.env ? lvl : this.env * 0.82;                // quick attack, soft release
    this.level = this.env;
    this.dispatchEvent(new Event('level'));

    const motor = this.ctl.motor;
    if (!motor.connected || !this.users?.has('motors')) return;   // the level only, for others
    // Below the gate is room hiss: still. Above it, the rest of the range is the motors' 0-100 %.
    const GATE = 0.15, size = (m.sound?.size ?? 100) / 100;
    const pct = this.env < GATE ? 0 : Math.round(((this.env - GATE) / (1 - GATE)) * 100 * size);
    const now = Date.now(), use = this.ctl.useList(this.ctl.test ? m.testUse : m.use);
    this.ctl.drives.forEach((c, k) => {
      if (use && !use.includes(c.i)) return;
      const v = k % 2 && m.sound?.right === 'mirror' ? -pct : pct;
      const was = this.sent[c.i];
      // Only real changes, plus one every 0.4 s so the plugin's dead-man stays happy.
      if (!was || Math.abs(was.v - v) >= 3 || now - was.at > 400) {
        motor.set(c.i, v);
        this.sent[c.i] = { v, at: now };
      }
    });
  }
}

/** SHAKE bursts: a short stored pattern ('~shake', memory only on the plugin). */
export const SHAKES = {
  buzz: (k) => ({ len: 640, pts: [[0, k], [90, k], [100, 0], [200, 0], [210, k], [300, k], [310, 0], [410, 0], [420, k], [540, k], [550, 0], [640, 0]] }),
  spin: (k) => ({ len: 900, pts: [[0, k], [700, k], [900, 0]] }),
};
