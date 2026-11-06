# STEAMWorkz motor plugin: Pimoroni Pico Plus 2 W (RP2350 + RM2 radio), MicroPython.
# DC motors only (servos will be their own node): the Cyber Deck (src/ble/motor.js) or any
# app speaking the standard text protocol drives them over BLE. What's wired where is
# channels.json, read at boot:
#   scmd    SparkFun Qwiic Motor Driver on the Qw/ST port (I2C 0x5D, motors A / B)
#   tb6612  SparkFun TB6612FNG breakout: PWM + IN1 / IN2 (+ STBY) per motor
#   dc      any two-PWM-pin H-bridge (DRV8833 style)
#   stepper STEP / DIR driver (A4988 / TMC2209), speed by the STEP pin's frequency
#
# STATUS LED (the board's own, if it has one): slow blink = waiting for the deck, solid =
# connected, fast blink = the motor driver isn't answering, flicker = a Bluetooth update.
#
# BLE: advertises as NAME on the Nordic UART service. Commands end with ';' or a newline,
# so both protocols below share the one link.
#
# 1. The standard protocol (any app). Levels 0..20 (= 0..100 %, then each channel's max /
#    min / kick apply). A level holds until changed; STOP, X or a disconnect stops it.
#    Starting one stops the deck's pattern.
#     Vibrate:<n>;                  every motor except the rotate one
#     Vibrate1:<n>; Vibrate2:<n>;   the 1st / 2nd of those
#     Rotate:<n>;                   the motor with "rotate": true (else the first), current direction
#     RotateClockwise:<n>; RotateCounterClockwise:<n>; RotateChange;   (flip direction)
#     Battery;     -> <percent>;    DeviceType;  -> DEVICE_TYPE + the radio's MAC;
#   Each answers OK; (or ERR; for anything it doesn't have, like Air or Light).
#
# 2. The deck's own (patterns stored here, so motion stays smooth with no BLE chatter):
#     ?                      report: C lines (channels), then S (the pattern playing)
#     V <ch> <value>         hand control: -100..100 % (sign = direction); needs a V or K
#                            at least every 1.5 s or that motor stops (dead-man)
#     K                      keepalive while a hand control is held
#     P <key> <json>         store the pattern for mode `key` (a key starting '~' is a
#                            test: kept in memory, not written to flash):
#                            {"len": ms, "tracks": {"<ch>": [[t_ms, value], ...]}}
#     M <key> | M -          play `key`'s pattern (looping) / stop patterns
#     N <ch> <min> [kick]    calibration, live: stall minimum %, start-up kick ms
#     W                      save the calibration into channels.json
#     T                      connection test: driver check, then each motor fwd / rev (T lines)
#     U <file> <size> <crc>  update over Bluetooth (main.py, channels.json, identity.json): begin
#     F <seq> <base64>       ... the next piece (the board answers A <seq> every 8th)
#     U!                     ... finish: check size, CRC-32 and (main.py) that it compiles,
#                            keep the old one (main.bak / channels.bak), swap, restart
#     U-                     ... abandon it
#     X                      STOP: everything, now (patterns too)
#   plugin -> deck
#     C <i> <type> <name> <min> <max> <home> <floor> <kick> | C end    the channels (on ?;
#                            floor / kick -1 = no calibration on that one)
#     S <key>|-              the pattern playing
#     E <why>                something was refused
#     I <note>               information (calibration saved)
#     F <crc>                this firmware's CRC-32 (on ?), so the deck knows when to update
#     U ready|done <file>|err <why>   and  A <seq>    the update's progress

import json
import os
import time
import bluetooth
import asyncio
import machine
from machine import Pin, PWM, I2C
from micropython import const
from binascii import a2b_base64
try:
    from binascii import crc32
except ImportError:                                   # a build without it: the slow way
    def crc32(data, crc=0):
        crc ^= 0xFFFFFFFF
        for b in data:
            crc ^= b
            for _ in range(8):
                crc = (crc >> 1) ^ (0xEDB88320 if crc & 1 else 0)
        return crc ^ 0xFFFFFFFF


def file_crc(path):
    c = 0
    try:
        with open(path, 'rb') as f:
            while True:
                b = f.read(1024)
                if not b:
                    return c
                c = crc32(b, c)
    except OSError:
        return 0


