"""
Pimoroni Pico Plus 2 W + SparkFun Qwiic Motor Driver (SCMD) - vibration / swivel
controller. MicroPython port of the QT Py code.py, plus Bluetooth LE.

Copy this file to the board as main.py (Thonny: File > Save as > Raspberry Pi
Pico). It needs Pimoroni's MicroPython build for the Pico Plus 2 W (or any
RP2350 W build with the 'bluetooth' module). No extra libraries are required.

Control it from:
  * motor_control.html -> "Bluetooth" (no cable to the PC, just power), or
  * motor_control.html -> "USB", or Thonny's shell (type h for the menu).
Both links speak the same commands; the board answers on both.

Wiring
  Pico Plus 2 W Qw/ST port --Qwiic cable--> Qwiic Motor Driver
  Motor driver A1/A2   -> vibration motor 1  (or the swivel motor)
  Motor driver B1/B2   -> vibration motor 2
  Motor driver VIN/GND -> motor supply (3-11 V); ground is shared over Qwiic
  Push button (optional) between BUTTON_PIN and GND
      short press = start / next pattern, long press = switch mode

Modes
  Vibration : two motors, ramping / pulsing patterns. Levels 1-100 are scaled
              into VIBE_MIN..100 so the lowest level is just above stall.
  Swivel    : one motor, fixed speeds only (50-100 %), with a short
              full-power kick on every start to break static friction.
"""
import random
import select
import sys
import time

from machine import I2C, Pin

# ============================ SETTINGS ============================
I2C_ADDR = 0x5D  # default Qwiic Motor Driver address
I2C_ID, I2C_SDA, I2C_SCL = 0, 4, 5  # Qw/ST connector on the Pico Plus 2 W

BLE_NAME = "Motor-Pico"  # the web app lists boards whose name starts "Motor"
STOP_ON_DISCONNECT = True  # stop the motors when the Bluetooth link drops

ECHO_INPUT = False  # show typed keys over USB (True for Mu, False for Thonny)

BUTTON_PIN = 22  # GPIO number, or None if no button is fitted
LONG_PRESS_S = 1.0  # hold this long to switch mode

# --- Vibration mode ---
# Lowest drive % at which each motor reliably spins (find it with the
# "Stall finder" pattern, then set these). Level 0 is always fully off.
VIBE_MIN_A = 25
VIBE_MIN_B = 25
RAMP_STEP_S = 0.02  # ramp smoothness (smaller = smoother)

# --- Swivel mode ---
ROTATE_MOTOR = 0  # 0 = motor A, 1 = motor B
ROTATE_REVERSE = False  # default spin direction (toggle with  r )
ROTATE_LEVELS = (50, 60, 70, 80, 90, 100)  # the only allowed speeds
KICK_PCT = 100  # start-up kick power
KICK_S = 0.15  # start-up kick length (0 = no kick)
DIRECTION_PAUSE_S = 0.4  # rest before reversing direction

# --- Manual mode (controller sticks via the web app) ---
# The web app sends "man<A>,<B>" (-100..100 each) about 20x a second.
# If updates stop (controller or page lost) the motors stop after this long.
MANUAL_TIMEOUT_S = 0.6


# ======================= VIBRATION PATTERNS =======================
# Step: (level_A, level_B, seconds, ramp)
#   level 0-100 (0 = off, 1 = just above stall, 100 = full)
#   ramp=False -> jump to the level and hold for 'seconds'
#   ramp=True  -> glide from the previous level to this one over 'seconds'
# A pattern is a list of steps, or a function returning steps (re-run each
# loop, used for the random ones). Patterns repeat until changed.


def _rumble():
    return [
        (
            random.randint(20, 100),
            random.randint(20, 100),
            random.uniform(0.1, 0.4),
            random.random() < 0.5,
        )
        for _ in range(10)
    ]


def _surge():
    base = random.randint(15, 35)
    return [
        (base, base, random.uniform(1.5, 4.0), True),
        (100, 100, random.uniform(0.3, 0.8), True),
        (base, base, 0.8, True),
    ]


