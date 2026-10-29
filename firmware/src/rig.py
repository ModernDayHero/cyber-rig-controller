# CLUE: STEAMWorkz rebreather controller
# CircuitPython 9.x on the Adafruit CLUE
#
# CIRCUITPY/
#   code.py            (this file)
#   octlet_sprite.bmp  8 frames, 64x64
#   octlet_mini.bmp    2 frames, 16x16 (swarm)
#   lib/ adafruit_imageload, adafruit_display_text, adafruit_apds9960,
#        adafruit_register, adafruit_bus_device, adafruit_ble
#   (no display_text or lsm6ds: text and the accelerometer are done by hand to save ~45 KB RAM)
#
# Controls
#   A / B   next / previous mode in the current set (presses are queued, never missed)
#   A + B   pressed together: switch set, STEAMWorkz OS <-> ALT (same as pad 1)
#   Pad 0   hold 5 s: STANDBY (rig blinks white, slowing down over ~2 min as it
#           counts down, then everything off); keep holding to 10 s: off now;
#           hold 5 s again: ACTIVE. Power-up and wake blink white, then land
#           on STEAMWorkz OS // DARK (purple).
#   Pad 1   tap: switch set, STEAMWorkz OS <-> ALT
#             OS:  DARK / GLITCH / RAINFALL (blue rain + lightning) / MATRIX /
#                  HEARTBEAT (beating heart) / NETRUN / SCANNER
#                  screen: terminal + Octlet
#             ALT: AUDIO VU (live meter, Octlet riding the bars; rig runs its own VU) /
#                  RAINBOW (rainbow wave screen, rig rainbow) /
#                  REBREATHER (rig breathes between two colors) /
#                  HACK (releases the virus now; after a cure a hand wave re-releases it) /
#                  WATCH (clock face) / SIGN OFF / NEON / OVERCLOCK (terminal speeds up as it moves)
#           A/B only ever cycle inside the current set; pad 1 is the set switch.
#   Pad 2   color picker for REBREATHER (jumps there from any mode):
#           tap = COLOR PICKER 1 (white LEDs + live color block, rig previews it),
#           tap = lock color 1, COLOR PICKER 2; tap = lock color 2, rig breathes
#           between the two. A/B or pad 1 cancels.
#   Hand toward the sensor: Octlet startles (OS screen).
#   Virus also hijacks on its own every 3-5 min (random), from any mode: it jumps
#   to the OS screen and starts the takeover. The clock restarts after each infection.
#   While hacked, A/B and pads 1/2 are locked out (pad 0 power still works).
#   Cure: shake it, wave a hand over the sensor, or hold a hand over it.
#   Tilt the CLUE to slide the swarm over the text.
#
# Phone (Pro tier): the CLUE also advertises as RIG-CLUE (Nordic UART) while it
# stays connected to the Bluefruit. Newline-terminated text lines:
#   phone -> CLUE  M <os|alt> <i>   pick a mode (index into SETS)
#                  C r g b r g b    rebreather colors (switches to REBREATHER)
#                  R sp w dir       rainbow speed 5-250 (50 = 1x) / width 5-200 / dir 1|0
#                  T min max        random-hack timer in seconds (T 0 0 = off)
#                  W y mo d h mi s wd  set the clock (phone sends its time on connect)
#                  S k b r g b r g b  tune mode k: brightness % + main / accent colour
#                                   (passed to the mask, kept in NVM across restarts)
#                  P standby|off|wake
#                  N c|m [text]     incoming call / message: mask lights + sound everywhere
#                  J / I / Y        a picture (16x16, from the phone's library) or a typed
#                                   word on screen, the mask in a mode meanwhile, then
#                                   back (see "pictures + words" below)
#                  Q 0|1            mute: 1 silences the CLUE and the mask (sent on connect)
#                  H  start the hack     K  purge it     ?  report everything
#   CLUE -> phone  M <set> <i> / C r g b r g b / R sp w dir / T min max / P on|waking|blink|off /
#                  V 0|1 (hacked) / L 0|1 0|1 (left / right Bluefruit links), sent on every change
#   While hacked the phone's M/C are refused like the buttons; K still purges.
#
# Big sprite frames: 0 rest, 1 wiggle A, 2 wiggle B, 3 angry,
#                    4 look left, 5 look right, 6 reach 1, 7 reach 2
# Palette index: 0 transparent/pad hole, 1 body, 2 eye white, 3 pupil, 4 lit bit

import gc
import time
import math
import array
import random
import struct
import rtc
import vectorio
import microcontroller
import audiobusio
import pwmio
import board
import digitalio
import displayio
import keypad
import terminalio
import adafruit_imageload
import touchio
from adafruit_apds9960.apds9960 import APDS9960

# ---------- colors ----------
PURPLE, MAGENTA, CYAN, RED = 0x6E00B4, 0xFF008C, 0x00E6FF, 0xDC0014
DIM_RED, GREEN, WHITE = 0x5A0000, 0x00D250, 0xE6E6FF
PALETTES = {  # body, eye white, pupil, lit bit
    "brand":   (0x00C8D2, 0xF0F0FF, 0x1428A0, 0xFFFFFF),
    "hostile": (RED, 0xFFC8C8, DIM_RED, 0xFFC8C8),
}

# ---------- mode sets ----------
# (byte sent to the rebreather, name, CLUE theme color (None = rainbow), screen)
# byte None = REBREATHER: sends B + the two breathe colors instead
SETS = {
    "os": [
        (b"D", "DARK",       PURPLE,   "term"),
        (b"X", "GLITCH",     MAGENTA,  "term"),
        (b"r", "RAINFALL",   0xB040FF, "term"),   # purple/magenta/cyan rain + lightning
        (b"M", "MATRIX",     GREEN,    "term"),
        (b"h", "HEARTBEAT",  RED,      "heart"),    # red lub-dub pulse, a beating heart on screen
        (b"n", "NETRUN",     CYAN,     "term"),     # cyan packets racing round, jacking in
        (b"s", "SCANNER",    0xFFAA00, "term"),     # slow targeting sweep, lock-on flash
    ],
    "alt": [
        (b"A", "AUDIO VU",   0xFFC800, "vu"),
        (b"R", "RAINBOW",    None,     "rainbow"),
        (None, "REBREATHER", CYAN,     "breathe"),
        (b"H", "HACK",       RED,      "term"),     # on demand: releases the virus
        (b"D", "WATCH",      0x39B6C0, "watch"),    # clock face; the rig runs Dark meanwhile
        (b"P", "SIGN OFF",   WHITE,    "term"),     # rig flares white, then fades out
        (b"e", "NEON",       0xFF1496, "term"),     # pink / cyan neon sign, buzzing
        (b"o", "OVERCLOCK",  0xFF6E00, "term"),     # amber -> white-hot, faster as you move
    ],
}
SET_NAMES = {"os": "STEAMWorkz OS", "alt": "ALT"}
cur_set = "os"
idx = {"os": 0, "alt": 0}           # each set remembers where you were

def cur():
    return SETS[cur_set][idx[cur_set]]

# rebreather breathe colors, set with the pad 2 color pickers (defaults purple -> cyan)
pair = [(160, 60, 255), (0, 229, 255)]
rb = [50, 30, 1]          # rainbow speed / width / direction (same bytes as the mask's S)

# Per-mode tuning from the phone: key -> bytes(bright, r, g, b, r, g, b). Kept in NVM:
# [0xA5, count, then count x (key, 7 bytes)]. Dark starts dimmer (60%) by default.
tunes = {"D": bytes((60, 160, 60, 255, 160, 60, 255))}
def load_tunes():
    nv = microcontroller.nvm
    if nv is None or nv[0] != 0xA5:
        return
    for i in range(min(nv[1], 16)):
        rec = nv[2 + i * 8: 10 + i * 8]
        tunes[chr(rec[0])] = bytes(rec[1:8])
def save_tunes():
    nv = microcontroller.nvm
    if nv is None:
        return
    blob = bytearray((0xA5, len(tunes)))
    for k, v in tunes.items():
        blob += bytes((ord(k),)) + v
    nv[0:len(blob)] = blob
load_tunes()
rb_phase = 0.0
BREATHE_IDX = 2           # REBREATHER's slot in the ALT set

HOLD_TIME = 5.0           # seconds on pad 0 to switch ACTIVE / STANDBY
BLINK_TIME = 120.0        # seconds of white blinking before everything goes off
BLINK_START, BLINK_END = 0.6, 4.0   # standby blink period (s): starts quick, slows to shutdown
WAKE_TIME = 2.0           # seconds of white blinking on power-up / wake, then DARK

# ---------- buttons (queued in the background so no press is missed) ----------
keys = keypad.Keys((board.BUTTON_A, board.BUTTON_B), value_when_pressed=False, pull=True)

