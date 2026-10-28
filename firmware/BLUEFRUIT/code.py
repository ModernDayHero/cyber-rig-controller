# Circuit Playground Bluefruit (one intake port; same code on left and right)
# BLE peripheral "RB-L" / "RB-R" -> receives mode bytes from the CLUE and
# animates its intake. The CLUE links to both sides on its own.
# Needs leds.mpy next to it and adafruit_ble in /lib.
#
# Side: settings.toml on each board,  RIG_SIDE = "L"  or  RIG_SIDE = "R"
# Buttons: A = next mode (local backup), B = virus  (this side only)
# Commands: one mode byte, C + 3 bytes RGB (scanned color),
#           B + 6 bytes (rebreather: breathe between two colors),
#           or N kind sound (call / message alert; see leds.py)

import os
import time
import board
import digitalio
import neopixel
from adafruit_ble import BLERadio
from adafruit_ble.advertising.standard import ProvideServicesAdvertisement
from adafruit_ble.services.nordic import UARTService
from leds import Buzzer, Lens, Mic, Parser

SIDE = "R" if os.getenv("RIG_SIDE", "L").upper().startswith("R") else "L"
BRIGHTNESS = 0.3   # heat + battery rule
MODES = "DXrMAR"    # local backup: CLUE OS modes, then VU + rainbow

px = neopixel.NeoPixel(board.NEOPIXEL, 10, brightness=BRIGHTNESS, auto_write=False)
KEY = 0 if SIDE == "L" else 1
lens = Lens(px, key=KEY, mic=Mic(), buzz=Buzzer(KEY))

ble = BLERadio()
ble.name = "RB-" + SIDE
uart = UARTService()
adv = ProvideServicesAdvertisement(uart)
# The name goes in the advertisement itself (UART UUID + flags + "RB-L" fits in
# 31 bytes) so the CLUE can tell the sides apart without a scan response.
adv.complete_name = ble.name

def btn(pin):
    b = digitalio.DigitalInOut(pin)
    b.switch_to_input(pull=digitalio.Pull.DOWN)   # CP buttons read True when pressed
    return b
btn_a, btn_b = btn(board.BUTTON_A), btn(board.BUTTON_B)
a_prev = b_prev = False

parser = Parser()

def advertise():
    # CircuitPython's BLE file workflow is often already advertising as
    # "CIRCUITPYxxxx", so ble.advertising can be True without the CLUE ever
    # seeing a UART service. Always replace it with ours.
    try:
        ble.stop_advertising()
    except Exception:
        pass
    ble.start_advertising(adv)

advertise()
print("link:", ble.name, "waiting for CLUE")

was_connected = False
while True:
    if ble.connected != was_connected:          # shows on the serial console
        was_connected = ble.connected
        print("link:", "CLUE connected" if was_connected else "waiting for CLUE")
        if not was_connected:
            advertise()

    if ble.connected and uart.in_waiting:
        for m, data in parser.feed(uart.read(uart.in_waiting)):
            print("cmd:", m, data or "")
            lens.apply(m, data)

    a, b = btn_a.value, btn_b.value
    if a and not a_prev:
        cur = lens.mode if lens.mode in MODES else "D"
        lens.apply(MODES[(MODES.index(cur) + 1) % len(MODES)])
    if b and not b_prev:
        lens.apply("D" if lens.mode in "FV" else "V")
    a_prev, b_prev = a, b

    lens.update()
    time.sleep(0.005 if lens.alerting() else 0.02)   # quicker steps keep the beeps smooth
