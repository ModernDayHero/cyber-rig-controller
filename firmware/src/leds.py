# Shared intake animations for both Circuit Playgrounds (ported from the
# Cyber headgear configurator). 10 NeoPixels per intake.
#
# Mode bytes (sent by the CLUE):
#   D dark     purple slow breathing          I = alias for D (idle)
#   X glitch   magenta + cyan bursts and cutouts
#   H hunt     red scanner sweep               h = heartbeat pulse
#   r rain     blue drops running down both sides, white lightning flashes
#   M matrix   green rain drip
#   R rainbow  slow color wave
#   P peace    white fade up, hold, fade to off
#   F/V virus  takeover: red sweep with glitch stabs (CLUE virus mode)
#   C r g b    scanned color (4 bytes): breathes in that color
#   B r g b r g b  rebreather (7 bytes): breathes between two colors
#   Z k b rgb rgb  tuning (10 bytes): mode k's brightness % + main / accent colour
#   S sp w dir   rainbow settings (4 bytes): speed sp/50 x, width w/100 of the
#                hue wheel, dir 1 forward / 0 reverse
#   W standby  blinks white (CLUE sends O after ~2 min)
#   O off      all pixels off
#   A audio    mic VU meter: both sides fill from the bottom,
#              green -> yellow -> red at the top, with a falling peak dot

import math
import random
import time

N = 10
PURPLE = (160, 60, 255)
MAG = (255, 43, 214)
CYAN = (0, 229, 255)
RED = (255, 30, 30)
GREEN = (34, 255, 102)
GREEN_HEAD = (200, 255, 216)
WHITE = (255, 255, 255)
RAIN_COLORS = (PURPLE, MAG, CYAN)
OFF = (0, 0, 0)

def scale(c, k):
    k = max(0.0, min(1.0, k))
    return (int(c[0] * k), int(c[1] * k), int(c[2] * k))

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

MODE_CHARS = "DXHhMRPAIFVWOr"
PACKETS = {"C": 3, "B": 6, "S": 3, "Z": 8}   # command -> number of data bytes that follow

class Parser:
    """Turns a byte stream into commands. Handles C/B packets split across reads."""
    def __init__(self):
        self.cmd = None
        self.pending = []
    def feed(self, data):
        out = []
        for byte in data:
            if self.cmd:
                self.pending.append(byte)
                if len(self.pending) == PACKETS[self.cmd]:
                    out.append((self.cmd, tuple(self.pending)))
                    self.cmd = None
            elif chr(byte) in PACKETS:
                self.cmd, self.pending = chr(byte), []
            elif chr(byte) in MODE_CHARS:
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

# VU layout: on a Circuit Playground, pixels 0-4 run down one side and 5-9 up the other.
# Index lists go bottom -> top. Swap them if an intake board is mounted upside down.
VU_LEFT = (4, 3, 2, 1, 0)
VU_RIGHT = (5, 6, 7, 8, 9)
VU_COLORS = ((0, 255, 40), (90, 255, 0), (255, 200, 0), (255, 110, 0), (255, 0, 0))

