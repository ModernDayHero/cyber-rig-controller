# Motor plugin (Pimoroni Pico Plus 2 W, MicroPython)

Runs the rig's DC motors (and steppers) over Bluetooth. Servos will be their own node.

- **From the Cyber Deck:** by hand on the MOTOR tab, and on its own with a motion linked to
  each lighting pattern (SET → MOTORS). Guests with the MOTORS permission get capped hand
  controls on their turn.
- **From any app** speaking the standard text protocol (`Vibrate:10;`, `Rotate:5;`…), on the
  same link.

## Set up

1. Flash Pimoroni's MicroPython for the Pico Plus 2 W (the build "with wireless support",
   from Pimoroni's `pimoroni-pico-rp2350` releases): hold BOOT, plug in USB, copy the `.uf2`
   to the drive that appears.
2. Edit `channels.json` for your wiring, then copy `main.py` and `channels.json` to the
   board (Thonny, or `mpremote cp main.py channels.json :`). It restarts into the plugin
   and advertises as **RIG-MOTOR**.
3. In the deck: SET → MOTORS → on, then tap the **Motor** chip to pair.

Pimoroni calls the wireless support experimental: if nothing can find RIG-MOTOR, check
the board's REPL for errors first (`mpremote` or Thonny prints them).

## channels.json

One entry per motor, in the order you want the controls:

| type | wiring | settings |
|---|---|---|
| `scmd` | SparkFun Qwiic Motor Driver on the **Qw/ST port** (Qwiic cable; I2C0 = GP4/GP5) | `motor` 0 (A) / 1 (B), optional `addr` (default 0x5D), plus the DC settings below |
| `tb6612` | SparkFun TB6612FNG breakout: `pins: [pwm, in1, in2]` per motor, optional `stby` | the DC settings below |
| `dc` | any two-PWM-pin H-bridge (e.g. DRV8833) on `pins: [a, b]` | `max` % cap; optional `freq` (PWM Hz, default 20 kHz) |
| `stepper` | STEP / DIR driver (A4988, TMC2209…) on `pins: [step, dir]`, optional `en` | `speed` (steps/s at 100 %), `max` % cap |

Any of them can take `"rotate": true`: that's the motor the standard `Rotate` commands
drive (without one, the first motor). `Vibrate` drives the others.

DC settings for `scmd` and `tb6612`: `max` % cap; `min` %, the stall minimum (any motion is
lifted above it, so slow speeds still turn; find it by raising speed on the MOTOR tab until
the motor starts reliably); `kick` ms of full power when a motor starts or reverses, to break
static friction (0 = off). The Qwiic Motor Driver keeps its last speed if the Pico resets,
so the plugin stops it at boot, re-enables it if a current spike resets it, and reports
`E driver` if the I2C link drops. With a Qwiic driver, keep GP4 / GP5 free.

Pins come in PWM pairs (GP0/1, GP2/3, GP4/5 …) that share one frequency. A stepper's STEP pin
changes its pair's frequency as it speeds up, so don't put a DC motor on the other pin of
that pair (its DIR pin, which isn't PWM, is fine there).

Give motors their own supply (with a common ground to the Pico); never power them from the
Pico's 3V3 pin.

## Protocol

Text over the Nordic UART service; a command ends with `;` or a newline. Full details at
the top of `main.py`.

**Standard** (levels 0–20 = 0–100 %; a level holds until changed):

| command | does | answer |
|---|---|---|
| `Vibrate:<n>;` | every motor except the rotate one | `OK;` |
| `Vibrate1:<n>;` `Vibrate2:<n>;` | the 1st / 2nd of those | `OK;` |
| `Rotate:<n>;` | the rotate motor, current direction | `OK;` |
| `RotateClockwise:<n>;` `RotateCounterClockwise:<n>;` `RotateChange;` | set / flip its direction | `OK;` |
| `Battery;` | `BATTERY` in `main.py` (no battery sensing wired yet) | `100;` |
| `DeviceType;` | `DEVICE_TYPE` + the radio's MAC | `RIG:1:28CDC1…;` |
| `Air…`, `Light…`, anything else | not on this node | `ERR;` |

**The deck's own:** `?` (report), `V` (hand control), `K` (keepalive), `P` (store a pattern),
`M` (play one), `X` (STOP). The deck stores one pattern per linked lighting mode here, so
motion keeps running smoothly by itself; a standard command takes over from it.

Apps that recognise devices by a particular name prefix or `DeviceType;` answer need `NAME`
and `DEVICE_TYPE` (top of `main.py`) set to what they expect.

## Safety

- **STOP** on the MOTOR tab (`X`) halts everything at once, patterns and standard levels too.
- Everything stops when the controlling phone or app disconnects.
- The deck's hand control also stops by itself 1.5 s after the deck stops sending (let go,
  lost signal, phone locked). Standard levels hold until changed, as apps expect.
- Motors never run above their `max`.
