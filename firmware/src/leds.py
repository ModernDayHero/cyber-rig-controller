# Shared intake animations for both Circuit Playgrounds (ported from the
# Cyber headgear configurator). 10 NeoPixels per intake.
#
# Built-in mode bytes (sent by the CLUE): the rig's own states
#   D dark     dark purple, a brighter arc slowly circling   I = alias for D (idle)
#   R rainbow  slow color wave
#   P peace    white fade up, hold, fade to off
#   H hunt     red scanner sweep
#   F/V virus  takeover: red sweep with glitch stabs (CLUE virus mode)
#   W standby  blinks white (CLUE sends O after ~2 min)
#   O off      all pixels off
#   A audio    mic VU meter: both sides fill from the bottom,
#              green -> yellow -> red at the top, with a falling peak dot
# Every other letter is a pushed animation (a recipe, below): Glitch, Rainfall, Matrix,
# Heartbeat, Netrun, Scanner, Neon, Overclock and the /command looks. A letter with no
# recipe yet shows Dark.
#
# Packets:
#   C r g b    scanned color (4 bytes): breathes in that color
#   B r g b r g b  rebreather (7 bytes): breathes between two colors
#   Z k b rgb rgb  tuning (10 bytes): mode k's brightness % + main / accent colour
#   S sp w dir   rainbow settings (4 bytes): speed sp/50 x, width w/100 of the
#                hue wheel, dir 1 forward / 0 reverse
#   Q m        mute (2 bytes): m = 1 silences every sound, 0 lets them play
#   N k s      alert (3 bytes) over whatever mode is running: k = c call (holo-call
#              ring spinning round) / m message (three cyan flashes); s = 1 also beeps
#   L n k layers   recipe for mode k (n = bytes after n): up to 4 layers of 14 bytes,
#              kept in NVM so it survives a restart. Each layer:
#     shape flags speed p1 p2 lo hi gamma  r g b (A)  r g b (B)
#     speed is signed; lo / hi are 0-255 brightness; gamma / 10 shapes the curve
#     (0 = 1.0). Layers mix brightest-channel-wins; an OVER layer replaces what's
#     under it wherever it's lit.
#     0 FILL    the whole ring at hi (lo while CUT)
#     1 CHASE   p1 heads round the ring, speed/20 turns a second, tail p2/10 pixels;
#               USE_B paints each head in B
#     2 WAVE    sine round the ring: speed/10 rad/s, p1/10 rad per pixel, p2/10 rad
#               between the sides; USE_B blends A -> B with the wave; MOTION drives
#               it from the accelerometer and heats it toward white
#     3 DRIP    p1 drops running down each side, speed/10 pixels a second, one every
#               p2/10 pixels; USE_B colours them A, B, A+B
#     4 PULSE   the whole ring: p1 0 heartbeat, 1 breath, 2 strobe (speed/10 Hz, p2 %
#               on; USE_B alternates A / B), 3 candle flicker (USE_B burns B when hot),
#               4 a beat every p2/10 s lasting speed/100 s
#     5 SPARKLE each pixel lights with chance p1/255 a frame; USE_B picks A or B
#     6 HALF    one half of the intake (p1 0 / 1, mirrored across the mask)
#     7 SWEEP   like CHASE, the tail on both sides of the head
#   flags: 1 MIRROR the right side turns the other way, 2 BURST only during glitch
#   bursts, 4 CUT drops to lo during glitch cuts, 8 BUZZ neon hum, 16 MOTION (see
#   WAVE; a SPARKLE only fires when the board is moving hard), 32 FLASH only in
#   random flashes (lightning, boo), 64 OVER, 128 USE_B

import math
import random
import time

N = 10
PURPLE = (160, 60, 255)
MAG = (255, 43, 214)
CYAN = (0, 229, 255)
RED = (255, 30, 30)
WHITE = (255, 255, 255)
OFF = (0, 0, 0)