class Lens:
    def __init__(self, pixels, key, mic=None):
        self.mic = mic            # Mic() enables mode A
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
        self.seed = 0
        self.last = time.monotonic()
        self.flash = 0.0          # rain mode: lightning until this time
        self.flash_c = CYAN
        self.rb = (50, 30, 1)     # rainbow speed / width / direction bytes
        self.tune = {}            # mode -> (brightness 0-1, main rgb, accent rgb), from Z
        self.rb_phase = 0.0

    def set_color(self, rgb):
        self.custom = rgb
        self.mode = "C"
        self.t0 = time.monotonic()

    def set_breathe(self, pair):
        if self.mode != "B":
            self.t0 = time.monotonic()
        self.pair = pair
        self.mode = "B"

    def apply(self, m, data=None):
        """Run one parsed command (mode byte, C color or B color pair)."""
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
        else:
            self.set_mode(m)

    def packet(self):
        """Bytes that recreate the current state on another board."""
        if self.mode == "C":
            return encode("C", self.custom)
        if self.mode == "B":
            return encode("B", self.pair)
        return encode(self.mode, None)

    def set_mode(self, m):
        if m == "I":
            m = "D"
        if m != self.mode:
            self.t0 = time.monotonic()
        self.mode = m

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

    def _pixel(self, i, t):
        m, key = self.mode, self.key
        if m == "D":
            return scale(self._col("D", 0, PURPLE), breath(t - i / N * 0.8))
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
            return scale((a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w,
                          a[2] + (b[2] - a[2]) * w), 0.35 + 0.65 * w)
        if m == "r":
            if t < self.flash:                    # lightning, glitch colors
                return self.flash_c if random.random() > 0.15 else OFF
            s = i if i < 5 else 9 - i            # 0 = top of this side .. 4 = bottom
            side = 0 if i < 5 else 1
            a, z = self._col("r", 0, PURPLE), self._col("r", 1, CYAN)
            drops = (a, ((a[0] + z[0]) // 2, (a[1] + z[1]) // 2, (a[2] + z[2]) // 2), z) if "r" in self.tune else RAIN_COLORS
            c, best = drops[0], 0.0
            for k, speed in ((0, 3.1), (1, 2.3), (2, 2.7)):  # drops per side
                p = (t * speed + key * 1.7 + side * 3.3 + k * 2.9) % 9
                d = p - s
                if 0 <= d < 1:
                    k_lvl = 1.0
                elif 1 <= d < 3:
                    k_lvl = (3 - d) / 2 * 0.45     # fading tail above the head
                else:
                    continue
                if k_lvl > best:
                    c, best = drops[k], k_lvl
            return scale(c, 0.04 + 0.96 * best)
        if m == "W":
            # standby: blink slows from 0.6 s to 4 s over 2 min (same curve as the CLUE)
            k = (4.0 - 0.6) / 120
            ph = math.log(1 + k * (t - self.t0) / 0.6) / k
            return WHITE if ph % 1.0 < 0.5 else OFF
        if m == "X":
            if self.cut > 0:
                return OFF
            r = random.random()
            mg, cy = self._col("X", 0, MAG), self._col("X", 1, CYAN)
            if self.burst > 0:
                return (mg if random.random() > 0.5 else cy) if r > 0.3 else OFF
            return scale(mg, 0.85) if r > 0.93 else scale(cy, 0.22)
        if m == "h":
            return scale(RED, 0.06 + 0.94 * heart(t))
        if m in ("H", "F", "V"):
            idx = N - 1 - i if key % 2 else i
            pos = (t * N * 0.45) % N
            d = abs(idx - pos)
            d = min(d, N - d)
            c = scale(self._col(m, 0, RED), (max(0, 1 - d / (N * 0.25))) ** 2 * 0.95 + 0.04)
            if m != "H" and self.burst > 0 and random.random() > 0.6:
                c = self._col(m, 1, MAG) if random.random() > 0.5 else WHITE   # virus stabs
            return c
        if m == "M":
            d = (t * N * 0.55 + key * 3.1) % N - i
            if d < 0:
                d += N
            g = self._col("M", 0, GREEN)
            if d < 1:
                return GREEN_HEAD if g is GREEN else tuple(min(255, v // 2 + 128) for v in g)   # pale head
            return scale(g, (1 - d / (N * 0.5)) ** 1.6 if d < N * 0.5 else 0.03)
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
            return scale(WHITE, k)
        return OFF

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
        if self.mode == "A":
            self._vu(now, dt)
            return
        self._glitch_clock(dt)
        if self.mode == "r" and now > self.flash + 1.5 and random.random() < 0.006:
            self.flash = now + 0.06 + random.random() * 0.18   # lightning
            self.flash_c = self._col("r", 0, MAG) if random.random() > 0.5 else self._col("r", 1, CYAN)
        if self.mode == "R":                 # integrate, so speed changes stay smooth
            sp, _, fwd = self.rb
            self.rb_phase += dt * 0.06 * sp / 50 * (1 if fwd else -1)
        t = now
        tn = self.tune.get("H" if self.mode in "FV" else self.mode)
        k = tn[0] if tn else 1.0                      # per-mode brightness
        for i in range(N):
            c = self._pixel(i, t)
            self.px[i] = c if k >= 1 else scale(c, k)
        self.px.show()