VIBE_PATTERNS = [
    ("Steady", [(100, 100, 1.0, False)]),
    ("Pulse", [(100, 100, 0.25, False), (0, 0, 0.35, False)]),
    ("Flutter (fast pulse)", [(100, 100, 0.08, False), (0, 0, 0.08, False)]),
    ("Wave", [(100, 100, 2.0, True), (10, 10, 2.0, True)]),
    ("Ping-pong wave", [(100, 0, 1.0, True), (0, 100, 1.0, True)]),
    (
        "Rolling (A leads B)",
        [
            (100, 50, 0.8, True),
            (50, 100, 0.8, True),
            (0, 50, 0.8, True),
            (50, 0, 0.8, True),
        ],
    ),
    ("Alternating pulse", [(100, 0, 0.3, False), (0, 100, 0.3, False)]),
    (
        "Heartbeat",
        [
            (70, 70, 0.10, False),
            (0, 0, 0.12, False),
            (100, 100, 0.15, False),
            (0, 0, 0.70, False),
        ],
    ),
    (
        "Escalate (staircase)",
        [
            (20, 20, 2.0, False),
            (35, 35, 2.0, False),
            (50, 50, 2.0, False),
            (65, 65, 2.0, False),
            (80, 80, 2.0, False),
            (100, 100, 3.0, False),
            (0, 0, 2.0, False),
        ],
    ),
    (
        "Tease (build, drop, bursts)",
        [
            (60, 60, 4.0, True),
            (0, 0, 0.6, False),
            (100, 100, 0.3, False),
            (0, 0, 0.5, False),
            (100, 100, 0.3, False),
            (0, 0, 1.5, False),
        ],
    ),
    ("Surge (random)", _surge),
    ("Rumble (random)", _rumble),
    ("Stall finder (calibration)", None),  # special: see run_stall_finder()
]


# ======================== SWIVEL PATTERNS =========================
# Step: (percent, on_seconds, off_seconds[, direction])
#   percent is snapped to the nearest ROTATE_LEVELS value
#   off_seconds = 0 keeps the motor running into the next step (no re-kick)
#   direction  1 = normal, -1 = reversed (motor stops briefly before flipping)


def _swivel_random():
    return [
        (
            random.choice(ROTATE_LEVELS),
            random.uniform(2.0, 6.0),
            random.uniform(0.5, 3.0),
            random.choice((1, -1)),
        )
    ]


SWIVEL_PATTERNS = [
    ("Slow cycle   70%  5s on / 3s off", [(70, 5.0, 3.0)]),
    ("Tease        50%  3s on / 2s off", [(50, 3.0, 2.0)]),
    ("Burst       100%  1.5s on / 1.5s off", [(100, 1.5, 1.5)]),
    (
        "Build 50 -> 100%, then rest",
        [
            (50, 4.0, 0),
            (60, 4.0, 0),
            (70, 4.0, 0),
            (80, 4.0, 0),
            (90, 4.0, 0),
            (100, 4.0, 4.0),
        ],
    ),
    ("Speed wave   60% <-> 90%", [(60, 4.0, 0), (90, 4.0, 0)]),
    ("Back & forth 70%  4s each way", [(70, 4.0, 0, 1), (70, 4.0, 0, -1)]),
    ("Random speed / time / direction", _swivel_random),
]


# ============================== CLOCK =============================
# time.monotonic() equivalent. ticks_ms() wraps, so accumulate the deltas
# (the main loop calls this every few ms, far inside the wrap period).
_clock_ms = 0
_clock_last = time.ticks_ms()


def monotonic():
    global _clock_ms, _clock_last
    t = time.ticks_ms()
    _clock_ms += time.ticks_diff(t, _clock_last)
    _clock_last = t
    return _clock_ms / 1000


# ============================ BLUETOOTH ===========================
# Nordic UART Service: the web app writes commands to RX and gets the
# board's output as notifications on TX - the same text as over USB.
_NUS = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
_NUS_RX = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
_NUS_TX = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
_IRQ_CONNECT, _IRQ_DISCONNECT, _IRQ_WRITE, _IRQ_MTU = 1, 2, 3, 21