FW_CRC = '%08x' % file_crc('main.py')                 # what's running, for the deck's update check

NAME = 'RIG-MOTOR'
DEVICE_TYPE = 'RIG:1:'                                # DeviceType; answer, before the MAC
BATTERY = 100                                         # Battery; answer: no battery sensing wired
DEADMAN_MS = const(1500)
TICK_MS = const(20)
STAGGER_MS = const(150)    # motors starting from still together: each waits this long after
                           # the last one started, so their start-up currents (and kicks)
                           # don't add up and brown the supply out
_next_start = [0]          # when the next motor may start (ticks_ms)

# ---------------------------------------------------------------- channels
class Motor:                                          # DC, through an H-bridge: two PWM pins
    kind = 'dc'

    def __init__(self, c):
        self.name, self.top = c.get('name', 'MOTOR'), c.get('max', 100)
        self.a, self.b = PWM(Pin(c['pins'][0])), PWM(Pin(c['pins'][1]))
        for p in (self.a, self.b):
            p.freq(c.get('freq', 20000))
        self.home = 0
        self.write(0)

    def limits(self):
        return -self.top, self.top

    def write(self, pct):
        pct = max(-self.top, min(self.top, pct))
        duty = int(abs(pct) * 65535 / 100)
        self.a.duty_u16(duty if pct > 0 else 0)
        self.b.duty_u16(duty if pct < 0 else 0)

    def stop(self):
        self.write(0)

    rest = stop


class Stepper:                                        # STEP / DIR driver; the STEP pin's PWM sets the speed
    kind = 'stepper'

    def __init__(self, c):
        self.name, self.top = c.get('name', 'STEPPER'), c.get('max', 100)
        self.speed = c.get('speed', 800)              # steps / s at 100 %
        self.step, self.dir = PWM(Pin(c['pins'][0])), Pin(c['pins'][1], Pin.OUT)
        self.en = Pin(c['en'], Pin.OUT) if 'en' in c else None
        self.home = 0
        self.write(0)

    def limits(self):
        return -self.top, self.top

    def write(self, pct):
        pct = max(-self.top, min(self.top, pct))
        if abs(pct) < 1:
            self.step.duty_u16(0)
            if self.en:
                self.en.value(1)                      # driver off: no holding current
            return
        if self.en:
            self.en.value(0)
        self.dir.value(1 if pct > 0 else 0)
        self.step.freq(max(10, int(self.speed * abs(pct) / 100)))
        self.step.duty_u16(32768)

    def stop(self):
        self.write(0)

    rest = stop


class Drive:
    """What every DC driver shares: the cap (max %), a stall minimum (min %: any motion is
    lifted above it, so low values still turn the motor) and a start-up kick (kick ms at
    full power when it starts from still or reverses, to break static friction)."""
    kind = 'dc'
    home = 0

    def setup(self, c, name):
        self.name, self.top = c.get('name', name), c.get('max', 100)
        self.floor, self.kick_ms = c.get('min', 0), c.get('kick', 0)
        self.last, self.kick_until = 0, None

    def limits(self):
        return -self.top, self.top

    def write(self, pct):
        pct = max(-self.top, min(self.top, pct))
        if abs(pct) < 1:
            self.last, self.kick_until = 0, None
            return self.out(0)
        now = time.ticks_ms()
        if self.last == 0:                            # starting from still: wait our turn
            if time.ticks_diff(_next_start[0], now) > 0:
                return self.out(0)                    # (last stays 0: we try again next tick)
            _next_start[0] = time.ticks_add(now, STAGGER_MS)
        if self.kick_ms and (self.last == 0 or (self.last > 0) != (pct > 0)):
            self.kick_until = time.ticks_add(now, self.kick_ms)
        self.last = pct
        if self.kick_until is not None and time.ticks_diff(self.kick_until, now) > 0:
            return self.out(100 if pct > 0 else -100)
        self.kick_until = None
        drive = self.floor + (100 - self.floor) * abs(pct) / 100
        self.out(drive if pct > 0 else -drive)

    def stop(self):
        self.write(0)

    rest = stop


