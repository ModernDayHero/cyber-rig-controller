# Learning notes: BLE, security and animations as data

Notes from building the rig, kept for later and for the Instructable write-up. These are
ideas and background, not decisions; where something is already built, it says so.

- [1. Animations as data, and RAM](#1-animations-as-data-and-ram)
- [2. UART services: "gen 1 vs gen 2"](#2-uart-services-gen-1-vs-gen-2)
- [3. BLE first principles](#3-ble-first-principles)
- [4. How mesh networks protect themselves](#4-how-mesh-networks-protect-themselves)
- [5. Ways a device can prove it's you](#5-ways-a-device-can-prove-its-you)
- [6. A hack game with safe rules](#6-a-hack-game-with-safe-rules)
- [7. Security review: the motor board's open update path](#7-security-review-the-motor-boards-open-update-path)

---

## 1. Animations as data, and RAM

**Already built:** the mask Bluefruits mostly don't hold animations as code. They have a
small engine with 8 building blocks (FILL, CHASE, WAVE, DRIP, PULSE, SPARKLE, HALF, SWEEP).
The deck sends each animation as a **recipe**: up to 4 layers of 14 bytes, passed on by the
CLUE and kept in the Bluefruits' NVM. Glitch, Rainfall, Scanner, Netrun, Neon and the
holiday looks are all recipes (`src/recipes.js`; the layer format is at the top of
`firmware/src/leds.py`).

So a **new animation built from existing blocks needs no firmware update**. Only a new
*block*, or one of the remaining built-in states (Dark, rainbow, rebreather, VU, sign off),
does.

**RAM:** the ANIMATIONS picker (SET) only hides tiles and tells the CLUE which modes the
watch steps through; it doesn't free memory. On CircuitPython, compiled code is loaded into
RAM, so RAM only drops when code is left out. Two ways to make "fewer animations" really
save RAM:

- **Turn the remaining built-ins into recipes too:** the boards become an engine plus a
  recipe store ("let the Bluefruits figure it out from a known value").
- **More general building blocks,** so future ideas never need an update, e.g. one
  "timeline" block (per-pixel colour keyframes) or a tiny step-by-step instruction format.
  Trade-off: the more general the engine, the more RAM / CPU the engine itself costs.
  Eight blocks is a decent middle; one timeline block would cover most of what's left.

## 2. UART services: "gen 1 vs gen 2"

Lovense devices (worth checking against Buttplug.io's device list, this is from memory):
older ones use a custom UART service `0000fff0-…`; newer ones use the **Nordic UART
Service** (`6e400001-b5a3-f393-e0a9-e50e24dcca9e`) or Lovense-specific services shaped
`xx300001-…-4bd4-bbd5-a6920e4c5653`.

They're the same idea as ours: text commands on a write characteristic, replies on a
notify characteristic, **no authentication**. None is "more robust" for security. Nordic
UART is the de facto standard, so the rig is already on the right one. Robustness comes
from what's built on top:

| Layer on top | Rig example |
|---|---|
| Framing (where a command ends) | newline or `;` |
| Acknowledgements | the update's `A <seq>` every 8 pieces |
| Checksums | CRC-32 on firmware updates |
| Authentication | challenge and answer (section 5), not built yet |

A device **name** filter (e.g. `namePrefix: 'LVS-'` in Web Bluetooth) is not security: any
device can call itself anything. It only tidies the picker.

## 3. BLE first principles

| Layer | What it does | Security angle |
|---|---|---|
| **GAP** (advertising, roles) | A peripheral advertises; a central connects. Names are broadcast text. | Names and addresses can be faked; never trust them. |
| **GATT** (services, characteristics) | Read, write, notify (no ack), indicate (acknowledged). MTU = how much fits in one packet. | A characteristic can require **encryption** or **authentication** before it accepts a write. |
| **Link layer** | Every packet has a checksum and is resent if lost. | Reliable, but **not private** unless the link is encrypted. |
| **Pairing** | Just Works, Passkey, Numeric Comparison, Out-of-Band (e.g. NFC). | Just Works can be intercepted. Passkey / Numeric Comparison with **LE Secure Connections** (elliptic-curve key exchange) is strong. |
| **Bonding** | Devices remember the agreed keys. | Reconnects are encrypted with no prompt. |
| **Privacy** | Changing private addresses. | Stops tracking; also why "allow this address" lists fail (phones change address). |

The rig's links are all unencrypted, Just-Works style, which is why its security has to
live in the app layer (section 5). Bonding support is patchy in MicroPython on the Pico's
radio and in CircuitPython, and would get in the way of the CLUE-to-mask links.

## 4. How mesh networks protect themselves

Bluetooth Mesh (Zigbee and Thread follow the same pattern):

**Separate keys for separate jobs**
- **NetKey:** encrypts and authenticates every packet on the network.
- **AppKeys:** one per job (the lights key can't open the locks).
- **DevKey:** unique to each device, only for configuring it.

**Defences**
- **Joining is authenticated:** a key exchange plus a code entered or scanned.
- **Sequence numbers:** every message counts up, so recorded messages can't be replayed.
- **Key refresh:** when a device is lost or thrown away (the "trashcan attack"), everyone
  else gets new keys and the old device is shut out.
- **Integrity tags (MIC):** tampered packets are rejected.

**Mapped onto the rig**

| Mesh idea | Rig version |
|---|---|
| DevKey | Each board's owner password: firmware, pin maps, calibration |
| NetKey | A shared rig key, so the CLUE and mask boards only obey each other |
| AppKey | A deliberately weak "game key" for the hack game (section 6) |
| Sequence numbers | Stop record-and-replay of commands |
| Key refresh | One tap to change keys after a lost device or a party |

## 5. Ways a device can prove it's you

| Option | How | Strength | Notes |
|---|---|---|---|
| **Fixed ID + password** (e.g. Bluefruit L: id `abc`, pw `123`) | Deck sends the password on connect | Weak | Sent in the clear: a cheap BLE sniffer records it once and replays it. Fine against guests with phone apps. |
| **Challenge and answer** (recommended) | Board sends a random number; deck answers with HMAC-SHA256(password, number) | Strong | Password never on air; a recorded answer is useless next time. Pico MicroPython has `hashlib`; CLUE needs a small library, RAM to check. |
| **Signed updates** | Deck signs firmware (HMAC / Ed25519); board installs only valid ones | Strongest for updates | Covers updates only. |
| **Physical access** | Updates only while a button is held, or in the first 30 s after power-on | Strong at a party | No passwords; pairs well with challenge and answer. |
| **BLE bonding with passkey** | System pairing prompt | Strong in theory | Patchy support on our boards (section 3). |
| ~~Name / address filter~~ | | None | Names fake easily; phones change addresses. |

**Where passwords live:** never in the website code (the deck site is public, so its
JavaScript is readable by anyone). Type each device's password once in the deck, kept in
the phone's local storage; on each board in a `secrets.json` left out of git. For the
Instructable, each builder picks their own and nothing secret ships in the repo.

## 6. A hack game with safe rules

The point of the rig is that it can be hacked, so the aim is to decide what a hacker can
win, not to lock everything:

| | Anyone in range (the game) | Game key (found / won) | Owner key |
|---|---|---|---|
| Play / stop patterns, `Vibrate:` / `Rotate:`, hand control | ✓ (within caps and auto-stop) | ✓ | ✓ |
| Take over the lights / motors for a turn | | ✓ | ✓ |
| Store patterns, calibration (flash writes) | | | ✓ |
| Firmware and `channels.json` updates | | | ✓ (+ power-on window) |

Safety rules that never unlock: STOP, the 1.5 s auto-stop, motor speed caps. The game key
could be crackable on purpose, printed on the badge, or a DEBUG prize.

## 7. Security review: the motor board's open update path

From the security review of the motor plugin (Nov 2026):

- **Finding (High):** `firmware/MOTOR/main.py` `update()` accepts `U` / `F` / `U!` from any
  BLE client in range, with no pairing or secret. Its checks (size, a CRC-32 the sender
  supplies, `compile()` / `json.load`) catch damaged transfers, not malicious ones. After
  `U!` the board swaps in the file and reboots, so anyone in range while the deck is
  disconnected could install their own firmware (ignoring STOP, the auto-stop and the caps)
  or rewrite the pin map. The deck can't tell, because the board reports its own CRC.
- **Fix planned:** owner key with challenge and answer for flash writes and updates, plus
  the power-on window for firmware (sections 5 and 6).
- **Checked clean:** the guest relay's topics, guest motor control (token, permission,
  operator turn, cap), DOM rendering (guest and device names via `textContent`), the
  invite link's code handling, and the CLUE's new commands.

### Debug "show every device" picker

Useful for finding a board that isn't advertising its name. Tie it to Vite's
`import.meta.env.DEV` (true only on the local dev server), never a hard-coded flag, so
`npm run build` can't ship it.
