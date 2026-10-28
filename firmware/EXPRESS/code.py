# Circuit Playground Express (right intake port)
# Follows the mode byte from the Bluefruit over the wire.
# Rename to code.py on the Express. Needs leds.py next to it.
#
# Wire: Express RX (A6) <- Bluefruit TX (A7), GND -> GND

import time
import board
import busio
import neopixel
from leds import Lens, Mic, Parser

BRIGHTNESS = 0.3
px = neopixel.NeoPixel(board.NEOPIXEL, 10, brightness=BRIGHTNESS, auto_write=False)
lens = Lens(px, key=1, mic=Mic())
wire = busio.UART(board.TX, board.RX, baudrate=9600, timeout=0)

parser = Parser()

while True:
    if wire.in_waiting:
        data = wire.read(wire.in_waiting)
        if data:
            for m, data in parser.feed(data):
                lens.apply(m, data)
    lens.update()
    time.sleep(0.02)