# ---------- touch pads + color scanner ----------
power_pad = touchio.TouchIn(board.D0)     # gold pad 0: hold 5 s = standby / active
set_pad = touchio.TouchIn(board.D1)       # gold pad 1: OS <-> ALT
scan_pad = touchio.TouchIn(board.D2)      # gold pad 2: open scanner / lock color
apds = APDS9960(board.I2C())
apds.enable_color = True
apds.enable_proximity = True
apds.color_integration_time = 236         # ~56 ms per reading (default is ~700 ms)
NEAR, FAR = 60, 25        # proximity 0-255; hysteresis so it doesn't chatter
near = False
near_since = 0.0

def hand_approached():
    """True once each time a hand (or object) comes close to the sensor."""
    global near, near_since
    p = apds.proximity
    if not near and p > NEAR:
        near = True
        near_since = time.monotonic()
        return True
    if near and p < FAR:
        near = False
    return False

lamp = digitalio.DigitalInOut(board.WHITE_LEDS)   # the two white LEDs by the sensor
lamp.switch_to_output(value=False)

# ---------- motion + sound ----------
# accelerometer read straight off the LSM6DS33 / LSM6DS3TR-C (same registers on
# both CLUE revisions); the full adafruit_lsm6ds driver costs ~15 KB of RAM
i2c = board.I2C()
IMU = 0x6A
_abuf = bytearray(6)
G_PER_LSB = 0.000122 * 9.80665          # +-4 g range, in m/s^2

def _imu_io(out, into=None):
    while not i2c.try_lock():
        pass
    try:
        if into is None:
            i2c.writeto(IMU, out)
        else:
            i2c.writeto_then_readfrom(IMU, out, into)
    finally:
        i2c.unlock()

_imu_io(bytes((0x10, 0x48)))           # CTRL1_XL: 104 Hz, +-4 g (shakes go past 2 g)

def accel():
    _imu_io(b"(", _abuf)             # OUTX_L_XL .. OUTZ_H_XL
    x, y, z = struct.unpack("<hhh", _abuf)
    return x * G_PER_LSB, y * G_PER_LSB, z * G_PER_LSB
mic = audiobusio.PDMIn(board.MICROPHONE_CLOCK, board.MICROPHONE_DATA,
                       sample_rate=16000, bit_depth=16)
mic_buf = array.array("H", [0] * 160)

SHAKE = 22                # m/s^2 total to count as a shake (resting is ~9.8)
HOLD = 1.0                # seconds a hand must stay over the sensor to cure
GRACE = 1.0               # seconds after infection before cures count
TILT_X, TILT_Y = -0.06, 0.06   # tilt push on the swarm; flip a sign if it rolls uphill
tilt = (0.0, 0.0)

def sound_level():
    mic.record(mic_buf, len(mic_buf))
    mean = sum(mic_buf) / len(mic_buf)
    return math.sqrt(sum((s - mean) ** 2 for s in mic_buf) / len(mic_buf))

# VU auto-gain (same idea as the rebreather's Mic.level)
vu_floor, vu_top = 10.0, 300.0
def vu_level():
    global vu_floor, vu_top
    rms = sound_level() + 1
    vu_floor = min(vu_floor * 1.002 + 0.02, rms)
    vu_top = max(vu_top * 0.995, rms, vu_floor * 4)
    lo, hi = math.log(vu_floor), math.log(vu_top)
    return max(0.0, min(1.0, (math.log(rms) - lo) / (hi - lo)))

def read_color():
    """Sensor reading -> bright, saturated RGB that looks good on NeoPixels."""
    if not apds.color_data_ready:
        return None
    r, g, b, c = apds.color_data
    m = max(r, g, b, 1)
    r, g, b = r / m, g / m, b / m          # normalize so the strongest channel is 1
    lo = min(r, g, b)
    if lo < 0.95:                          # stretch saturation, keep greys grey
        r, g, b = [(x - lo) / (1 - lo) for x in (r, g, b)]
    return (int(r * 255), int(g * 255), int(b * 255))

def rgb_int(c):
    return (int(c[0]) << 16) | (int(c[1]) << 8) | int(c[2])

# ---------- display ----------
display = board.DISPLAY
root = displayio.Group()
display.root_group = root

# text: one TileGrid row of font glyphs per line, each with its own 2-color
# palette (a few hundred bytes, vs ~3 KB per adafruit_display_text label)
FONT = terminalio.FONT
GW, GH = FONT.get_bounding_box()[:2]
BLANK = FONT.get_glyph(32).tile_index

def make_text(cols, x, y, color, scale=1):
    """-> (group, tilegrid, palette). Change color with palette[1] = ..."""
    p = displayio.Palette(2)
    p.make_transparent(0)
    p[1] = color
    tg = displayio.TileGrid(FONT.bitmap, pixel_shader=p, width=cols, height=1,
                            tile_width=GW, tile_height=GH, default_tile=BLANK)
    g = displayio.Group(x=x, y=y, scale=scale)
    g.append(tg)
    return g, tg, p

_GLYPH = {}               # char -> tile index, filled as characters are first used

def set_text(tg, s):
    n = len(s)
    for i in range(tg.width):
        if i >= n:
            tg[i] = BLANK
            continue
        ti = _GLYPH.get(s[i])
        if ti is None:
            g = FONT.get_glyph(ord(s[i]))
            ti = _GLYPH[s[i]] = g.tile_index if g else BLANK
        tg[i] = ti

# terminal: 12 lines of 6x14 text, scrolled by moving rows (no text copying)
T_COLS = 38
term = displayio.Group()
ROWS = []                 # [group, tilegrid, palette], top to bottom
TEXTS = [""] * 12         # what each row says, for the glitch effect
for i in range(12):
    r = make_text(T_COLS, 4, 3 + i * 19, PURPLE)
    ROWS.append(r)
    term.append(r[0])
root.append(term)

def term_color(color):
    for r in ROWS:
        r[2][1] = color

IDLE_TEXT = [
    "> sync rebreather ..... OK", "> netrunner.daemon up", "> scan 2.4GHz ch{}",
    "> mem 0x{:04X} clean", "> octlet bus {:08b}", "> heartbeat {} bpm",
    "> ICE layer nominal", "> uplink steamworkz.com", "> cyberware temp {}C",
]
VIRUS_TEXT = [
    "!! octlet.exe REPLICATING", "!! ICE BREACHED", "!! write 0x{:04X} DENIED",
    "!! process {} hijacked", "!! you are not in control", "!! 8 legs // 1 byte",
    "!! uplink REROUTED", "!! kernel {:08b}", "!! RESISTANCE IS 0x00",
]
GLITCH = "#%&@$!?/\\|<>=+*"
# The terminal modes' own lines, and every how many loops one is added.
MODE_TEXT = {
    b"n": (("> jack in // node 0x{:04X}", "> trace 10.0.{}.1", "> ICE probe {:08b}", "> breach {}%",
            "> daemon.inject 0x{:04X}", "> netrun ok // {}ms"), 2),
    b"s": (("> scanning sector {}", "> sweep {} deg", "> contact? 0x{:04X}", "> range {}m",
            "> TARGET ACQUIRED", "> lock {:08b}"), 8),
    b"e": (("> NEON // OPEN 24/7", "> buzz {}hz", "> tube {} ok", "> glow 0x{:04X}"), 10),
    b"o": (("> core {}C", "> clock {}00 MHz", "> volts 1.{}", "> OVERCLOCK x{}"), 6),
}

def fill(tmpl):
    return tmpl.format(random.randint(0, 0xFFFF) if "X}" in tmpl
                       else random.randint(0, 255) if "b}" in tmpl
                       else random.randint(1, 99))

RAIN_COLORS = (PURPLE, MAGENTA, CYAN)
rain_flash = 0.0

def drop_line():
    """RAINFALL mode: a scatter of falling drops."""
    return "".join(random.choice("     |   .  ") for _ in range(T_COLS))

def rain_line():
    """MATRIX mode: a line of falling 1s and 0s."""
    return "".join(random.choice("01 ") for _ in range(30))

def term_push(text, color, down=False):
    """New line at the bottom (scrolls up), or at the top with down=True (rain falls)."""
    if down:
        r = ROWS.pop()
        ROWS.insert(0, r)
        TEXTS.pop()
        TEXTS.insert(0, text[:T_COLS])
    else:
        r = ROWS.pop(0)       # oldest row moves to the bottom with the new text
        ROWS.append(r)
        TEXTS.pop(0)
        TEXTS.append(text[:T_COLS])
    for i, row in enumerate(ROWS):
        row[0].y = 3 + i * 19
    set_text(r[1], text[:T_COLS])
    r[2][1] = color