class TB6612(Drive):                                  # SparkFun TB6612FNG: one of its two motors
    def __init__(self, c):
        self.setup(c, 'MOTOR')
        p = c['pins']                                 # [pwm, in1, in2]
        self.pwm = PWM(Pin(p[0]))
        self.pwm.freq(c.get('freq', 20000))
        self.in1, self.in2 = Pin(p[1], Pin.OUT), Pin(p[2], Pin.OUT)
        if 'stby' in c:
            Pin(c['stby'], Pin.OUT).value(1)          # shared by both motors: keep it awake
        self.out(0)

    def out(self, pct):
        self.in1.value(1 if pct > 0 else 0)
        self.in2.value(1 if pct < 0 else 0)
        self.pwm.duty_u16(int(abs(pct) * 65535 / 100))


class SCMDBoard:
    """SparkFun Qwiic Motor Driver, register level (one per I2C address, shared by A and B).
    It doesn't have to be there at boot: until it answers (powered later, slow to start,
    a loose cable) its motors just don't move, and check() tries again every 2 s; the same
    if it drops out later (a brown-out)."""
    REG_ID, ID_VALUE, REG_DRIVE, REG_ENABLE, REG_STATUS, ENUM_DONE = 0x01, 0xA9, 0x20, 0x70, 0x77, 0x01
    boards = {}

    @classmethod
    def get(cls, addr):
        if addr not in cls.boards:
            cls.boards[addr] = cls(addr)
        return cls.boards[addr]

    def __init__(self, addr):
        self.i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=100_000)    # the Qw/ST port
        self.addr, self.raw, self.ready = addr, [None, None], False
        self.checked = time.ticks_ms()
        if not self.connect(3000):
            print('Qwiic Motor Driver not answering at 0x%02X yet: retrying every 2 s' % addr)

    def connect(self, wait_ms=0):
        """Find it and switch it on (motors stopped: it keeps its last speed through a reset)."""
        deadline = time.ticks_add(time.ticks_ms(), wait_ms)
        while True:
            try:
                if self._read(self.REG_ID) == self.ID_VALUE and self._read(self.REG_STATUS) & self.ENUM_DONE:
                    self.raw = [None, None]
                    self.ready = True
                    for m in (0, 1):
                        self.set(m, 0)
                    self._write(self.REG_ENABLE, 0x01)
                    print('Qwiic Motor Driver ready at 0x%02X' % self.addr)
                    return True
            except OSError:
                self.ready = False
            if time.ticks_diff(time.ticks_ms(), deadline) >= 0:
                return False
            time.sleep_ms(50)

    def _write(self, reg, v):
        for attempt in range(3):                      # a bus glitch mustn't swallow a stop
            try:
                return self.i2c.writeto(self.addr, bytes((reg, v)))
            except OSError:
                if attempt == 2:
                    self.ready = False                # gone: check() finds it again
                    raise

    def _read(self, reg):
        return self.i2c.readfrom_mem(self.addr, reg, 1)[0]

    def set(self, m, pct):
        """pct -100..100: 128 = stop, 255 = full forward, 1 = full reverse."""
        if not self.ready:
            return                                    # not there (yet): nothing to drive
        raw = 128 + int(round(max(-100, min(100, pct)) * 127 / 100))
        if raw != self.raw[m]:                        # only real changes go over I2C
            self.raw[m] = raw
            self._write(self.REG_DRIVE + m, raw)

    def check(self):
        """Every 2 s: find it if it isn't there; re-enable it if it reset (a current spike)."""
        now = time.ticks_ms()
        if time.ticks_diff(now, self.checked) < 2000:
            return
        self.checked = now
        if not self.ready:
            self.connect()
            return
        if not self._read(self.REG_ENABLE) & 0x01:
            print('motor driver had reset (power dip?): re-enabled')
            self.raw = [None, None]
            self._write(self.REG_ENABLE, 0x01)


class SCMD(Drive):                                    # one motor (A = 0, B = 1) of a Qwiic Motor Driver
    def __init__(self, c):
        self.setup(c, 'MOTOR')
        self.board, self.m = SCMDBoard.get(c.get('addr', 0x5D)), c.get('motor', 0)
        self.out(0)

    def out(self, pct):
        self.board.set(self.m, pct)


