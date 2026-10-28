Edgerunner rig firmware (CircuitPython 9.x)

Copy each folder's contents to the root of that board's CIRCUITPY drive.

CLUE/       code.py, octlet_sprite.bmp, octlet_mini.bmp
            lib: adafruit_imageload, adafruit_display_text, adafruit_apds9960,
                 adafruit_register (needed by apds9960)
BLUEFRUIT/  code.py, leds.mpy  (same files on the left and right Bluefruit)
            lib: adafruit_ble
            settings.toml: RIG_SIDE = "L" on the left board, RIG_SIDE = "R" on the right
EXPRESS/    code.py, leds.mpy  (old wired right side; not used with two Bluefruits)

Get the lib folders from the CircuitPython library bundle matching your
CircuitPython version (circuitpython.org/libraries).

Links: the CLUE is BLE central to both Bluefruits. They advertise as RB-L and
RB-R; an unnamed UART (old single-mask firmware) is taken as the left side.
Mode bytes: D dark, X glitch, H hunt, h heartbeat, M matrix, R rainbow,
P peace out, A audio, F/V virus, I = idle (dark),
C + 3 bytes = scanned color.

Color scan: on the CLUE, hold your finger on gold pad 0 while the sensor
faces the target; release to send the color to the rebreather.
The CLUE's BLE send() is still a stub; the rebreather runs on its own
buttons until the link code is added.