def term_glitch(n):
    for _ in range(n):
        k = random.randrange(len(ROWS))
        s = list(TEXTS[k] or " " * 20)
        for _ in range(4):
            s[random.randrange(len(s))] = random.choice(GLITCH)
        TEXTS[k] = "".join(s)
        set_text(ROWS[k][1], TEXTS[k])
        ROWS[k][2][1] = RED

# big Octlet (loaded before BLE so the 16 KB sheet gets a contiguous block)
gc.collect()
sheet, _ = adafruit_imageload.load("/octlet_sprite.bmp",
                                   bitmap=displayio.Bitmap, palette=displayio.Palette)
pal = displayio.Palette(5)
pal.make_transparent(0)
octlet = displayio.TileGrid(sheet, pixel_shader=pal, width=1, height=1,
                            tile_width=64, tile_height=64)
icon = displayio.Group(scale=1, x=240 - 68, y=4)
icon.append(octlet)
root.append(icon)

def set_mode(name, p=pal):
    p[1], p[2], p[3], p[4] = PALETTES[name]

def tint(color, p=pal):
    """Octlet in any theme color: body, white eye, dimmed pupil, contrasting bits."""
    r, g, b = color >> 16, (color >> 8) & 0xFF, color & 0xFF
    p[1], p[2], p[3] = color, 0xF0F0FF, ((r // 3) << 16) | ((g // 3) << 8) | (b // 3)
    p[4] = MAGENTA if color == CYAN else CYAN

# leg pads = a byte (leg 0 lower-left = bit 7 ... leg 7 top = bit 0)
PADS = [
    [(17, 57), (20, 47), (13, 40), (21, 34), (20, 24), (30, 23), (35, 14), (44, 20)],
    [(16, 56), (20, 49), (13, 38), (21, 35), (21, 22), (29, 24), (36, 14), (42, 20)],
    [(18, 59), (20, 46), (13, 42), (22, 33), (19, 25), (31, 22), (33, 15), (45, 20)],
    [(17, 57), (20, 47), (13, 40), (21, 34), (20, 24), (30, 23), (35, 14), (44, 20)],
    [(17, 57), (20, 47), (13, 40), (21, 34), (20, 24), (30, 23), (35, 14), (44, 20)],
    [(17, 57), (20, 47), (13, 40), (21, 34), (20, 24), (30, 23), (35, 14), (44, 20)],
    [(13, 57), (18, 49), (10, 38), (18, 34), (18, 20), (28, 22), (36, 10), (42, 17)],
    [(13, 62), (15, 47), (7, 41), (18, 31), (14, 21), (29, 18), (31, 9), (45, 15)],
]
_byte = 0
def _paint(b, i_):
    for f in range(8):
        ox = f * 64
        for i, (x, y) in enumerate(PADS[f]):
            if (b >> (7 - i)) & 1:
                for dx in (-1, 0):
                    for dy in (-1, 0):
                        sheet[ox + x + dx, y + dy] = i_

def show_byte(b):
    global _byte
    _paint(_byte, 0)
    _paint(b, 4)
    _byte = b

# swarm of 8 mini Octlets (one per bit)
mini_bmp, _ = adafruit_imageload.load("/octlet_mini.bmp",
                                      bitmap=displayio.Bitmap, palette=displayio.Palette)
mpal = displayio.Palette(5)
mpal.make_transparent(0)
mpal.make_transparent(4)
set_mode("hostile", mpal)
swarm = displayio.Group(scale=2)
SW = []
for _ in range(8):
    m = displayio.TileGrid(mini_bmp, pixel_shader=mpal, width=1, height=1,
                           tile_width=16, tile_height=16)
    m.hidden = True
    swarm.append(m)
    SW.append([m, 0.0, 0.0, 0.0, 0.0])   # tile, x, y, vx, vy (in half-res pixels)

# VU screen: 16x16 cells scaled x15; a scrolling history of mic levels
VU_W = 16
vu_bmp = displayio.Bitmap(VU_W, 16, 5)
vu_pal = displayio.Palette(5)
for i, c in enumerate((0x000000, 0x00FF28, 0xFFC800, 0xFF2000, 0xFFFFFF)):
    vu_pal[i] = c
vu_grp = displayio.Group()
vu_cells = displayio.Group(scale=15)
vu_cells.append(displayio.TileGrid(vu_bmp, pixel_shader=vu_pal))
vu_grp.append(vu_cells)
vu_text = make_text(20, 6, 3, 0xFFFFFF)
set_text(vu_text[1], "AUDIO VU")
vu_grp.append(vu_text[0])
vu_grp.hidden = True
root.append(vu_grp)
VU_SHAPE = (0.5, 0.7, 0.85, 1.0, 1.0, 0.85, 0.7, 0.5)   # 8 bars, tallest in the middle
SURF_SPEED = 0.7          # how fast the Octlet surfs side to side (rad/s)
vu_h = [0.0] * 8          # current bar heights (cells)

def vu_draw(lvl):
    """Live meter: every bar rises from the bottom with the sound, fast up,
    slower down, green -> yellow -> red."""
    for k in range(8):
        target = lvl * VU_SHAPE[k] * random.uniform(0.75, 1.05) * 16
        h = vu_h[k]
        h = target if target > h else h - (h - target) * 0.35
        vu_h[k] = h
        top, x = int(h + 0.5), k * 2
        for row in range(16):
            vu_bmp[x, 15 - row] = (1 if row < 10 else (2 if row < 13 else 3)) if row < top else 0

# REBREATHER screen: a big block breathing between the two colors
br_bmp = displayio.Bitmap(1, 1, 1)
br_pal = displayio.Palette(1)
br_grp = displayio.Group()
br_box = displayio.Group(scale=160, x=40, y=30)
br_box.append(displayio.TileGrid(br_bmp, pixel_shader=br_pal))
br_grp.append(br_box)
br_text = make_text(15, 30, 200, 0xFFFFFF, scale=2)
br_grp.append(br_text[0])
br_grp.hidden = True
root.append(br_grp)

def br_label():
    set_text(br_text[1], "#{:02X}{:02X}{:02X}>#{:02X}{:02X}{:02X}".format(*(pair[0] + pair[1])))

# RAINBOW screen: diagonal stripes whose palette rolls, so the wave moves for free
rb_bmp = displayio.Bitmap(16, 16, 16)
for y in range(16):
    for x in range(16):
        rb_bmp[x, y] = (x + y) % 16
rb_pal = displayio.Palette(16)
rb_grp = displayio.Group(scale=15)
rb_grp.append(displayio.TileGrid(rb_bmp, pixel_shader=rb_pal))
rb_grp.hidden = True
root.append(rb_grp)

# HEARTBEAT screen: a heart beating lub-dub (the mask's rhythm) and a BPM readout
heart_pal = displayio.Palette(1)
heart_pal[0] = RED
heart_grp = displayio.Group()
heart_l = vectorio.Circle(pixel_shader=heart_pal, radius=28, x=95, y=95)
heart_r = vectorio.Circle(pixel_shader=heart_pal, radius=28, x=145, y=95)
heart_v = vectorio.Polygon(pixel_shader=heart_pal, points=[(0, 0), (1, 0), (0, 1)], x=120, y=105)
for s in (heart_l, heart_r, heart_v):
    heart_grp.append(s)
bpm_txt = make_text(6, 84, 196, RED, scale=2)
heart_grp.append(bpm_txt[0])
heart_grp.hidden = True
root.append(heart_grp)
bpm = 72

def heart_beat(t):
    """Lub (full) and dub (0.7) about 57 times a minute: same as the mask's h."""
    p = t % 1.05
    return math.exp(-(p / 0.055) ** 2) + 0.7 * math.exp(-((p - 0.24) / 0.06) ** 2)

def heart_draw(now):
    global bpm
    k = 0.85 + 0.3 * heart_beat(now)
    heart_l.radius = heart_r.radius = int(28 * k)
    heart_l.x, heart_r.x = 120 - int(25 * k), 120 + int(25 * k)
    heart_l.y = heart_r.y = 105 - int(10 * k)
    heart_v.points = [(-int(52 * k), -int(2 * k)), (int(52 * k), -int(2 * k)), (0, int(62 * k))]
    if now % 1.05 < 0.05:                    # a new beat: the reading drifts a little
        bpm = max(64, min(84, bpm + random.choice((-1, 0, 1))))
        set_text(bpm_txt[1], "{} BPM".format(bpm))

# WATCH screen: the Octlet as a clock. Body + eye in the middle, legs as the hands.
W_CX, W_CY = 120, 112
TEAL, PAD, NAVY = 0x2EB8B0, 0xFFFFFF, 0x0B186A
def _pal(c):
    p = displayio.Palette(1)
    p[0] = c
    return p
watch_grp = displayio.Group()
for i in range(12):                                   # hour marks: circuit pads
    a = math.radians(i * 30)
    rr = 5 if i % 3 == 0 else 3
    x, y = int(W_CX + 92 * math.sin(a)), int(W_CY - 92 * math.cos(a))
    watch_grp.append(vectorio.Circle(pixel_shader=_pal(TEAL), radius=rr + 2, x=x, y=y))
    watch_grp.append(vectorio.Circle(pixel_shader=_pal(PAD), radius=rr, x=x, y=y))

def _hyp(x, y):                     # CircuitPython's math has no hypot()
    return math.sqrt(x * x + y * y)

def trace_path(length, at=48, jog=10, side=1):
    """Leg as a circuit trace, in local coords along +x: straight out past the gear
    (to `at` px), a 45-degree jog of `jog` px, then straight to the tip. Rotated so
    the tip still sits on the +x axis (the hand points at the right time).
    Returns [(x, y), ...] from the body out to the tip."""
    pts = [(0.0, 0.0), (at, 0.0), (at + jog, side * jog), (length, side * jog)]
    tx, ty = pts[-1]
    a = -math.atan2(ty, tx)
    k = length / _hyp(tx, ty)
    ca, sa = math.cos(a) * k, math.sin(a) * k
    return [(x * ca - y * sa, x * sa + y * ca) for x, y in pts]

def thick(pts, width):
    """Polyline -> closed polygon of the given width, mitred at the bends."""
    hw = width / 2
    n = len(pts)
    dirs = []
    for i in range(n - 1):
        dx, dy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        d = _hyp(dx, dy) or 1
        dirs.append((dx / d, dy / d))
    left, right = [], []
    for i in range(n):
        if i == 0:
            dx, dy = dirs[0]
            k = hw
        elif i == n - 1:
            dx, dy = dirs[-1]
            k = hw
        else:
            ax, ay = dirs[i - 1]
            bx, by = dirs[i]
            dx, dy = ax + bx, ay + by
            d = _hyp(dx, dy) or 1
            dx, dy = dx / d, dy / d
            k = hw / max(0.5, dx * ax + dy * ay)          # mitre: keep the width at the bend
        nx, ny = -dy, dx
        x, y = pts[i]
        left.append((x + nx * k, y + ny * k))
        right.append((x - nx * k, y - ny * k))
    return left + right[::-1]

def place(pts, frac):
    """Rotate local leg points (+x = out) to clock position frac (0 = 12 o'clock)."""
    a = frac * 2 * math.pi
    dx, dy = math.sin(a), -math.cos(a)                    # +x local -> this direction
    return [(x * dx - y * dy, x * dy + y * dx) for x, y in pts]

class Leg:
    """One leg as a circuit trace (straight, a 45-degree jog past the gear, straight to a
    pad): a clock hand, or a resting leg."""
    def __init__(self, length, width, pad, at=48, jog=10, side=1, body=TEAL, tip=PAD):
        self.width = width
        self.path = trace_path(length, at, jog, side)
        self.poly = vectorio.Polygon(pixel_shader=_pal(body), points=[(0, 0), (1, 0), (1, 1)], x=W_CX, y=W_CY)
        self.ring = vectorio.Circle(pixel_shader=_pal(body), radius=pad + 3, x=W_CX, y=W_CY)
        self.pad = vectorio.Circle(pixel_shader=_pal(tip), radius=pad, x=W_CX, y=W_CY)
        for e in (self.poly, self.ring, self.pad):
            watch_grp.append(e)
    def point(self, frac):                            # frac 0..1 round the dial, 0 = 12
        path = place(self.path, frac)
        self.poly.points = [(int(x), int(y)) for x, y in thick(path, self.width)]
        tx, ty = path[-1]
        self.ring.x = self.pad.x = W_CX + int(tx)
        self.ring.y = self.pad.y = W_CY + int(ty)

# The other five legs rest, dimmed, fanned up-left like the logo: 8 legs = a byte.
for f, ln, at, jg, sd in ((0.64, 76, 46, 9, 1), (0.70, 68, 52, 7, -1), (0.76, 78, 46, 10, 1),
                          (0.82, 70, 52, 7, -1), (0.88, 76, 46, 9, 1)):
    Leg(ln, 5, 4, at, jg, sd, body=0x4A2478, tip=0x9C78C8).point(f)
leg_h = Leg(68, 9, 6, 48, 9, 1)
leg_m = Leg(84, 6, 5, 50, 10, -1)
leg_s = Leg(90, 3, 3, 54, 8, 1)
gear = []                                             # 12-tooth gear outline
for i in range(12):
    a = i * 30
    for da, rr in ((-12, 34), (-7, 42), (7, 42), (12, 34)):
        b = math.radians(a + da)
        gear.append((int(rr * math.sin(b)), int(-rr * math.cos(b))))
watch_grp.append(vectorio.Polygon(pixel_shader=_pal(TEAL), points=gear, x=W_CX, y=W_CY))
watch_grp.append(vectorio.Circle(pixel_shader=_pal(PAD), radius=23, x=W_CX, y=W_CY))
w_pupil = vectorio.Circle(pixel_shader=_pal(NAVY), radius=12, x=W_CX, y=W_CY)
watch_grp.append(w_pupil)
w_date = make_text(14, 6, 2, TEAL)
w_mode = make_text(10, 240 - 4 - 10 * 6, 2, TEAL)
w_time = make_text(8, 120 - 8 * 6, 211, PAD, scale=2)   # clear of the 6 o'clock pad
for t_ in (w_date, w_mode, w_time):
    watch_grp.append(t_[0])
watch_grp.hidden = True
root.append(watch_grp)
DAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
w_last = -1

def watch_update(force=False):
    """Redraw the hands once a second."""
    global w_last
    tm = time.localtime()
    if tm.tm_sec == w_last and not force:
        return
    w_last = tm.tm_sec
    synced = tm.tm_year >= 2025
    h, mi, sec = (tm.tm_hour, tm.tm_min, tm.tm_sec) if synced else (10, 10, 0)
    leg_h.point(((h % 12) + mi / 60) / 12)
    leg_m.point((mi + sec / 60) / 60)
    leg_s.point(sec / 60)
    a = sec / 60 * 2 * math.pi                         # the eye follows the second hand
    w_pupil.x, w_pupil.y = W_CX + int(7 * math.sin(a)), W_CY - int(7 * math.cos(a))
    if synced:
        set_text(w_date[1], "{} {:02d} {}".format(DAYS[tm.tm_wday], tm.tm_mday, MONTHS[tm.tm_mon - 1]))
        set_text(w_time[1], "{:02d}:{:02d}:{:02d}".format(tm.tm_hour, tm.tm_min, tm.tm_sec))
    else:
        set_text(w_date[1], "NO TIME")
        set_text(w_time[1], "SYNC  ME")
    set_text(w_mode[1], "RIG DARK")

root.remove(icon)           # Octlet sits on top of every screen
root.append(icon)
root.append(swarm)          # swarm crawls over whatever screen is up

# scan swatch: a big color square with a label, shown only while scanning
sw_bmp = displayio.Bitmap(1, 1, 1)
sw_pal = displayio.Palette(1)
sw_pal[0] = 0x000000
swatch = displayio.Group()
sw_tile = displayio.TileGrid(sw_bmp, pixel_shader=sw_pal)
sw_box = displayio.Group(scale=120, x=60, y=50)
sw_box.append(sw_tile)
swatch.append(sw_box)
sw_text = make_text(9, 66, 180, 0xFFFFFF, scale=2)
set_text(sw_text[1], "SCANNING")
swatch.append(sw_text[0])
swatch.hidden = True
root.append(swatch)

# ---------- link to the rebreather (BLE central -> Bluefruit UART) ----------
# imported after the sprites load: BLE eats RAM the 32 KB sprite sheet needs
gc.collect()
from adafruit_ble import BLERadio
from adafruit_ble.advertising.standard import ProvideServicesAdvertisement
from adafruit_ble.services.nordic import UARTService

ble = BLERadio()
ble.name = "RIG-CLUE"
SIDES = ("L", "R")
links = {s: None for s in SIDES}   # side -> (connection, Bluefruit's UART); we are central
next_scan = 0.0
phone = UARTService()    # our UART for the phone (we are peripheral); its 512-byte buffer holds a whole picture
phone_adv = ProvideServicesAdvertisement(phone)
phone_up = False
next_adv = 0.0
phone_buf = b""
last_rep = {}
SCAN_EVERY = 4.0          # seconds between short scans while disconnected

def send(data):
    """Both intakes get every command."""
    for s in SIDES:
        if links[s]:
            try:
                links[s][1].write(data)
            except Exception:
                links[s] = None

def side_up(s):
    return bool(links[s] and links[s][0].connected)

def adv_side(adv):
    """RB-L / RB-R by name; an unnamed UART (old single-mask firmware) counts as left."""
    name = adv.complete_name or ""
    if name.startswith("RB-"):
        return name[3:4]
    return "L"

def link_step(now):
    """Keep both BLE links up without stalling the display for long."""
    global next_scan
    for s in SIDES:
        if links[s] and not side_up(s):
            links[s] = None
            if power == "on":
                term_push("> LINK LOST // rebreather " + s, RED)
    if side_up("L") and side_up("R"):
        return
    if now < next_scan:
        return
    next_scan = now + SCAN_EVERY
    try:
        for adv in ble.start_scan(ProvideServicesAdvertisement, timeout=0.3):
            if UARTService not in adv.services:
                continue
            s = adv_side(adv)
            if s not in SIDES or links[s]:
                continue
            ble.stop_scan()
            conn = ble.connect(adv, timeout=3)
            links[s] = (conn, conn[UARTService])
            if power == "on":
                term_push("> LINK OK // rebreather " + s, CYAN)
            for k, v in tunes.items():         # the mask forgets on restart
                send(b"Z" + k.encode() + v)
            send(b"Q" + (b"\x01" if muted else b"\x00"))
            resend()
            break                               # the other side on the next scan
        ble.stop_scan()
    except Exception:
        pass

# ---------- phone link (peripheral) ----------
def phone_step(now):
    """Advertise for the phone when it isn't connected; notice it (dis)connecting."""
    global phone_up, next_adv
    up = len(ble.connections) > side_up("L") + side_up("R")
    if up != phone_up:
        phone_up = up
        if power == "on":
            term_push("> PHONE LINKED" if up else "> PHONE DROPPED", CYAN)
        if up:
            last_rep.clear()               # send the phone everything
        next_adv = 0.0
    if not up and now > next_adv:
        next_adv = now + 5.0
        try:                               # replace CircuitPython's own CIRCUITPYxxxx ad
            ble.stop_advertising()
        except Exception:
            pass
        try:
            ble.start_advertising(phone_adv)
        except Exception:
            pass

def phone_say(line):
    if phone_up:
        try:
            phone.write(line.encode() + b"\n")
        except Exception:
            pass

def report():
    """Send the phone whatever changed since the last report."""
    if not phone_up:
        return
    st = (
        ("M", "{} {}".format(cur_set, idx[cur_set])),
        ("C", " ".join(str(v) for v in pair[0] + pair[1])),
        ("P", power),
        ("V", "1" if mode != "idle" else "0"),
        ("L", "{} {}".format(int(side_up("L")), int(side_up("R")))),
        ("R", "{} {} {}".format(*rb)),
        ("T", "{} {}".format(*hack_range)),
    )
    for k, v in st:
        if last_rep.get(k) != v:
            last_rep[k] = v
            phone_say(k + " " + v)

def phone_read():
    global phone_buf
    if not phone_up:
        return
    try:
        n = phone.in_waiting
        if n:
            phone_buf += phone.read(n)
    except Exception:
        return
    while b"\n" in phone_buf:
        line, phone_buf = phone_buf.split(b"\n", 1)
        try:
            phone_cmd(line.decode().strip().split())
        except Exception:
            phone_say("E bad")
        report()                           # answer at once, don't wait for the timer
    if len(phone_buf) > 128:           # junk without newlines: drop it
        phone_buf = b""

def phone_cmd(w):
    if not w:
        return
    c = w[0]
    if c == "?":
        last_rep.clear()
    elif c == "Q":                         # mute works asleep too
        set_mute(w[1] == "1")
    elif c == "J":                         # picture palette (data lines: never refused)
        for i, v in enumerate(w[2:]):
            pic_pal[int(w[1]) + i] = int(v, 16)
    elif c == "I":                         # one row of the picture
        r, row = int(w[1]), w[2]
        for x in range(16):
            pic_bmp[x, r] = int(row[x], 16)
    elif c == "P":
        if w[1] in ("standby", "off") and power in ("on", "waking"):
            go_standby()
        if w[1] == "off" and power == "blink":
            shut_down()
        elif w[1] == "wake" and power in ("blink", "off"):
            go_waking()
    elif power != "on":
        phone_say("E asleep")
    elif c == "N":                         # calls get through even while hacked
        if w[1] in ALERT_TIME:
            alert(w[1], " ".join(w[2:]))
    elif c == "Y":                         # a picture or a word: gets through while hacked
        start_show(w)
    elif c == "K":
        if mode != "idle":
            term_push("> REMOTE PURGE // phone", CYAN)
            go_idle()
            term_push("> purge complete. octlet.exe contained", CYAN)
    elif mode != "idle":
        denied()                           # hacked: same lockout as the buttons
        phone_say("E locked")
    elif c == "H":
        hijack()
    elif c == "M":
        st, i = w[1], int(w[2]) % len(SETS[w[1]])
        idx[st] = i
        change(new_set=st if st != cur_set else None)
    elif c == "W":                         # phone time: y mo d h mi s wd(0 = Monday)
        v = [int(x) for x in w[1:8]]
        rtc.RTC().datetime = time.struct_time((v[0], v[1], v[2], v[3], v[4], v[5], v[6], -1, -1))
        if cur()[3] == "watch":
            watch_update(force=True)
    elif c == "S":
        v = bytes([max(0, min(100, int(w[2])))] + [max(0, min(255, int(x))) for x in w[3:9]])
        if len(v) == 7 and len(w[1]) == 1:
            tunes[w[1]] = v
            save_tunes()
            send(b"Z" + w[1].encode() + v)
            if mode == "idle":
                apply_theme()                  # CLUE screen picks up the new colour
    elif c == "T":
        lo = max(0, min(3600, int(w[1])))
        hi = max(lo, min(3600, int(w[2])))
        hack_range[0], hack_range[1] = lo, hi
        schedule_hack()                    # new timing counts from now
    elif c == "R":
        rb[0] = max(5, min(250, int(w[1])))
        rb[1] = max(5, min(200, int(w[2])))
        rb[2] = 1 if int(w[3]) else 0
        send(b"S" + bytes(rb))             # mask keeps the settings for when it rainbows
    elif c == "C":
        v = [max(0, min(255, int(x))) for x in w[1:7]]
        pair[0], pair[1] = tuple(v[:3]), tuple(v[3:])
        if cur_set == "alt" and idx["alt"] == BREATHE_IDX:
            br_label()
            resend()
        else:
            idx["alt"] = BREATHE_IDX
            change(new_set="alt")

def spawn(i):
    m = SW[i]
    side = random.randrange(4)
    m[1], m[2] = [(random.uniform(0, 104), -16), (120, random.uniform(0, 104)),
                  (random.uniform(0, 104), 120), (-16, random.uniform(0, 104))][side]
    m[3], m[4] = random.uniform(-1.5, 1.5), random.uniform(-1.5, 1.5)
    m[3] += (52 - m[1]) * 0.02
    m[4] += (52 - m[2]) * 0.02
    m[0].hidden = False

def swarm_step(target=None, t=0):
    for m in SW:
        if m[0].hidden:
            continue
        if target:   # dive toward a point
            m[3] += (target[0] - m[1]) * 0.08
            m[4] += (target[1] - m[2]) * 0.08
            m[3] *= 0.7
            m[4] *= 0.7
        else:        # wander over the text, slide with tilt, bounce in the box
            m[3] += random.uniform(-0.4, 0.4) + tilt[0] * TILT_X
            m[4] += random.uniform(-0.4, 0.4) + tilt[1] * TILT_Y
            m[3] = max(-3, min(3, m[3]))
            m[4] = max(-3, min(3, m[4]))
            if (m[1] < 0 and m[3] < 0) or (m[1] > 104 and m[3] > 0): m[3] = -m[3] * 0.6
            if (m[2] < 0 and m[4] < 0) or (m[2] > 104 and m[4] > 0): m[4] = -m[4] * 0.6
        m[1] += m[3]
        m[2] += m[4]
        m[0].x, m[0].y = int(m[1]), int(m[2])
        m[0][0] = (t // 2) & 1

def swarm_hide():
    for m in SW:
        m[0].hidden = True

# ---------- state ----------
mode = "idle"             # animation state: idle / infect / spread / dive / takeover
power = "on"              # on / waking (white, then DARK) / blink (standby) / off
power_t = 0.0
t = 0
phase_t = 0.0
infect_t = 0.0
startle_until = 0.0
hack_range = [180, 300]   # seconds between random hijacks (3-5 min); [0, 0] = off. Phone: T
next_hack = 0.0
scanning = False
scan_rgb = (0, 0, 0)
picking = 0               # 0 = off, 1 / 2 = which rebreather color the picker sets
preview_t = 0.0
locked = None             # scanned color shown on the whole rig until A/B or pad 1
p0_since = None
p0_done = False
last_count = -1
p1_prev = p2_prev = False
held = [False, False]     # buttons A, B down right now
pending = None            # (button, time): a press waiting to see if the other joins it
CHORD = 0.2               # seconds both buttons count as pressed together

# ---------- alerts: incoming call / message (phone N) ----------
# The mask's leds.py SOUNDS, all of them in one speaker: (start s, step s, notes Hz),
# 0 = rest. m = harmonic chirps (up the harmonic series of C5), c = synth ringtone
# in A phrygian, a = the takeover alarm (whoop, hi-lo "danger danger", whoop).
H3, H4, H5, H6, H8 = 1569, 2093, 2616, 3139, 4186
A4, BB4, A5, BB5, C6, D6, E6, A6 = 440, 466, 880, 932, 1047, 1175, 1319, 1760
D5, E5, F5 = 587, 659, 698
RINGTONE = (A5, A4, A5, C6, BB5, A5, E5, 0, A5, A4, A5, C6, E6, D6, C6, BB5,
            A5, A4, A5, C6, BB5, A5, E5, 0, F5, E5, D5, E5, A5, 0, A6, 0)
WHOOP = tuple(400 + 80 * i for i in range(16))
SOUNDS = {
    "m": ((0.0, 0.025, (H3, H4, H5, H6)), (0.14, 0.025, (H4, H5, H6, H8)),
          (0.28, 0.04, (H6, H8, H6, H8))),
    "c": ((0.0, 0.07, RINGTONE), (2.8, 0.07, RINGTONE)),
    "a": ((0.0, 0.03, WHOOP), (0.55, 0.15, (1568, 1046) * 4), (1.85, 0.03, WHOOP)),
    "g": ((0.0, 0.04, tuple(300 + 5 * i for i in range(30))),),     # /boo: a rising wooo
    "p": ((0.0, 0.12, (A4, 523, E5, 622, 523, A4, 0, 330)),),     # /pumpkin: spooky arpeggio
    # /vamp: the opening of Bach's Toccata and Fugue in D minor (public domain)
    "v": ((0.0, 0.12, (A5, 784, A5, 0, 784, F5, E5, D5, 554, D5)),),
    # /frank: an electric zap, buzzing between a high and a low tone
    "k": ((0.0, 0.02, tuple((1800 if i % 2 else 300) + 37 * (i % 7) for i in range(40))),),
    # unknown command: an error boop-boop, falling
    "e": ((0.0, 0.12, (523, 0, 392)),),
    # censored: the TV bleep
    "b": ((0.0, 0.8, (1000,)),),
    # /middle: a buzzing raspberry, sagging down
    "u": ((0.0, 0.03, tuple(220 - 3 * i + (25 if i % 2 else 0) for i in range(30))),),
    # /fish: three runs of bubbles
    "f": ((0.0, 0.03, tuple(500 + 60 * i for i in range(10))),
          (0.45, 0.03, tuple(700 + 60 * i for i in range(10))),
          (0.9, 0.03, tuple(600 + 80 * i for i in range(10)))),
}
ALERT_TIME = {"m": 1.0, "c": 5.2}
speaker = pwmio.PWMOut(board.SPEAKER, frequency=2000, duty_cycle=0, variable_frequency=True)
tone_segs = None
tone_t = 0.0
alert_k = None
alert_end = 0.0

muted = False             # phone Q: silences the CLUE and the mask (lights still run)

def play(k):
    global tone_segs, tone_t
    if not muted:
        tone_segs, tone_t = SOUNDS[k], time.monotonic()

def set_mute(on):
    global muted, tone_segs
    muted = on
    if on:
        tone_segs = None
    send(b"Q" + (b"\x01" if on else b"\x00"))

def tone_step(now):
    """Play the next phrase once its time comes (called every loop). The notes are
    shorter than one loop, so each phrase plays straight through, the screen
    pulsing to the beat meanwhile."""
    global tone_segs
    if not tone_segs or now - tone_t < tone_segs[0][0]:
        return
    _, step, notes = tone_segs[0]
    for i, hz in enumerate(notes):
        if hz:
            speaker.frequency = hz
        speaker.duty_cycle = 0x8000 if hz else 0
        if step >= 0.07:
            display.brightness = 1.0 if i % 4 < 2 else 0.4
        time.sleep(step)
    speaker.duty_cycle = 0
    display.brightness = 1.0
    tone_segs = tone_segs[1:] or None

def alert(k, text):
    """Incoming call / message: lights + sound on the mask, sound on the CLUE too."""
    global alert_k, alert_end
    send(b"N" + k.encode() + b"\x01")
    play(k)
    alert_k, alert_end = k, time.monotonic() + ALERT_TIME[k]
    text = text[:T_COLS - 20]
    if k == "c":
        term_push("!! INCOMING CALL", CYAN)
        term_push("> CALLER ID // " + (text or "0x{:04X}".format(random.randrange(65536))), CYAN)
    else:
        term_push("> MSG // " + (text or "1 new packet"), CYAN)

# ---------- pictures + words from the phone (Y, with J / I for the picture) ----------
# The phone owns the picture library: it sends a 16x16, 16-colour picture as text
# (J palette, I rows) and then Y to show it, so pictures cost the CLUE no code or RAM
# beyond this one bitmap. Typed words that aren't pictures come as Y t: big text.
#   J start rrggbb ...       palette entries from `start` (up to 8 a line); 0 = background
#   I row hhhhhhhhhhhhhhhh   one row of the picture, a hex digit per pixel
#   Y p|t mask snd rrggbb title caption...
#        p = the picture under the caption, t = the caption as big text
#        mask = mode byte for the Bluefruits meanwhile (- none), snd = SOUNDS key (- none)
#        title = shown first for SHOW_TITLE s (- none), e.g. /PUMPKIN
SHOW_TIME = {"p": 20.0, "t": 10.0}   # long enough to outlast the hat's 3-7 s upload
SHOW_TITLE = 2.0
PIC_SCALE = 11                      # 16 px -> 176 px
pic_bmp = displayio.Bitmap(16, 16, 16)
pic_pal = displayio.Palette(16)
show_bg = displayio.Palette(1)
show_bg[0] = 0
show = displayio.Group()
show.append(vectorio.Rectangle(pixel_shader=show_bg, width=240, height=240, x=0, y=0))
pic_grp = displayio.Group(scale=PIC_SCALE, x=(240 - 16 * PIC_SCALE) // 2, y=38)
pic_grp.append(displayio.TileGrid(pic_bmp, pixel_shader=pic_pal))
show.append(pic_grp)
show_cap = make_text(20, 0, 4, 0xFFFFFF, scale=2)          # caption / title, top line
show.append(show_cap[0])
big = [make_text(12, 12, y, 0xFFFFFF, scale=3) for y in (80, 130)]   # text mode: 2 lines
for b in big:
    show.append(b[0])
show.hidden = True
root.append(show)
show_k = None             # "p" / "t" while something shows
show_end = 0.0
show_cap_at = 0.0         # when the title gives way to the caption (0 = no title)
show_caption = ""

def wrap(s, n=12):
    """Up to two lines of n characters, broken at spaces where it can."""
    lines, cur = [], ""
    for word in s.split():
        while len(word) > n:
            lines.append(word[:n])
            word = word[n:]
        if cur and len(cur) + 1 + len(word) > n:
            lines.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    lines.append(cur)
    return (lines + ["", ""])[:2]

def start_show(w):
    global show_k, show_end, show_cap_at, show_caption
    k, mask, snd, color = w[1], w[2], w[3], int(w[4], 16)
    title, caption = w[5], " ".join(w[6:])
    show_k, show_caption = k, caption
    show_end = time.monotonic() + SHOW_TIME.get(k, 10.0)
    show_cap_at = time.monotonic() + SHOW_TITLE if title != "-" else 0.0
    pic_grp.hidden = k != "p"
    for b, line in zip(big, wrap(caption) if k == "t" else ("", "")):
        b[2][1] = color
        set_text(b[1], "{:^12}".format(line))
    show_cap[2][1] = color
    top = title if title != "-" else (caption if k == "p" else "")
    set_text(show_cap[1], "{:^20}".format(top[:20]))
    show.hidden = False
    if mask != "-":
        send(mask.encode())
    if snd in SOUNDS:
        play(snd)

def show_step(now):
    global show_k, show_cap_at
    if not show_k:
        return
    if show_cap_at and now > show_cap_at:      # the /command has had its moment
        show_cap_at = 0.0
        set_text(show_cap[1], "{:^20}".format(show_caption[:20] if show_k == "p" else ""))
    if now > show_end:
        show_k = None
        show.hidden = True
        resend()
    elif show_k == "p":                        # the picture bobs gently
        pic_grp.y = 38 + int(4 * math.sin(now * 2.2))

def wheel(h):
    """0..1 hue -> saturated 0xRRGGBB."""
    h = (h % 1.0) * 6
    i, f = int(h), h - int(h)
    q, u = int(255 * (1 - f)), int(255 * f)
    r, g, b = ((255, u, 0), (q, 255, 0), (0, 255, u),
               (0, q, 255), (u, 0, 255), (255, 0, q))[i]
    return (r << 16) | (g << 8) | b

def text_color():
    if locked:
        return rgb_int(locked)
    c = cur()[2]
    if c is None:
        return wheel(time.monotonic() * 0.2)
    tn = tunes.get(cur()[0].decode()) if cur()[0] else None
    return rgb_int(tn[1:4]) if tn and cur()[0] != b"A" else c   # tuned main colour themes the CLUE

def apply_theme():
    """Recolor terminal + Octlet for the current mode or the locked scan color."""
    color = text_color()
    term_color(color)
    tint(color)

def show_screen():
    scr = cur()[3]
    term.hidden = scr != "term"
    icon.hidden = scr in ("breathe", "watch", "heart")
    watch_grp.hidden = scr != "watch"
    heart_grp.hidden = scr != "heart"
    if scr == "heart":
        heart_pal[0] = bpm_txt[2][1] = text_color()     # tuned pulse colour, else red
        set_text(bpm_txt[1], "{} BPM".format(bpm))
    if scr == "watch":
        watch_update(force=True)
    vu_grp.hidden = scr != "vu"
    rb_grp.hidden = scr != "rainbow"
    br_grp.hidden = scr != "breathe"
    if scr == "breathe":
        br_label()
    if scr == "rainbow":
        icon.scale, icon.x, icon.y = 2, 56, 56      # big Octlet in the middle of the wave
    elif scr == "vu":
        icon.scale, icon.x = 1, 88                  # rides the middle bars
    else:
        icon.scale, icon.x, icon.y = 1, 240 - 68, 4

def resend():
    """Tell the rebreather what it should be showing right now."""
    if power in ("blink", "waking"):
        send(b"W")
    elif power == "off":
        send(b"O")
    elif mode == "takeover":
        send(b"F")
    elif locked:
        send(b"C" + bytes(locked))
    elif cur()[0] is None:
        send(b"B" + bytes(pair[0]) + bytes(pair[1]))
    else:
        if cur()[0] == b"R":
            send(b"S" + bytes(rb))     # settings first, so it starts right
        send(cur()[0])

def go_idle():
    global mode
    mode = "idle"
    swarm_hide()
    apply_theme()
    show_screen()
    show_byte((cur()[0] or b"B")[0])
    resend()

def go_virus():
    global mode, phase_t, infect_t
    if cur()[3] != "term":
        return
    mode = "infect"
    phase_t = infect_t = time.monotonic()
    term_push("!! UNKNOWN PROCESS: octlet.exe", RED)
    spawn(0)
    schedule_hack()             # next random hijack counts from this infection

def denied():
    """A control was touched while hacked: refuse it, loudly."""
    term_push("!! INPUT LOCKED // shake or wave", RED)
    term_glitch(2)

def schedule_hack():
    global next_hack
    if not hack_range[1]:
        next_hack = 1e12                   # off: only the HACK mode / phone H start it
    else:
        next_hack = time.monotonic() + random.uniform(hack_range[0], hack_range[1])

def hijack():
    """The virus interjects on its own: from any mode, onto the OS terminal."""
    if cur_set != "os" or cur()[3] != "term":
        if SETS["os"][idx["os"]][3] != "term":
            idx["os"] = 0                  # e.g. HEARTBEAT: the virus needs the terminal
        change(new_set="os")
    term_push("!! INTRUSION DETECTED", RED)
    go_virus()

def close_scanner():
    global scanning, picking
    scanning = False
    picking = 0
    lamp.value = False
    swatch.hidden = True

def mode_line():
    tag = cur()[0].decode() if cur()[0] else "B"
    term_push("> {} // {} [{}]".format("OS" if cur_set == "os" else "ALT",
                                       cur()[1], tag), text_color())
    set_text(vu_text[1], cur()[1])

def change(new_set=None, d=0):
    """Every mode switch goes through here: A/B steps, pad 1 set swaps."""
    global cur_set, locked
    if scanning:
        close_scanner()
    infected = mode != "idle"
    if new_set:
        cur_set = new_set
    idx[cur_set] = (idx[cur_set] + d) % len(SETS[cur_set])
    locked = None
    go_idle()                   # re-themes, picks the screen, sends the mode
    if infected:
        term_push("> purge complete. octlet.exe contained", CYAN)
    if new_set:
        term_push("> {} loaded".format(SET_NAMES[cur_set]), text_color())
    mode_line()
    if cur()[1] == "HACK":
        go_virus()              # the HACK mode is the virus, on demand

def go_standby():
    global power, power_t
    if scanning:
        close_scanner()
    go_idle()
    power, power_t = "blink", time.monotonic()
    send(b"W")                  # rig blinks white, then off
    term.hidden = icon.hidden = False
    vu_grp.hidden = br_grp.hidden = rb_grp.hidden = heart_grp.hidden = True
    icon.scale, icon.x, icon.y = 1, 240 - 68, 4
    term_color(WHITE)
    tint(WHITE)
    term_push("> STANDBY // keep holding 0 = shut down", WHITE)
    term_push("> hold 0 again to wake", WHITE)

def go_waking():
    """Power-up / wake: blink white for a moment, then STEAMWorkz OS // DARK."""
    global power, power_t, cur_set, locked
    schedule_hack()
    if scanning:
        close_scanner()
    swarm_hide()
    power, power_t = "waking", time.monotonic()
    cur_set, idx["os"], locked = "os", 0, None
    term.hidden = icon.hidden = False
    vu_grp.hidden = br_grp.hidden = rb_grp.hidden = heart_grp.hidden = True
    icon.scale, icon.x, icon.y = 1, 240 - 68, 4
    term_color(WHITE)
    tint(WHITE)
    send(b"W")
    term_push("> BOOT // systems coming online", WHITE)

def blink_on(f):
    """Standby blink, period sliding from BLINK_START to BLINK_END over BLINK_TIME.
    Same formula as the rig's W mode, so they slow down together."""
    k = (BLINK_END - BLINK_START) / BLINK_TIME
    return (math.log(1 + k * f / BLINK_START) / k) % 1.0 < 0.5

def shut_down():
    global power
    power = "off"
    send(b"O")
    display.brightness = 0.0

def go_active():
    global power
    power = "on"
    display.brightness = 1.0
    go_idle()                   # DARK: purple on the CLUE and the rig
    term_push("> SYSTEMS ACTIVE", CYAN)
    mode_line()

LOOK = (0, 1, 0, 4, 0, 2, 0, 5)   # idle: wiggle + look around
REACH = (6, 7, 3, 7)              # takeover: hunting

def splash():
    set_mode("brand")
    icon.scale, icon.x, icon.y = 3, 24, 24
    time.sleep(1.5)
    term_push("> STEAMWORKZ CYBERWARE v2.0.77", CYAN)

gc.collect()
print("rig ready, free RAM:", gc.mem_free(), "accel:", ["%.1f" % v for v in accel()])
splash()
go_waking()

while True:
    now = time.monotonic()
    t += 1

    tone_step(now)
    if t % 4 == 0:
        link_step(now)
        phone_step(now)
    phone_read()
    if t % 5 == 0:
        report()

    # pad 0 held 5 s: ACTIVE <-> STANDBY (once per hold)
    if power_pad.value:
        if p0_since is None:
            p0_since = now
        elif not p0_done and now - p0_since > HOLD_TIME:
            p0_done = True
            if power in ("on", "waking"):
                go_standby()
            else:
                go_waking()
        elif power == "blink" and now - p0_since > 2 * HOLD_TIME:
            shut_down()             # kept holding through standby: off now
    else:
        p0_since, p0_done = None, False

    # buttons: A = next, B = previous, A + B together = switch set (like pad 1).
    # A press waits CHORD s to see if the other joins it. Ignored in standby so
    # bumps don't wake it.
    ev = keys.events.get()
    while ev:
        k = ev.key_number
        held[k] = ev.pressed
        if ev.pressed and power == "on":
            if held[1 - k]:
                pending = None
                if mode != "idle":
                    denied()
                else:
                    change(new_set="alt" if cur_set == "os" else "os")
            else:
                pending = (k, now)
        ev = keys.events.get()
    if pending and now - pending[1] > CHORD:
        k, pending = pending[0], None
        if power == "on":
            if mode != "idle":
                denied()
            else:
                change(d=1 if k == 0 else -1)

    if power == "waking":
        display.brightness = 1.0 if (now - power_t) % 0.5 < 0.25 else 0.15
        if now - power_t > WAKE_TIME:
            go_active()
        time.sleep(0.05)
        continue
    if power != "on":
        if power == "blink":
            f = now - power_t
            display.brightness = 1.0 if blink_on(f) else 0.15
            left = int(BLINK_TIME - f)
            if left % 15 == 0 and left != last_count and left > 0:
                last_count = left
                term_push("> shutdown in {} s".format(left), WHITE)
            if f > BLINK_TIME:
                shut_down()
        time.sleep(0.05)
        continue

    # alert: the screen flashes with it (fast for a message, with the rings for a call)
    if alert_k:
        if now < alert_end:
            f = now - (alert_end - ALERT_TIME[alert_k])
            on = (f % 2.8 < 2.24 and f % 0.3 < 0.15) if alert_k == "c" else f % 0.14 < 0.07
            display.brightness = 1.0 if on else 0.35
        else:
            alert_k = None
            display.brightness = 1.0
    show_step(now)

    # pad 1 tap: STEAMWorkz OS <-> ALT
    p1 = set_pad.value
    if p1 and not p1_prev:
        if mode != "idle":
            denied()
        else:
            change(new_set="alt" if cur_set == "os" else "os")
    p1_prev = p1

    scr = cur()[3]

    # hand toward the sensor: Octlet startles, and the virus may take its chance
    waved = hand_approached()
    if waved and mode == "idle" and scr == "term":
        if cur()[1] == "HACK":
            go_virus()                     # wave to set it off again
        else:
            startle_until = now + 0.8
            term_push("> proximity alert: something is watching", CYAN)

    # random hijack every 3-5 min, unless something's already going on
    if now > next_hack and mode == "idle" and not picking:
        hijack()

    # motion feeds the swarm; shake / snap-clap / hand held over = cure
    ax, ay, az = accel()
    tilt = (ax, ay)
    if mode != "idle" and now - infect_t > GRACE:
        cure = None
        if math.sqrt(ax * ax + ay * ay + az * az) > SHAKE:
            cure = "SHAKE"
        elif waved:
            cure = "HAND WAVE"
        elif near and near_since > infect_t and now - near_since > HOLD:
            cure = "HAND SIGNATURE"
        if cure:
            term_push("> {} detected // purging".format(cure), CYAN)
            go_idle()
            term_push("> purge complete. octlet.exe contained", CYAN)

    # pad 2: REBREATHER color pickers. tap = picker 1, tap = lock 1 + picker 2,
    # tap = lock 2 and breathe between them
    p2 = scan_pad.value
    if p2 and not p2_prev and mode != "idle":
        denied()
    elif p2 and not p2_prev:
        if not picking:
            if not (cur_set == "alt" and idx["alt"] == BREATHE_IDX):
                idx["alt"] = BREATHE_IDX
                change(new_set="alt")
            picking, scanning, scan_rgb = 1, True, (0, 0, 0)
            lamp.value = True
            swatch.hidden = False
        elif picking:
            if any(scan_rgb):
                pair[picking - 1] = scan_rgb
            if picking == 1:
                picking, scan_rgb = 2, (0, 0, 0)
            else:
                close_scanner()
                br_label()
            resend()
    p2_prev = p2
    if scanning:
        rgb = read_color()
        if rgb:
            scan_rgb = rgb
            sw_pal[0] = rgb_int(rgb)
            set_text(sw_text[1], "{}:#{:02X}{:02X}{:02X}".format(picking, *rgb))
            if now - preview_t > 0.4:          # rig previews the color being picked
                preview_t = now
                live = [pair[0], pair[1]]
                live[picking - 1] = rgb
                send(b"B" + bytes(live[0]) + bytes(live[1]))

    el = now - phase_t

    if mode == "idle":
        if scr == "vu":
            vu_draw(vu_level())
            # surf: sway side to side across the meter, riding the bar heights under it
            sx = 88 + 84 * math.sin(now * SURF_SPEED)
            pos = min(7.0, max(0.0, (sx + 32 - 7.5) / 30))   # bar k is centered at k*30+7.5 px
            k0 = int(pos)
            k1 = min(7, k0 + 1)
            f = pos - k0
            ride = (vu_h[k0] * (1 - f) + vu_h[k1] * f) * 15  # wave height under it, px
            icon.x = int(sx)
            icon.y = int(240 - ride - 52)               # legs dip into the bars
            if t % 3 == 0:                              # look where it's heading, wiggling
                left = math.cos(now * SURF_SPEED) < 0
                octlet[0] = ((4, 1) if left else (5, 2))[(t // 3) % 2]
        elif scr == "watch":
            watch_update()
        elif scr == "rainbow":
            rb_phase += 0.04 * 0.15 * rb[0] / 50 * (1 if rb[2] else -1)
            base = rb_phase
            for i in range(16):
                rb_pal[i] = wheel(base + i / 16 * rb[1] / 30)
            if not locked and t % 2 == 0:
                tint(wheel(base + 0.5))                 # Octlet in the opposite hue
            if t % 3 == 0:
                octlet[0] = LOOK[(t // 3) % len(LOOK)]
        elif scr == "breathe":
            w = 0.5 - 0.5 * math.cos(now * 2 * math.pi / 5.5)   # same 5.5 s as the rig
            a, b = pair
            br_pal[0] = rgb_int([a[k] + (b[k] - a[k]) * w for k in range(3)])
        elif scr == "heart":
            heart_draw(now)
        else:
            if cur()[2] is None and not locked and t % 2 == 0:
                apply_theme()              # rainbow: keep the hue rolling
            if cur()[0] == b"r" and not locked:
                if now < rain_flash:
                    pass                   # lightning: hold the flash color
                elif random.random() < 0.012:
                    rain_flash = now + 0.12
                    term_color(random.choice((MAGENTA, CYAN)))
                elif t % 2 == 0:
                    if rain_flash:         # flash over: drops back to their colors
                        rain_flash = 0.0
                        for r in ROWS:
                            r[2][1] = random.choice(RAIN_COLORS)
                    term_push(drop_line(), random.choice(RAIN_COLORS), down=True)
            elif cur()[0] == b"M" and not locked:
                if t % 3 == 0:
                    term_push(rain_line(), text_color(), down=True)
            elif cur()[0] in MODE_TEXT and not locked:
                lines, every = MODE_TEXT[cur()[0]]
                if cur()[0] == b"o":       # overclock: the more the CLUE moves, the faster
                    ax, ay, az = accel()
                    every = max(1, every - int(abs(math.sqrt(ax * ax + ay * ay + az * az) - 9.8)))
                if t % every == 0:
                    c = random.choice((0xFF1496, CYAN)) if cur()[0] == b"e" else text_color()
                    term_push(fill(random.choice(lines)), c)
            elif t % 6 == 0:
                term_push(fill(random.choice(IDLE_TEXT)), text_color())
            if now < startle_until:
                octlet[0] = 3              # startled
            elif t % 3 == 0:
                octlet[0] = LOOK[(t // 3) % len(LOOK)]

    elif mode == "infect":          # ~2 s: one Octlet slips in, text corrupts
        if t % 4 == 0:
            term_push(fill(random.choice(IDLE_TEXT)), text_color())
        if t % 3 == 0:
            term_glitch(1)
        octlet[0] = 3
        set_mode("hostile")
        swarm_step(t=t)
        if el > 2:
            mode, phase_t = "spread", now

    elif mode == "spread":          # ~3 s: it replicates, one per bit
        n = min(8, 1 + int(el * 2.5))
        for i in range(n):
            if SW[i][0].hidden:
                spawn(i)
                term_push("!! octlet.exe x{}".format(i + 1), RED)
        show_byte((0xFF00 >> n) & 0xFF)   # legs fill up as the swarm grows
        if t % 2 == 0:
            term_glitch(2)
        swarm_step(t=t)
        if el > 3.2:
            mode, phase_t = "dive", now

    elif mode == "dive":            # swarm converges on the center
        swarm_step(target=(52, 52), t=t)
        if el > 0.8:
            for m in SW:            # burst back out to crawl over the text
                m[3], m[4] = random.uniform(-3, 3), random.uniform(-3, 3)
            icon.scale, icon.x, icon.y = 3, 24, 24
            mode, phase_t = "takeover", now
            resend()                # rebreather: hunt sweep + glitch stabs (and its alarm)
            play("a")
            for _ in range(12):
                term_push(fill(random.choice(VIRUS_TEXT)), RED)

    elif mode == "takeover":        # hold: the AI owns the rig until purged
        swarm_step(t=t)
        if t % 2 == 0:
            octlet[0] = REACH[(t // 2) % len(REACH)]
        if t % 3 == 0:
            show_byte(random.randrange(256))   # "exfiltrating" bytes
        if t % 5 == 0:
            term_push(fill(random.choice(VIRUS_TEXT)), RED if t % 10 else MAGENTA)
        if random.random() < 0.08:
            icon.x = 24 + random.randint(-6, 6)  # glitch jitter
        else:
            icon.x = 24

    time.sleep(0.04)