KINDS = {'dc': Motor, 'stepper': Stepper, 'tb6612': TB6612, 'scmd': SCMD}


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


# identity.json (optional): what the board advertises as and answers to DeviceType;, for apps
# that recognise devices by name and type, e.g. {"name": "...", "device_type": "X:1:"}.
_identity = load('identity.json', {})
NAME = str(_identity.get('name', NAME))[:20]
DEVICE_TYPE = str(_identity.get('device_type', DEVICE_TYPE))[:12]

channels = []
skipped = []                                          # (name, why) for the connection test
config = load('channels.json', [])
for c in config:
    try:
        channels.append(KINDS[c['type']](c))
        channels[-1].rotate = bool(c.get('rotate'))
        channels[-1].cfg = c                          # W writes calibration back into it
    except Exception as e:
        print('channel skipped:', c, e)
        skipped.append((str(c.get('name', c.get('type', '?'))), str(e)))
print('motor plugin:', [(ch.kind, ch.name) for ch in channels])

# ---------------------------------------------------------------- patterns + hand control
patterns = load('patterns.json', {})
playing = None                                        # mode key, or None
started = time.ticks_ms()
hand = {}                                             # ch -> {'v', 'until' (None = holds: the standard protocol)}
rot_dir = 1                                           # Rotate's direction: 1 clockwise, -1 counter