def scale(c, k):
    k = max(0.0, min(1.0, k))
    return (int(c[0] * k), int(c[1] * k), int(c[2] * k))

def mix(a, b, w):
    return (a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w)

def breath(t):
    return 0.1 + 0.9 * (0.5 - 0.5 * math.cos(t * 2 * math.pi / 5.5)) ** 1.6

def heart(t):
    p = t % 1.05
    return math.exp(-(p / 0.055) ** 2) + 0.7 * math.exp(-((p - 0.24) / 0.06) ** 2)

def wheel(h):
    h = h % 1.0
    i = int(h * 6)
    f = h * 6 - i
    q, u = int(255 * (1 - f)), int(255 * f)
    return [(255, u, 0), (q, 255, 0), (0, 255, u), (0, q, 255), (u, 0, 255), (255, 0, q)][i % 6]

NATIVE = "DIRPHFVWOACB"     # built in; every other letter runs a recipe
PACKETS = {"C": 3, "B": 6, "S": 3, "Z": 8, "N": 2, "Q": 1, "L": 0}   # data bytes that follow; 0 = a length byte first

# recipe shapes + flags (see the top)
FILL, CHASE, WAVE, DRIP, PULSE, SPARKLE, HALF, SWEEP = range(8)
MIRROR, BURST, CUT, BUZZ, MOTION, FLASH, OVER, USE_B = 1, 2, 4, 8, 16, 32, 64, 128
LAYER = 14

def load_recipes():
    """Recipes kept in NVM: b"RX", then (key, length, layers) records, length 0 ends."""
    try:
        import microcontroller
        m = microcontroller.nvm
        if m[0:2] != b"RX":
            return {}
        out, p = {}, 2
        while p + 2 <= len(m) and m[p + 1]:
            n = m[p + 1]
            out[chr(m[p])] = bytes(m[p + 2:p + 2 + n])
            p += 2 + n
        return out
    except Exception:
        return {}

def save_recipes(rc):
    try:
        import microcontroller
        b = b"RX" + b"".join(bytes((ord(k), len(v))) + v for k, v in rc.items()) + b"\x00\x00"
        if len(b) <= len(microcontroller.nvm):
            microcontroller.nvm[0:len(b)] = b
    except Exception as e:
        print("nvm:", e)

# Sounds. Segments: (start s, step s, notes Hz, side); the notes play one after
# another, step each, 0 = rest. side 0 = left, 1 = right, 2 = both.
#   m  message: harmonic chirps, quick arpeggios up the harmonic series of C5
#      (523 Hz x 2, 3, 4 ...), pinging left -> right -> both
#   c  call: a dark synth ringtone in A (phrygian: the B-flat is the menace), twice
#   a  alarm, when the virus takes over: siren whoop, hi-lo "danger danger", whoop
H3, H4, H5, H6, H8 = 1569, 2093, 2616, 3139, 4186
A4, BB4, A5, BB5, C6, D6, E6, A6 = 440, 466, 880, 932, 1047, 1175, 1319, 1760
D5, E5, F5 = 587, 659, 698
RINGTONE = (A5, A4, A5, C6, BB5, A5, E5, 0, A5, A4, A5, C6, E6, D6, C6, BB5,
            A5, A4, A5, C6, BB5, A5, E5, 0, F5, E5, D5, E5, A5, 0, A6, 0)
WHOOP = tuple(400 + 80 * i for i in range(16))       # 400 -> 1600 Hz, stepped
SOUNDS = {
    "m": ((0.00, 0.025, (H3, H4, H5, H6), 0),       # left: up the series
          (0.14, 0.025, (H4, H5, H6, H8), 1),       # right answers, a step higher
          (0.28, 0.04, (H6, H8, H6, H8), 2)),       # both: sparkle
    "c": ((0.0, 0.07, RINGTONE, 2), (2.8, 0.07, RINGTONE, 2)),
    "a": ((0.0, 0.03, WHOOP, 2), (0.55, 0.15, (1568, 1046) * 4, 2), (1.85, 0.03, WHOOP, 2)),
}
ALERT_TIME = {"m": 1.0, "c": 5.2}   # seconds the lights show the alert
RING = 2.8                          # call: one ringtone (2.24 s) plus a breath