class BleUart:
    def __init__(self, name):
        import bluetooth

        self.rx_buf = bytearray()
        self.conn = None
        self.chunk = 20  # notification payload; grows if the central raises the MTU
        self.dropped = False  # set on disconnect, read by poll_inputs()
        self.ble = bluetooth.BLE()
        self.ble.active(True)
        try:
            self.ble.config(gap_name=name, mtu=247)
        except (ValueError, OSError):
            pass
        uart = (
            bluetooth.UUID(_NUS),
            (
                (bluetooth.UUID(_NUS_TX), 0x0002 | 0x0010),  # read | notify
                (bluetooth.UUID(_NUS_RX), 0x0004 | 0x0008),  # write (no response) | write
            ),
        )
        ((self.tx, self.rx),) = self.ble.gatts_register_services((uart,))
        self.ble.gatts_set_buffer(self.rx, 128, True)
        self.ble.irq(self._irq)
        n = name.encode()
        self._adv = bytes((2, 0x01, 0x06, len(n) + 1, 0x09)) + n
        self._resp = bytes((17, 0x07)) + bytes(bluetooth.UUID(_NUS))
        self.advertise()

    def advertise(self):
        self.ble.gap_advertise(100_000, adv_data=self._adv, resp_data=self._resp)

    def _irq(self, event, data):
        if event == _IRQ_CONNECT:
            self.conn = data[0]
            self.chunk = 20
        elif event == _IRQ_DISCONNECT:
            self.conn = None
            self.dropped = True
            self.advertise()
        elif event == _IRQ_WRITE:
            if data[1] == self.rx:
                self.rx_buf += self.ble.gatts_read(self.rx)
        elif event == _IRQ_MTU:
            self.chunk = max(20, min(240, data[1] - 3))

    def read_all(self):
        data, self.rx_buf = self.rx_buf, bytearray()
        return data

    def write(self, text):
        if self.conn is None:
            return
        data = text.encode()
        for i in range(0, len(data), self.chunk):
            for _ in range(20):  # the radio's queue can be briefly full
                try:
                    self.ble.gatts_notify(self.conn, self.tx, data[i:i + self.chunk])
                    break
                except OSError:
                    if self.conn is None:
                        return
                    time.sleep_ms(5)


ble = None


def out(text=""):
    """print() to USB and to the Bluetooth link."""
    print(text)
    if ble:
        ble.write(text + "\n")


# ========================= MOTOR DRIVER ===========================
class SCMD:
    """Minimal register-level driver for the SparkFun Qwiic Motor Driver."""

    REG_ID = 0x01
    ID_VALUE = 0xA9
    REG_MA_DRIVE = 0x20  # motor B is 0x21
    REG_DRIVER_ENABLE = 0x70
    REG_STATUS_1 = 0x77
    ENUM_DONE = 0x01

    def __init__(self, i2c, addr=I2C_ADDR, timeout=3.0):
        self.i2c = i2c
        self.addr = addr
        self.raw = [128, 128]  # last value written to each motor
        deadline = monotonic() + timeout
        while True:
            try:
                if (
                    self._read(self.REG_ID) == self.ID_VALUE
                    and self._read(self.REG_STATUS_1) & self.ENUM_DONE
                ):
                    break
            except OSError:
                pass
            if monotonic() > deadline:
                raise RuntimeError("Qwiic Motor Driver not found at 0x%02X" % addr)
            time.sleep(0.05)
        self.stop()
        self._write(self.REG_DRIVER_ENABLE, 0x01)

    def _write(self, reg, value):
        for attempt in range(3):  # retry so a bus glitch can't swallow a stop
            try:
                self.i2c.writeto(self.addr, bytes((reg, value)))
                return
            except OSError:
                if attempt == 2:
                    raise

    def _read(self, reg):
        return self.i2c.readfrom_mem(self.addr, reg, 1)[0]

    def ensure_enabled(self):
        """Re-enable the outputs if the driver has reset (e.g. a power dip)."""
        if not self._read(self.REG_DRIVER_ENABLE) & 0x01:
            out("WARNING motor driver had reset (power dip?) - re-enabled.")
            self._write(self.REG_DRIVER_ENABLE, 0x01)

    def write_raw(self, motor, value):
        self.raw[motor] = value
        self._write(self.REG_MA_DRIVE + motor, value)

    def set(self, motor, percent, reverse=False):
        """motor 0/1, percent 0-100. 128 = stop, 255 = full fwd, 1 = full rev."""
        percent = max(0.0, min(100.0, percent))
        offset = int(round(percent * 127 / 100))
        self.write_raw(motor, 128 - offset if reverse else 128 + offset)

    def stop(self):
        self.set(0, 0)
        self.set(1, 0)