def at(track, t):
    """A track's value at t ms: straight lines between its points."""
    if not track:
        return None
    if t <= track[0][0]:
        return track[0][1]
    for (t0, v0), (t1, v1) in zip(track, track[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * (t - t0) / max(1, t1 - t0)
    return track[-1][1]


def stop_all():
    global playing, testing
    playing, testing = None, False                    # X also ends a connection test
    hand.clear()
    for ch in channels:
        ch.stop()


def tick():
    now = time.ticks_ms()
    p = patterns.get(playing) if playing else None
    t = time.ticks_diff(now, started) % max(1, p['len']) if p else 0
    for i, ch in enumerate(channels):
        h = hand.get(i)
        if h and h['until'] is not None and time.ticks_diff(now, h['until']) > 0:
            del hand[i]                               # dead-man: let go means stop / back to the pattern
            h = None
            ch.stop()
        if h:
            ch.write(h['v'])
            continue
        v = at(p['tracks'].get(str(i)), t) if p else None
        if v is not None:
            ch.write(v)


def standard(line):
    """One standard-protocol command ("Vibrate:10", "Battery"...); answers on the link."""
    global playing, rot_dir
    name, _, arg = line.partition(':')
    if name == 'Battery':
        return reply('%d;' % BATTERY)
    if name == 'DeviceType':
        mac = ble.config('mac')[1]
        return reply(DEVICE_TYPE + ''.join('%02X' % x for x in mac) + ';')
    flagged = [i for i, ch in enumerate(channels) if ch.rotate][:1]
    rot = flagged or [0]                              # Rotate: the "rotate" motor, else the first
    vibe = [i for i in range(len(channels)) if i not in flagged] or rot   # Vibrate: all the others
    if name == 'RotateChange':
        rot_dir = -rot_dir
        h = hand.get(rot[0])
        if h:
            h['v'] = -h['v']
        return reply('OK;')
    if name == 'Vibrate':
        targets, sign = vibe, 1
    elif name in ('Vibrate1', 'Vibrate2'):
        targets, sign = vibe[int(name[-1]) - 1:][:1], 1
    elif name in ('Rotate', 'RotateClockwise', 'RotateCounterClockwise'):
        if name != 'Rotate':
            rot_dir = 1 if name == 'RotateClockwise' else -1
        targets, sign = rot, rot_dir
    else:
        return reply('ERR;')                          # Air, Light...: not on this node
    try:
        level = max(0, min(20, int(arg)))
    except ValueError:
        return reply('ERR;')
    if not channels:
        return reply('ERR;')
    playing = None                                    # the app drives now, not the deck's pattern
    for i in targets:
        hand[i] = {'v': sign * level * 5, 'until': None}
    reply('OK;')


OURS = ('?', 'V', 'K', 'P', 'M', 'N', 'W', 'T', 'X', 'U', 'U!', 'U-', 'F')
UPDATABLE = {'main.py': 'main.bak', 'channels.json': 'channels.bak', 'identity.json': 'identity.bak'}
upd = None                                            # the update coming in, if any


def _drop_update():
    global upd
    if upd:
        try:
            upd['f'].close()
            os.remove(upd['name'] + '.new')
        except Exception:
            pass
    upd = None


async def _restart():
    await asyncio.sleep_ms(600)                       # let the last message go out first
    for ch in channels:
        try:
            ch.stop()
        except Exception:
            pass
    machine.reset()


def update(c, w, line):
    """Bluetooth update: U (begin) / F (pieces) / U! (finish) / U- (abandon)."""
    global upd
    if c == 'U':
        a = line.split()
        if len(a) != 4 or a[1] not in UPDATABLE:
            return say('U err not a file I take')
        _drop_update()
        stop_all()                                    # nothing moves while it updates
        upd = {'name': a[1], 'size': int(a[2]), 'crc': a[3].lower(), 'seq': 0, 'got': 0, 'run': 0,
               'f': open(a[1] + '.new', 'wb')}
        return say('U ready')
    if c == 'U-':
        _drop_update()
        return say('U err abandoned')
    if not upd:
        return say('U err no update started')
    if c == 'F':
        seq = int(w[1])
        if seq != upd['seq']:
            _drop_update()
            return say('U err piece %d missing' % upd['seq'] if upd else 'U err piece missing')
        data = a2b_base64(w[2])
        upd['f'].write(data)
        upd['run'] = crc32(data, upd['run'])
        upd['got'] += len(data)
        upd['seq'] += 1
        if seq % 8 == 7:
            say('A %d' % seq)
        return
    # U!: check it, keep the old one, swap, restart
    name, new = upd['name'], upd['name'] + '.new'
    upd['f'].close()
    got, size, crc = upd['got'], upd['size'], '%08x' % upd['run']
    if got != size or crc != upd['crc']:
        _drop_update()
        return say('U err damaged on the way (%d of %d bytes, crc %s): try again' % (got, size, crc))
    if name == 'main.py':
        try:
            with open(new) as f:
                compile(f.read(), 'main.py', 'exec')
        except SyntaxError as e:
            _drop_update()
            return say('U err it has a mistake: ' + str(e)[:60])
        except NameError:
            pass                                      # no compile() on this build: CRC will do
    else:
        try:
            with open(new) as f:
                json.load(f)
        except Exception:
            _drop_update()
            return say('U err not valid JSON')
    upd = None
    try:
        os.remove(UPDATABLE[name])
    except OSError:
        pass
    try:
        os.rename(name, UPDATABLE[name])
    except OSError:
        pass
    os.rename(new, name)
    say('U done ' + name)
    asyncio.create_task(_restart())


def command(line):
    global playing, started
    w = line.split(' ', 2)
    c = w[0]
    if c not in OURS:                                 # a word, not one of our letters: standard
        return standard(line)
    if c in ('U', 'U!', 'U-', 'F'):
        return update(c, w, line)
    if c == '?':
        for i, ch in enumerate(channels):
            lo, hi = ch.limits()
            say('C {} {} {} {} {} {} {} {}'.format(i, ch.kind, ch.name.replace(' ', '_'), int(lo), int(hi), int(ch.home),
                                                  getattr(ch, 'floor', -1), getattr(ch, 'kick_ms', -1)))
        say('C end')
        say('S ' + (playing or '-'))
        say('F ' + FW_CRC)
    elif c == 'N':                                    # N <ch> <min> [kick]: calibration, live
        a = line.split()
        ch = channels[int(a[1])]
        if not hasattr(ch, 'floor'):
            return say('E no calibration on ' + ch.name)
        ch.floor = max(0, min(90, int(a[2])))
        if len(a) > 3:
            ch.kick_ms = max(0, min(1000, int(a[3])))
    elif c == 'W':                                    # W: keep the calibration (channels.json)
        for ch in channels:
            if hasattr(ch, 'floor'):
                ch.cfg['min'], ch.cfg['kick'] = ch.floor, ch.kick_ms
        with open('channels.json', 'w') as f:
            json.dump(config, f)
        say('I calibration saved')
    elif c == 'T':                                    # connection test (results as T lines)
        asyncio.create_task(selftest())
    elif c == 'X':
        stop_all()
        say('S -')
    elif c == 'K':
        later = time.ticks_add(time.ticks_ms(), DEADMAN_MS)
        for h in hand.values():
            if h['until'] is not None:
                h['until'] = later
    elif c == 'V':
        a = line.split()
        i, v = int(a[1]), float(a[2])
        if not 0 <= i < len(channels):
            return say('E channel')
        hand[i] = {'v': v, 'until': time.ticks_add(time.ticks_ms(), DEADMAN_MS)}
    elif c == 'P':
        try:
            p = json.loads(w[2])
            assert p['len'] > 0 and isinstance(p['tracks'], dict)
        except Exception:
            return say('E pattern')
        if patterns.get(w[1]) != p:
            patterns[w[1]] = p
            if not w[1].startswith('~'):              # '~test' etc.: memory only, no flash wear
                with open('patterns.json', 'w') as f:
                    json.dump({k: v for k, v in patterns.items() if not k.startswith('~')}, f)
    elif c == 'M':
        hand.clear()                                  # back from hand control to the pattern
        if w[1] == '-' or w[1] not in patterns:
            playing = None
            for ch in channels:
                ch.rest()
        else:
            if w[1] != playing:
                started = time.ticks_ms()
            playing = w[1]
        say('S ' + (playing or '-'))


# ---------------------------------------------------------------- BLE: Nordic UART
_UART = bluetooth.UUID('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')
_TX = (bluetooth.UUID('6E400003-B5A3-F393-E0A9-E50E24DCCA9E'), bluetooth.FLAG_NOTIFY)
_RX = (bluetooth.UUID('6E400002-B5A3-F393-E0A9-E50E24DCCA9E'), bluetooth.FLAG_WRITE | bluetooth.FLAG_WRITE_NO_RESPONSE)
_IRQ_CONNECT, _IRQ_DISCONNECT, _IRQ_WRITE = const(1), const(2), const(3)

ble = bluetooth.BLE()
ble.active(True)
try:
    ble.config(gap_name=NAME, mtu=247)
except (ValueError, OSError):
    pass
((tx_handle, rx_handle),) = ble.gatts_register_services(((_UART, (_TX, _RX)),))
ble.gatts_set_buffer(rx_handle, 512, True)
conns = set()
buf = b''
lines = []


def advertise():
    name = NAME.encode()
    payload = bytes((2, 0x01, 0x06)) + bytes((len(name) + 1, 0x09)) + name   # flags + full name
    ble.gap_advertise(100_000, adv_data=payload, resp_data=bytes((17, 0x07)) + bytes(_UART))


def irq(event, data):
    global buf
    if event == _IRQ_CONNECT:
        conns.add(data[0])
    elif event == _IRQ_DISCONNECT:
        conns.discard(data[0])
        for i, ch in enumerate(channels):             # the deck's gone: hand control lets go
            if i in hand:
                ch.stop()
        hand.clear()
        advertise()
    elif event == _IRQ_WRITE and data[1] == rx_handle:
        buf += ble.gatts_read(rx_handle).replace(b';', b'\n')
        while b'\n' in buf:
            line, buf = buf.split(b'\n', 1)
            if line.strip():
                lines.append(line.decode().strip())
        if len(buf) > 4096:
            buf = b''


def reply(raw):
    """The standard protocol's answers: exactly as given (they carry their own ';')."""
    for c in conns:
        try:
            ble.gatts_notify(c, tx_handle, raw.encode())
        except Exception:
            pass


def say(text):
    for c in conns:
        try:
            ble.gatts_notify(c, tx_handle, (text + '\n').encode())
        except Exception:
            pass


ble.irq(irq)
advertise()


testing = False


async def selftest():
    """Connection test, step by step, so the deck can show where it breaks:
    T cfg <configured> <working> | T skip <name> <why> | T i2c <addresses> |
    T driver <addr> <id> <enabled> | T run <ch> fwd/rev | T ok <ch> | T fail <ch> <why> | T done
    Each motor runs forward 1 s, then reverse 1 s, at 60 %; then all of them together for 2 s
    (T both / T bothok), started STAGGER_MS apart. STOP / X ends it."""
    global testing, playing
    if testing:
        return
    testing = True
    try:
        say('T cfg {} {}'.format(len(config), len(channels)))
        for name, why in skipped:
            say('T skip {} {}'.format(name.replace(' ', '_'), why[:60]))
        if any(c.get('type') == 'scmd' for c in config):
            try:
                found = I2C(0, sda=Pin(4), scl=Pin(5), freq=100_000).scan()
                say('T i2c ' + (','.join('0x%02X' % a for a in found) or '-'))
            except Exception as e:
                say('T i2c error ' + str(e)[:40])
            for addr, b in SCMDBoard.boards.items():
                if not b.ready and not b.connect(1000):
                    say('T driver 0x%02X notready' % addr)
                    continue
                try:
                    say('T driver 0x%02X %02X %d' % (addr, b._read(b.REG_ID), b._read(b.REG_ENABLE) & 1))
                except Exception as e:
                    say('T driver 0x%02X error %s' % (addr, str(e)[:40]))
        playing = None                                # no pattern while testing
        hand.clear()
        for i, ch in enumerate(channels):
            ok = True
            for v, way in ((60, 'fwd'), (-60, 'rev')):
                if not testing:
                    return
                say('T run {} {}'.format(i, way))
                hand[i] = {'v': v, 'until': None}
                board = getattr(ch, 'board', None)
                if board and not board.ready:
                    ok = False
                    say('T fail {} driver not answering'.format(i))
                    break
                try:
                    ch.write(v)
                except Exception as e:
                    ok = False
                    say('T fail {} {}'.format(i, str(e)[:50]))
                    break
                await asyncio.sleep_ms(1000)
            hand.pop(i, None)
            try:
                ch.stop()
            except Exception:
                pass
            if ok:
                say('T ok {}'.format(i))
            await asyncio.sleep_ms(300)
        if len(channels) > 1 and testing:             # all together, started one after another
            say('T both')
            for i in range(len(channels)):
                hand[i] = {'v': 60, 'until': None}
            await asyncio.sleep_ms(2000)
            for i, ch in enumerate(channels):
                hand.pop(i, None)
                try:
                    ch.stop()
                except Exception:
                    pass
            if testing:
                say('T bothok')
        say('T done')
    finally:
        testing = False


# ---------------------------------------------------------------- status LED
try:
    led = Pin('LED', Pin.OUT)                         # on wireless Picos it's on the radio chip
except Exception:
    led = None                                        # no LED on this board: no status light
_led_was = None


def show_status(fault):
    """The LED says what the board is doing; it's only switched when that changes."""
    global _led_was
    if not led:
        return
    now = time.ticks_ms()
    if upd:
        on = (now // 60) % 2                          # flicker: an update is coming in
    elif fault or any(not b.ready for b in SCMDBoard.boards.values()):
        on = (now // 150) % 2                         # fast blink: the motor driver isn't answering
    elif conns:
        on = 1                                        # solid: the deck (or an app) is connected
    else:
        on = (now // 700) % 2                         # slow blink: advertising, waiting
    if on != _led_was:
        _led_was = on
        try:
            led.value(on)
        except Exception:
            pass


async def main():
    print('motor plugin: ready, advertising as', NAME, '(status LED)' if led else '(no status LED)')
    fault = False
    while True:
        while lines:
            try:
                command(lines.pop(0))
            except Exception as e:
                say('E ' + str(e)[:40])
        try:
            tick()
            for b in SCMDBoard.boards.values():
                try:
                    b.check()
                except OSError:
                    b.ready = False
            fault = False
        except OSError as e:                          # lost the I2C driver: say so once, keep trying
            if not fault:
                print('motor driver not responding:', e)
                say('E driver')
            fault = True
        show_status(fault)
        await asyncio.sleep_ms(TICK_MS)


try:
    asyncio.run(main())
finally:                                              # the SCMD holds its last speed through a reset
    if led:
        try:
            led.value(0)
        except Exception:
            pass
    for ch in channels:
        try:
            ch.stop()
        except Exception:
            pass