class Parser:
    """Turns a byte stream into commands. Handles packets split across reads."""
    def __init__(self):
        self.cmd = None
        self.need = 0
        self.pending = []
    def feed(self, data):
        out = []
        for byte in data:
            if self.cmd:
                if self.need < 0:                 # L: this byte is the length
                    self.need = byte
                else:
                    self.pending.append(byte)
                if len(self.pending) == self.need:
                    out.append((self.cmd, tuple(self.pending)))
                    self.cmd = None
            elif chr(byte) in PACKETS:
                self.cmd, self.pending = chr(byte), []
                self.need = PACKETS[self.cmd] or -1
            elif 65 <= byte <= 90 or 97 <= byte <= 122:   # any other letter is a mode
                out.append((chr(byte), None))
        return out

def encode(mode, data):
    """data = (r, g, b) for C, (r, g, b, r, g, b) for B, else ignored."""
    return mode.encode() + bytes(data) if mode in PACKETS else mode.encode()

class Mic:
    """Onboard PDM mic -> 0..1 loudness with auto-gain, so it works at any party volume."""
    def __init__(self):
        import array
        import board
        import audiobusio
        self.mic = audiobusio.PDMIn(board.MICROPHONE_CLOCK, board.MICROPHONE_DATA,
                                    sample_rate=16000, bit_depth=16)
        self.buf = array.array("H", [0] * 160)
        self.floor = 10.0   # quietest recent level
        self.top = 300.0    # loudest recent level

    def level(self):
        self.mic.record(self.buf, len(self.buf))
        n = len(self.buf)
        mean = sum(self.buf) / n
        rms = math.sqrt(sum((x - mean) * (x - mean) for x in self.buf) / n) + 1
        # floor creeps up slowly, drops instantly; top jumps up, decays slowly
        self.floor = min(self.floor * 1.002 + 0.02, rms)
        self.top = max(self.top * 0.995, rms, self.floor * 4)
        lo, hi = math.log(self.floor), math.log(self.top)
        return max(0.0, min(1.0, (math.log(rms) - lo) / (hi - lo)))

class Buzzer:
    """Onboard speaker as a PWM tone, stepped from Lens.update() so the LEDs never stall."""
    def __init__(self, side):
        import board
        import digitalio
        import pwmio
        self.side = side          # 0 left, 1 right: which SOUNDS segments are ours
        self.pwm = pwmio.PWMOut(board.SPEAKER, frequency=2000, duty_cycle=0,
                                variable_frequency=True)
        self.en = None
        if hasattr(board, "SPEAKER_ENABLE"):   # the Bluefruit's amp has an enable pin
            self.en = digitalio.DigitalInOut(board.SPEAKER_ENABLE)
            self.en.switch_to_output(False)
        self.segs = None
        self.t0 = 0.0
        self.hz = 0
        self.muted = False

    def play(self, kind):
        if self.muted:
            return
        self.segs = SOUNDS.get(kind)
        self.t0 = time.monotonic()

    def _tone(self, hz):
        if hz == self.hz:
            return
        self.hz = hz
        if hz:
            self.pwm.frequency = hz
        self.pwm.duty_cycle = 0x8000 if hz else 0
        if self.en:
            self.en.value = bool(hz)

    def update(self, now):
        if not self.segs:
            return
        f = now - self.t0
        hz = 0
        for s0, step, notes, side in self.segs:
            i = int((f - s0) / step)
            if 0 <= f - s0 and i < len(notes) and side in (2, self.side):
                hz = notes[i]
                break
        s0, step, notes, _ = self.segs[-1]
        if f > s0 + step * len(notes):
            self.segs = None
        self._tone(hz)