# ============================== STATE =============================
class State:
    mode = "vibe"  # "vibe", "swivel" or "manual"
    manual = (0, 0)  # last stick values for motors A/B, -100..100
    manual_at = 0.0  # time of the last stick update
    screen = "main"  # which menu numbers refer to
    running = False
    paused = False
    vibe_idx = 0
    swivel_sel = ("speed", 50)  # ("speed", pct) or ("pattern", index)
    intensity = 100  # vibration master level, %
    reverse = ROTATE_REVERSE
    last_vibe = (0, 0)
    vmin = [VIBE_MIN_A, VIBE_MIN_B]  # live stall offsets (web GUI can adjust)


st = State()

RESTART, PAUSE, RESUME = "restart", "pause", "resume"


# ============================== INPUT =============================
class Button:
    def __init__(self, pin):
        self.io = Pin(pin, Pin.IN, Pin.PULL_UP)
        self.down_at = None

    def poll(self):
        """Return None, "short" or "long" (reported on release)."""
        pressed = not self.io.value()
        now = monotonic()
        if pressed and self.down_at is None:
            self.down_at = now
        elif not pressed and self.down_at is not None:
            held = now - self.down_at
            self.down_at = None
            if held >= LONG_PRESS_S:
                return "long"
            if held >= 0.03:  # debounce
                return "short"
        return None


_usb_poll = select.poll()
_usb_poll.register(sys.stdin, select.POLLIN)


def _echo(text):
    if ECHO_INPUT:
        sys.stdout.write(text)


class LineReader:
    """Turns a stream of characters into command lines (one per link)."""

    def __init__(self, echo):
        self.line = ""
        self.echo = echo

    def feed(self, ch):
        """Returns "!" for an instant stop key, else queues finished lines."""
        if ch in INSTANT_STOP_KEYS:
            self.line = ""
            return "!"
        if ch in "\r\n":
            if self.line:
                if self.echo:
                    _echo("\r\n")
                _queue.append(self.line)
                self.line = ""
        elif ch in "\x08\x7f":
            if self.line:
                self.line = self.line[:-1]
                if self.echo:
                    _echo("\b \b")
        elif ch >= " ":
            self.line += ch
            if self.echo:
                _echo(ch)
        return None


_queue = []
PRIORITY_COMMANDS = ("s", "stop", "g", "start")
INSTANT_STOP_KEYS = "\x1b!"   # Esc or "!" stops at once, no Enter needed
_usb_in = LineReader(echo=True)
_ble_in = LineReader(echo=False)


def _instant_stop():
    _usb_in.line = _ble_in.line = ""
    _queue.clear()
    _echo("\r\n")
    return "s"


def poll_serial():
    """Non-blocking line reader for USB and Bluetooth. Returns a line or None.

    Everything waiting is read at once. A stop/start command overrides
    (discards) anything queued before it, and an instant stop key discards
    everything and stops immediately.
    """
    while _usb_poll.poll(0):
        if _usb_in.feed(sys.stdin.read(1)):
            return _instant_stop()
    if ble:
        for ch in ble.read_all().decode("utf-8", "ignore"):
            if _ble_in.feed(ch):
                return _instant_stop()
        if ble.dropped:
            ble.dropped = False
            _ble_in.line = ""
            if STOP_ON_DISCONNECT and st.running:
                _queue.clear()
                return "s"
    if not _queue:
        return None
    for i in range(len(_queue) - 1, -1, -1):
        if _queue[i].strip().lower() in PRIORITY_COMMANDS:
            for _ in range(i):  # older commands are obsolete
                _queue.pop(0)
            break
    return _queue.pop(0)


