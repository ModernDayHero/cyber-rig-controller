# Motor module

The deck side of the motor plugin: a Pimoroni Pico Plus 2 W that runs the rig's DC motors
(firmware in `firmware/MOTOR/`). The motors follow the lights, react to sound and to a CLUE
shake, and have a test bench for setting them up.

```
src/motors/
  ble.js          Bluetooth driver: the text protocol, and firmware updates over BLE
  motions.js      the motion library: pure data and maths, no Bluetooth or page
  controller.js   what the motors do: follow the lights, tests, shake, calibration
  live.js         SOUND (the phone's mic) and the SHAKE bursts
  index.js        setupMotors(): wires the UI parts together
  ui/
    common.js     shared bits: the MOTORS A | B | BOTH picker, tiles, sliders
    settings.js   SET -> MOTORS
    bench.js      the MOTOR tab's test bench (RUMBLE, SWIVEL, PAD, CALIBRATE, CONSOLE)
    tab.js        the MOTOR tab: STOP, CONNECTION TEST, NOW, hand controls
```

## How the parts fit

```
rig.state.motors ──► controller.js ──► ble.js ──BLE──► Pico (firmware/MOTOR/main.py)
      ▲                  │   ▲                            plays stored patterns itself
      │                  │   └── live.js (mic levels, shake bursts)
   ui/*.js ◄── 'change' ─┘
                motions.js: makePattern() turns a motion into the plugin's pattern
```

- **The rig owns it:** `rig.motor` is the device (`ble.js`), and `rig.motors` is the
  controller. The settings live in `rig.state.motors` and are saved with the rest of the rig.
- **Motions run on the board, not the phone.** When the lighting pattern changes, the
  controller sends `M <key>` and the Pico plays the pattern it stored earlier (`P <key>
  <json>`). Only live things (SOUND, the bench's swivel and sticks) stream `V` commands, and
  the board stops a motor by itself 1.5 s after those stop arriving.
- **UI parts share a small context** (`index.js`): the rig, the controller, the page helpers,
  the motion selected for tuning, and `render()`. Each part adds its own render function.

## Protocols

The board speaks two, on the one Nordic UART link (full list at the top of `main.py`):

- **The deck's:** `?`, `V`, `K`, `P`, `M`, `N`, `W`, `T`, `X`, and the update commands `U`, `F`, `U!`.
- **The standard text protocol:** `Vibrate:<0-20>;`, `Rotate:…;`, `Battery;`, `DeviceType;`,
  so other apps can drive it.

## Known issues

- **Open update path (security review, High):** any BLE client in range can replace the
  board's firmware. Planned fix: an owner key with challenge and answer, and a power-on
  window. See `docs/learning/ble-security-and-animations.md`, section 7.
- `firmware/MOTOR/main.py` is still one file (about 790 lines), because the Bluetooth update
  sends a single file. Splitting it needs the update to handle several files first.