# VU layout: on a Circuit Playground, pixels 0-4 run down one side and 5-9 up the other.
# Index lists go bottom -> top. Swap them if an intake board is mounted upside down.
VU_LEFT = (4, 3, 2, 1, 0)
VU_RIGHT = (5, 6, 7, 8, 9)
VU_COLORS = ((0, 255, 40), (90, 255, 0), (255, 200, 0), (255, 110, 0), (255, 0, 0))

class Lens:
    def __init__(self, pixels, key, mic=None, buzz=None, accel=None):
        self.mic = mic            # Mic() enables mode A
        self.accel = accel        # LIS3DH: MOTION recipes follow it (else they idle)
        self.energy = 0.0         # MOTION: 0 still .. 1 going hard
        self.oc_phase = 0.0
        self.buzz = buzz          # Buzzer() lets alerts beep
        self.alert_k = None       # N alert showing over the mode: "c" / "m"
        self.alert_t = 0.0
        self.vu = 0.0
        self.peak = 0.0
        self.peak_t = 0.0
        self.px = pixels          # neopixel.NeoPixel, auto_write=False
        self.key = key            # 0 = left intake, 1 = right intake
        self.mode = "D"
        self.custom = (0, 230, 255)
        self.pair = PURPLE + CYAN  # B mode: two colors, r g b r g b
        self.t0 = time.monotonic()
        self.burst = 0.0
        self.cut = 0.0
        self.last = time.monotonic()
        self.rb = (50, 30, 1)     # rainbow speed / width / direction bytes
        self.tune = {}            # mode -> (brightness 0-1, main rgb, accent rgb), from Z
        self.rb_phase = 0.0
        self.recipes = load_recipes()   # mode -> layer bytes, pushed from the phone
        self.save_at = 0.0        # NVM write pending (batched: the phone sends them all at once)
        self.layers = []          # the running recipe, decoded
        self.fx = []              # per layer: FLASH until, and its colour
        self.fxc = []
        self.motion = False
        print("recipes:", "".join(sorted(self.recipes)) or "none")

    def set_color(self, rgb):
        self.custom = rgb
        self.mode = "C"
        self.t0 = time.monotonic()
        self._load()

    def set_breathe(self, pair):
        if self.mode != "B":
            self.t0 = time.monotonic()
        self.pair = pair
        self.mode = "B"
        self._load()

    def apply(self, m, data=None):
        """Run one parsed command (mode byte or packet)."""
        if m == "C":
            if data != self.custom or self.mode != "C":
                self.set_color(data)
        elif m == "B":
            self.set_breathe(data)
        elif m == "S":
            self.rb = data                    # settings only, mode unchanged
        elif m == "Z":
            k = chr(data[0])
            self.tune[k] = (data[1] / 100, tuple(data[2:5]), tuple(data[5:8]))
        elif m == "N":
            self.alert(chr(data[0]), data[1])
        elif m == "Q":
            if self.buzz:
                self.buzz.muted = bool(data[0])
                if self.buzz.muted:              # cut anything already playing
                    self.buzz.segs = None
                    self.buzz._tone(0)
        elif m == "L":
            if data:
                k, layers = chr(data[0]), bytes(data[1:])
                if self.recipes.get(k) != layers:
                    self.recipes[k] = layers
                    self.save_at = time.monotonic() + 2
                    if k == self.mode:
                        self._load()
        else:
            self.set_mode(m)

    def packet(self):
        """Bytes that recreate the current state on another board."""
        if self.mode == "C":
            return encode("C", self.custom)
        if self.mode == "B":
            return encode("B", self.pair)
        return encode(self.mode, None)

    def alert(self, k, sound):
        """Call / message over the current mode; the mode carries on underneath."""
        if k not in ALERT_TIME:
            return
        self.alert_k, self.alert_t = k, time.monotonic()
        if sound and self.buzz:
            self.buzz.play(k)

    def alerting(self):
        return self.alert_k is not None or bool(self.buzz and self.buzz.segs)

    def _alert_pixel(self, i, f):
        if self.alert_k == "c":
            # holo-call: a cyan arc with a white head spins round the ring (the two
            # sides spin opposite ways), bright while it rings, dim between rings
            idx = N - 1 - i if self.key % 2 else i
            d = ((f * N * 1.6) - idx) % N             # 0 = head, rising = trail
            if d < 1:
                return WHITE
            k = max(0.0, 1 - d / 5) ** 1.5
            ring = 1.0 if f % RING < 2.24 else 0.3
            return scale(CYAN, 0.05 + 0.95 * k * ring)
        # message: three cyan flashes on the chirps, then the glow fades out
        if f < 0.56:
            return CYAN if f % 0.14 < 0.07 else scale(CYAN, 0.1)
        return scale(CYAN, (1 - (f - 0.56) / (ALERT_TIME["m"] - 0.56)) * 0.6)

    def set_mode(self, m):
        if m == "I":
            m = "D"
        if m != self.mode:
            self.t0 = time.monotonic()
            if m == "F" and self.buzz:
                self.buzz.play("a")       # the virus owns the rig: sound the alarm
        self.mode = m
        self._load()

    def _load(self):
        """Decode the running mode's recipe; built-in modes have none."""
        rc = b"" if self.mode in NATIVE else self.recipes.get(self.mode, b"")
        self.layers = []
        for o in range(0, len(rc) - LAYER + 1, LAYER):
            s, fl, sp, p1, p2, lo, hi, gm = rc[o:o + 8]
            self.layers.append((s, fl, sp - 256 if sp > 127 else sp, p1, p2, lo / 255, hi / 255,
                                (gm or 10) / 10, tuple(rc[o + 8:o + 11]), tuple(rc[o + 11:o + 14])))
        self.fx = [0.0] * len(self.layers)
        self.fxc = [l[8] for l in self.layers]
        self.motion = any(l[1] & MOTION for l in self.layers)

    def _glitch_clock(self, dt):
        if self.cut > 0:
            self.cut -= dt
        elif random.random() < 0.007:
            self.cut = 0.08 + random.random() * 0.2
        if self.burst > 0:
            self.burst -= dt
        elif random.random() < 0.03:
            self.burst = 0.08 + random.random() * 0.35

    def _col(self, m, slot, default):
        """Tuned main (0) / accent (1) colour for mode m, else the built-in one."""
        t = self.tune.get("H" if m in "FV" else m)
        return t[1 + slot] if t else default

    def _mix(self, i, t, now):
        """One pixel of the running recipe."""
        key = self.key
        r = g = b = 0.0
        for j, (s, fl, sp, p1, p2, lo, hi, gm, ca, cb) in enumerate(self.layers):
            if fl & FLASH:
                if now >= self.fx[j]:
                    continue
                ca = self.fxc[j]
            if fl & BURST and self.burst <= 0:
                continue
            idx = N - 1 - i if fl & MIRROR and key % 2 else i
            c, v = ca, hi
            if s == CHASE or s == SWEEP:
                best, near = 0.0, N
                for h in range(p1 or 1):
                    d = (t * sp / 20 * N + h * N / (p1 or 1) - idx) % N
                    if s == SWEEP:
                        d = min(d, N - d)
                    near = min(near, d)
                    best = max(best, 1 - d * 10 / (p2 or 10))
                v = lo + (hi - lo) * best ** gm
                if fl & USE_B and near < 1:
                    c, v = cb, hi
            elif s == WAVE:
                ph = self.oc_phase * 6.283 if fl & MOTION else t * sp / 10
                w = 0.5 + 0.5 * math.sin(ph + idx * p1 / 10 + key * p2 / 10)
                v = lo + (hi - lo) * w ** gm
                if fl & USE_B:
                    c = mix(ca, cb, w)
                if fl & MOTION:
                    c = mix(c, WHITE, self.energy)
            elif s == DRIP:
                side = 0 if i < 5 else 1
                down = i if i < 5 else 9 - i            # 0 = top of this side .. 4 = bottom
                best, which, n = 0.0, 0, p1 or 1
                for k in range(n):
                    pos = (t * sp / 10 * (1 + 0.15 * (k - (n - 1) / 2)) + key * 1.7 + side * 3.3
                           + k * 2.9) % ((p2 or 90) / 10)
                    d = pos - down
                    lv = 1.0 if 0 <= d < 1 else (3 - d) / 2 * 0.45 if 1 <= d < 3 else 0.0
                    if lv > best:
                        best, which = lv, k
                v = lo + (hi - lo) * best
                if fl & USE_B:
                    c = (ca, cb, mix(ca, cb, 0.5))[which % 3]
            elif s == PULSE:
                if p1 == 0:
                    w = heart(t)
                elif p1 == 1:
                    w = breath(t)
                elif p1 == 2:                           # strobe
                    ph = t * sp / 10
                    w = 1.0 if ph % 1 < p2 / 100 else 0.0
                    if fl & USE_B and int(ph) % 2:
                        c = cb
                elif p1 == 3:                           # candle flicker
                    w = 0.7 + 0.15 * math.sin(t * 13 + i) + 0.15 * math.sin(t * 7.3 + i * 2.1 + key)
                    if fl & USE_B and w > 0.85:
                        c = cb
                else:                                   # a beat every p2/10 s
                    w = 1.0 if t % ((p2 or 40) / 10) < sp / 100 else 0.0
                v = lo + (hi - lo) * min(1.0, w) ** gm
            elif s == SPARKLE:
                if fl & MOTION and self.energy < 0.7:
                    continue
                if random.random() * 255 >= p1:
                    continue
                if fl & USE_B and random.random() < 0.5:
                    c = cb
            elif s == HALF:
                if ((i < 5) != bool(key % 2)) != bool(p1):
                    continue
            if fl & CUT and self.cut > 0:
                v = lo if s == FILL or s == HALF else 0.0
            if fl & BUZZ:
                v *= 0.85 + 0.15 * math.sin(t * 47 + i)
            if v <= 0:
                continue
            v = min(1.0, v)
            if fl & OVER:
                r, g, b = c[0] * v, c[1] * v, c[2] * v
            else:
                r, g, b = max(r, c[0] * v), max(g, c[1] * v), max(b, c[2] * v)
        return (int(r), int(g), int(b))

    def _pixel(self, i, t):
        m, key = self.mode, self.key
        if m == "C":
            # quick white flash on lock, then breathe in the scanned color
            f = time.monotonic() - self.t0
            if f < 0.25:
                return WHITE
            return scale(self.custom, 0.25 + 0.75 * breath(t - i / N * 0.8))
        if m == "B":
            # rebreather: drift between the two colors, rippling around the ring
            w = 0.5 - 0.5 * math.cos((t - i / N * 0.8) * 2 * math.pi / 5.5)
            a, b = self.pair[:3], self.pair[3:]
            return scale(mix(a, b, w), 0.35 + 0.65 * w)
        if m == "W":
            # standby: blink slows from 0.6 s to 4 s over 2 min (same curve as the CLUE)
            k = (4.0 - 0.6) / 120
            ph = math.log(1 + k * (t - self.t0) / 0.6) / k
            return WHITE if ph % 1.0 < 0.5 else OFF
        if m in ("H", "F", "V"):
            idx = N - 1 - i if key % 2 else i
            pos = (t * N * 0.45) % N
            d = abs(idx - pos)
            d = min(d, N - d)
            c = scale(self._col(m, 0, RED), (max(0, 1 - d / (N * 0.25))) ** 2 * 0.95 + 0.04)
            if m != "H" and self.burst > 0 and random.random() > 0.6:
                c = self._col(m, 1, MAG) if random.random() > 0.5 else WHITE   # virus stabs
            return c
        if m == "R":
            x = (i / N) * 0.5 + key * 0.5          # left intake leads, right follows
            return wheel(x * self.rb[1] / 100 - self.rb_phase)
        if m == "P":
            f = time.monotonic() - self.t0
            if f < 0.4:
                k = f / 0.4
            elif f < 1.6:
                k = 1
            else:
                k = max(0, 1 - ((f - 1.6) / 4) ** 0.8)
            return scale(self._col("P", 0, WHITE), k)
        if m == "O":
            return OFF
        # D, and any pushed mode whose recipe hasn't arrived: dark purple with a
        # brighter arc slowly circling; the two intakes turn opposite ways
        idx = N - 1 - i if key % 2 else i
        d = (t * 0.25 * N - idx) % N            # 0.25 turns a second
        return scale(self._col("D", 0, PURPLE), 0.12 + 0.88 * max(0.0, 1 - d / 4) ** 2)

    def _vu(self, now, dt):
        lvl = self.mic.level() if self.mic else 0.0
        # fast attack, slower release
        self.vu = lvl if lvl > self.vu else self.vu - (self.vu - lvl) * min(1, dt * 6)
        h = self.vu * 5                       # 0..5 pixels per side
        if h >= self.peak:
            self.peak, self.peak_t = h, now
        elif now - self.peak_t > 0.4:
            self.peak = max(0.0, self.peak - dt * 4)   # peak dot falls
        for side in (VU_LEFT, VU_RIGHT):
            for k, p in enumerate(side):
                if h >= k + 1:
                    c = VU_COLORS[k]
                elif h > k:
                    c = scale(VU_COLORS[k], h - k)     # partial top pixel
                else:
                    c = OFF
                if int(self.peak) == k and self.peak > 0.5 and h < k + 1:
                    c = (255, 255, 255) if k < 4 else (255, 60, 60)
                tn = self.tune.get("A")
                self.px[p] = scale(c, tn[0]) if tn else c
        self.px.show()

    def update(self):
        now = time.monotonic()
        dt = min(0.05, now - self.last)
        self.last = now
        if self.save_at and now > self.save_at:
            self.save_at = 0.0
            save_recipes(self.recipes)
        if self.buzz:
            self.buzz.update(now)
        if self.alert_k:
            f = now - self.alert_t
            if f < ALERT_TIME[self.alert_k]:
                for i in range(N):
                    self.px[i] = self._alert_pixel(i, f)
                self.px.show()
                return
            self.alert_k = None
        if self.mode == "A":
            self._vu(now, dt)
            return
        self._glitch_clock(dt)
        for j, l in enumerate(self.layers):      # lightning / boo: random, not too often
            if l[1] & FLASH and now > self.fx[j] + 1.5 and random.random() < 0.006:
                self.fx[j] = now + 0.06 + random.random() * 0.18
                self.fxc[j] = l[9] if l[1] & USE_B and random.random() < 0.5 else l[8]
        if self.motion:                      # motion -> energy -> wave speed
            if self.accel:
                try:
                    x, y, z = self.accel.acceleration
                    jolt = min(1.0, abs(math.sqrt(x * x + y * y + z * z) - 9.8) / 6)
                except Exception:
                    jolt = 0.0
            else:
                jolt = 0.25 + 0.2 * math.sin(now * 0.5)   # no sensor: idles warm
            # jumps up fast, cools off slowly
            self.energy = jolt if jolt > self.energy else self.energy - (self.energy - jolt) * min(1, dt * 0.8)
            self.oc_phase += dt * (0.3 + 3.0 * self.energy)
        if self.mode == "R":                 # integrate, so speed changes stay smooth
            sp, _, fwd = self.rb
            self.rb_phase += dt * 0.06 * sp / 50 * (1 if fwd else -1)
        t = now
        tn = self.tune.get("H" if self.mode in "FV" else self.mode)
        k = tn[0] if tn else 1.0                      # per-mode brightness
        recipe = bool(self.layers)
        for i in range(N):
            c = self._mix(i, t, now) if recipe else self._pixel(i, t)
            self.px[i] = c if k >= 1 else scale(c, k)
        self.px.show()