def poll_inputs():
    line = poll_serial()
    if line is not None:
        return line
    return button.poll() if button else None


# ============================== MENUS =============================
def _mark(selected):
    return ">" if selected else " "


def show_menu():
    out()
    if st.screen == "main":
        out("========== MOTOR CONTROL ==========")
        out(" %s1  Vibration mode (2 motors)" % _mark(st.mode == "vibe"))
        out(" %s2  Swivel mode (1 motor)" % _mark(st.mode == "swivel"))
        out("  s  stop    !  instant stop (no Enter)    h  show this menu")
    elif st.screen == "vibe":
        out("====== VIBRATION  (intensity %d%%) ======" % st.intensity)
        for i, (name, _) in enumerate(VIBE_PATTERNS):
            sel = st.mode == "vibe" and st.running and i == st.vibe_idx
            out(" %s%2d  %s" % (_mark(sel), i + 1, name))
        out("  +/-  intensity 10%    p  pause/resume    g  start")
        out("  s    stop  (! = instant)  m  main menu     h  menu")
    else:
        out(
            "====== SWIVEL  (direction: %s) ======"
            % ("reverse" if st.reverse else "forward")
        )
        speeds = "  ".join(
            ("[%d]" if st.swivel_sel == ("speed", p) else "%d") % p
            for p in ROTATE_LEVELS
        )
        out("  Speeds: %s   (type the number)" % speeds)
        for i, (name, _) in enumerate(SWIVEL_PATTERNS):
            sel = st.swivel_sel == ("pattern", i)
            out(" %s d%d  %s" % (_mark(sel), i + 1, name))
        out("  g  start    p  pause/resume    s  stop  (! = instant)")
        out("  r  reverse direction    m  main menu    h  menu")
    out()


def describe():
    if st.mode == "manual":
        return "Manual (controller sticks)"
    if st.mode == "vibe":
        return "Vibration: %s (intensity %d%%)" % (
            VIBE_PATTERNS[st.vibe_idx][0],
            st.intensity,
        )
    kind, val = st.swivel_sel
    name = "steady %d%%" % val if kind == "speed" else SWIVEL_PATTERNS[val][0]
    return "Swivel: %s" % name


def report():
    """One machine-readable line for the web GUI."""
    kind, val = st.swivel_sel
    out(
        "STATUS mode=%s run=%d pause=%d vibe=%d sel=%s:%d int=%d mina=%d minb=%d dir=%s"
        % (
            st.mode,
            st.running,
            st.paused,
            st.vibe_idx + 1,
            kind,
            val + 1 if kind == "pattern" else val,
            st.intensity,
            st.vmin[0],
            st.vmin[1],
            "rev" if st.reverse else "fwd",
        )
    )


def list_patterns():
    """Pattern names for the web GUI (so it stays in sync with this file)."""
    out("BOARD pico")
    out("VIBES " + "|".join(name for name, _ in VIBE_PATTERNS))
    out("SWIVELS " + "|".join(" ".join(name.split()) for name, _ in SWIVEL_PATTERNS))
    out("LEVELS " + ",".join(str(p) for p in ROTATE_LEVELS))


def _prefixed_number(cmd, prefix):
    rest = cmd[len(prefix):]
    if cmd.startswith(prefix) and rest.isdigit():
        return int(rest)
    return None


def select_speed(speed):
    live = (
        st.mode == "swivel"
        and st.running
        and not st.paused
        and st.swivel_sel[0] == "speed"
    )
    st.mode = st.screen = "swivel"
    st.swivel_sel = ("speed", speed)
    if live:  # already spinning steadily: change speed without a stop
        motors.set(ROTATE_MOTOR, speed, st.reverse)
        out("> " + describe())
        report()
        return None
    st.running = True
    return RESTART


def status_led():
    if led:
        led.value(1 if st.running else 0)


def _parse_speed(cmd):
    if cmd.isdigit():
        n = int(cmd)
        if 5 <= n <= 9:
            n *= 10  # allow "5" for 50 % ... "9" for 90 %
        if n in ROTATE_LEVELS:
            return n
    return None


def next_selection():
    if st.mode == "vibe":
        st.vibe_idx = (st.vibe_idx + 1) % len(VIBE_PATTERNS)
        return
    options = [("speed", p) for p in ROTATE_LEVELS]
    options += [("pattern", i) for i in range(len(SWIVEL_PATTERNS))]
    st.swivel_sel = options[(options.index(st.swivel_sel) + 1) % len(options)]


def process(event):
    """Handle one button event or typed command.
    Returns RESTART (abort the current pattern), PAUSE, RESUME or None."""
    if event == "short":
        if st.mode == "manual":
            st.mode = "vibe"
        elif st.running:
            next_selection()
        st.running = True
        return RESTART
    if event == "long":
        st.mode = "swivel" if st.mode == "vibe" else "vibe"
        st.screen = st.mode
        st.running = True
        show_menu()
        return RESTART

    cmd = event.strip().lower()
    if cmd in ("h", "?", "help", "menu"):
        show_menu()
        return None
    if cmd == "m":
        st.screen = "main"
        show_menu()
        return None
    if cmd in ("s", "stop"):
        motors.stop()  # cut power now, before anything else runs
        st.running = False
        out("Stopped.")
        return RESTART
    if cmd == "p":
        if st.paused:
            return RESUME
        if st.running:
            return PAUSE
        out("Nothing running.")
        return None
    if cmd in ("g", "start"):
        if st.paused:
            return RESUME
        # (re)start the current selection from the beginning
        if not st.running and st.screen != "main":
            st.mode = st.screen
        st.running = True
        return RESTART

    # ---- Commands that work from any menu (also used by the web GUI) ----
    if cmd == "status":
        report()
        return None
    if cmd == "list":
        list_patterns()
        report()
        return None
    if cmd == "r":
        st.reverse = not st.reverse
        out("Direction: %s" % ("reverse" if st.reverse else "forward"))
        if st.mode == "swivel" and st.running:
            return RESTART
        report()
        return None
    n = _prefixed_number(cmd, "v")        # v3   -> vibration pattern 3
    if n is not None and 1 <= n <= len(VIBE_PATTERNS):
        st.mode = st.screen = "vibe"
        st.vibe_idx = n - 1
        st.running = True
        return RESTART
    n = _prefixed_number(cmd, "d")        # d3   -> swivel pattern 3
    if n is not None and 1 <= n <= len(SWIVEL_PATTERNS):
        st.mode = st.screen = "swivel"
        st.swivel_sel = ("pattern", n - 1)
        st.running = True
        return RESTART
    n = _prefixed_number(cmd, "spd")      # spd70 -> swivel steady 70 %
    if n is not None and n in ROTATE_LEVELS:
        return select_speed(n)
    if cmd.startswith("man"):             # man-40,75 -> sticks: A -40 %, B 75 %
        try:
            a, b = [max(-100, min(100, int(v))) for v in cmd[3:].split(",")]
        except ValueError:
            out("Bad manual command '%s' (use man<A>,<B>)" % cmd)
            return None
        st.manual = (a, b)
        st.manual_at = monotonic()
        if st.mode == "manual" and st.running:
            if not st.paused:
                set_manual(a, b)
            return None
        st.mode = "manual"
        st.running = True
        return RESTART
    n = _prefixed_number(cmd, "int")      # int65 -> vibration intensity 65 %
    if n is not None:
        st.intensity = max(10, min(100, n))
        if st.mode == "vibe" and st.running and not st.paused:
            set_vibe(*st.last_vibe)
        report()
        return None
    for i, prefix in enumerate(("mina", "minb")):   # mina30 -> stall offset A
        n = _prefixed_number(cmd, prefix)
        if n is not None:
            st.vmin[i] = max(0, min(90, n))
            if st.mode == "vibe" and st.running and not st.paused:
                set_vibe(*st.last_vibe)
            report()
            return None

    if st.screen == "main":
        if cmd in ("1", "2"):
            st.mode = st.screen = "vibe" if cmd == "1" else "swivel"
            st.running = False
            show_menu()
            return RESTART

    elif st.screen == "vibe":
        if cmd in ("+", "-"):
            step = 10 if cmd == "+" else -10
            st.intensity = max(10, min(100, st.intensity + step))
            out("Intensity %d%%" % st.intensity)
            if st.mode == "vibe" and st.running and not st.paused:
                set_vibe(*st.last_vibe)
            report()
            return None
        if cmd.isdigit() and 1 <= int(cmd) <= len(VIBE_PATTERNS):
            st.mode = "vibe"
            st.vibe_idx = int(cmd) - 1
            st.running = True
            return RESTART

    elif st.screen == "swivel":
        speed = _parse_speed(cmd)
        if speed is not None:
            return select_speed(speed)

    out("Unknown command '%s' - type h for the menu." % cmd)
    return None


# ============================ TIMING ==============================
def pause():
    """Freeze outputs until resumed. Returns True if a new selection was made."""
    saved = list(motors.raw)
    motors.stop()
    st.paused = True
    out("Paused - p or g to resume.")
    report()
    try:
        while True:
            event = poll_inputs()
            if event is not None:
                result = process(event)
                if result in (PAUSE, RESUME):
                    break
                if result == RESTART:
                    return True
            time.sleep(0.01)
    finally:
        st.paused = False
    out("Resumed.")
    report()
    swivel_raw = saved[ROTATE_MOTOR]
    if st.mode == "swivel" and swivel_raw != 128 and KICK_S > 0:
        motors.set(ROTATE_MOTOR, KICK_PCT, swivel_raw < 128)
        if wait(KICK_S):  # a stop during the kick still wins
            return True
    for m in (0, 1):
        motors.write_raw(m, saved[m])
    return False


def wait(seconds):
    """Sleep while handling input. Returns True if the pattern should abort."""
    end = monotonic() + seconds
    while True:
        event = poll_inputs()
        if event is not None:
            result = process(event)
            if result == RESTART:
                return True
            if result == PAUSE:
                remaining = max(0, end - monotonic())
                if pause():
                    return True
                end = monotonic() + remaining
        if monotonic() >= end:
            return False
        time.sleep(0.01)


# ============================= MODES ==============================
def vibe_drive(level, vmin):
    """Map pattern level 0-100 to drive %, skipping the stall zone."""
    if level <= 0:
        return 0
    return vmin + (100 - vmin) * min(level, 100) / 100


def set_vibe(a, b):
    st.last_vibe = (a, b)
    scale = st.intensity / 100
    motors.set(0, vibe_drive(a * scale, st.vmin[0]))
    motors.set(1, vibe_drive(b * scale, st.vmin[1]))


def run_vibe(steps):
    prev_a = prev_b = 0
    while True:
        for a, b, seconds, ramp in steps() if callable(steps) else steps:
            if ramp:
                n = max(1, int(seconds / RAMP_STEP_S))
                for i in range(1, n + 1):
                    t = i / n
                    set_vibe(prev_a + (a - prev_a) * t, prev_b + (b - prev_b) * t)
                    if wait(seconds / n):
                        return
            else:
                set_vibe(a, b)
                if wait(seconds):
                    return
            prev_a, prev_b = a, b


def run_stall_finder():
    """Raw drive (no min scaling) climbs 5 % at a time on both motors.
    The first % where a motor starts reliably is its VIBE_MIN value."""
    while True:
        for pct in range(5, 101, 5):
            out("stall finder: raw drive %d%%" % pct)
            motors.set(0, pct)
            motors.set(1, pct)
            if wait(1.5):
                return
        motors.stop()
        if wait(2.0):
            return


def run_swivel(steps):
    running = 0
    cur_dir = 1
    while True:
        for step in steps() if callable(steps) else steps:
            pct, on_s, off_s = step[:3]
            direction = step[3] if len(step) > 3 else 1
            pct = min(ROTATE_LEVELS, key=lambda lvl: abs(lvl - pct))
            rev = st.reverse != (direction < 0)
            if running and direction != cur_dir:
                motors.set(ROTATE_MOTOR, 0)
                running = 0
                if wait(DIRECTION_PAUSE_S):
                    return
            if not running and KICK_S > 0:
                motors.set(ROTATE_MOTOR, KICK_PCT, rev)
                if wait(KICK_S):
                    return
                on_s = max(0, on_s - KICK_S)
            motors.set(ROTATE_MOTOR, pct, rev)
            running, cur_dir = pct, direction
            if wait(on_s):
                return
            if off_s > 0:
                motors.set(ROTATE_MOTOR, 0)
                running = 0
                if wait(off_s):
                    return


def set_manual(a, b):
    """Drive both motors from stick values (-100..100, sign = direction).
    Any non-zero value is lifted above that motor's stall minimum."""
    for motor, value in ((0, a), (1, b)):
        if value == 0:
            motors.set(motor, 0)
        else:
            vmin = st.vmin[motor]
            motors.set(motor, vmin + (100 - vmin) * abs(value) / 100, value < 0)


def run_manual():
    st.manual_at = monotonic()
    set_manual(*st.manual)
    timed_out = False
    while True:
        if wait(0.05):
            return
        stale = monotonic() - st.manual_at > MANUAL_TIMEOUT_S
        if stale and not timed_out and not st.paused:
            motors.stop()
            out("WARNING no controller input - motors stopped.")
            timed_out = True
        elif not stale and timed_out:
            timed_out = False  # set_manual() already re-applied the new values


def idle():
    while not wait(3600):
        pass


# ============================== MAIN ==============================
try:
    ble = BleUart(BLE_NAME)
except Exception as e:  # build without 'bluetooth', or radio not answering
    print("Bluetooth unavailable (%s) - USB only." % e)

i2c = I2C(I2C_ID, sda=Pin(I2C_SDA), scl=Pin(I2C_SCL), freq=100_000)
while True:
    try:
        motors = SCMD(i2c)
        break
    except RuntimeError as e:  # keep trying, so a Bluetooth user sees why
        out("ERROR %s - check the Qwiic cable. Retrying..." % e)
button =Button(BUTTON_PIN) if BUTTON_PIN is not None else None

led = None
try:
    led = Pin("LED", Pin.OUT)
except (TypeError, ValueError):
    pass

show_menu()


def run_selection():
    motors.stop()
    status_led()
    report()
    if not st.running:
        idle()
        return
    motors.ensure_enabled()
    out("> " + describe())
    if st.mode == "manual":
        run_manual()
    elif st.mode == "vibe":
        steps = VIBE_PATTERNS[st.vibe_idx][1]
        if steps is None:
            run_stall_finder()
        else:
            run_vibe(steps)
    else:
        kind, val = st.swivel_sel
        if kind == "speed":
            # re-read each loop so live speed changes stick
            run_swivel(lambda: [(st.swivel_sel[1], 3600, 0)])
        else:
            run_swivel(SWIVEL_PATTERNS[val][1])


try:
    while True:
        try:
            run_selection()
        except OSError as e:
            # Lost contact with the motor driver - usually a power dip from a
            # motor current spike. Stop, report it, and keep listening.
            out("ERROR motor driver not responding (%s) - stopped. "
                "Check motor power / wiring." % e)
            st.running = False
            try:
                motors.stop()
                motors.ensure_enabled()
            except OSError:
                pass
            time.sleep(0.5)
finally:
    # The SCMD keeps its last speed if the board resets, so always stop it.
    motors.stop()
    if led:
        led.value(0)
