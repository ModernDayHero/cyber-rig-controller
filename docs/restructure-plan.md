# Restructure plan

The rig grew fast and in one piece. This plan breaks it into modules, one at a time, using
the motor module (`src/motors/`) as the template. Nothing here changes behaviour: each step
moves and tidies code, then is checked against the same behaviour as before.

## The template (done: motors)

1. **One folder per module**, with a README: what it is, how the parts fit, its protocol,
   known issues.
2. **Pure logic on its own** (`motions.js`): data and maths, no Bluetooth, no page, so it can
   be tested and quizzed on its own.
3. **A controller the rig owns** (`rig.motors`): the module's behaviour, out of `rig.js`.
4. **UI parts that share a small context** (`ui/*.js` + `index.js`), each with its own render.
5. **Checked the same as before:** the same commands to the device for the same actions, and
   the same screens.

Motors went from `src/motors.js` (963 lines) + 250 lines in `rig.js` to nine files of
27–297 lines; `rig.js` went from 724 to 466 lines.

## Next, in order

| # | Module | What moves | The big split |
|---|---|---|---|
| 1 | **Guests** | `guest.html`, `src/guest.js`, `src/guests.js`, `src/i18n.js`, `worker/relay/` -> `src/guests/`, `worker/relay/` | `guests.js` (683): host / invites / permissions / turns / runners log. `i18n.js` (799): words per language into one file each. Highest security value: it faces untrusted guests. |
| 2 | **Deck core** | `src/ble/device.js`, `src/rig.js`, `src/config.js`, `src/main.js`, `index.html` | `main.js` (993): one setup file per tab, like the motor UI. `index.html` (856): tab sections into templates. |
| 3 | **Lights** | `src/ble/clue.js`, `src/recipes.js`, `src/cycle.js` -> `src/lights/`; `firmware/src/` | `rig.py` (1,794) into modules. Watch the CLUE's RAM: each compiled module costs RAM on CircuitPython, so measure free memory after each step. |
| 4 | **Hat + BOLT** | `src/ble/spotled.js`, `bolt.js`, `drive.js`, `image.js` -> `src/hat/`, `src/bolt/` | `spotled.js` (950): the hat protocol vs its pictures and clock. |
| 5 | **Badge** | `src/badgetab.js`, `src/ble/badge.js`, `firmware/BADGE/` -> `src/badge/` | Small already: mostly a move. |

Hosting (`worker/site.js`, `wrangler.jsonc`) stays as it is.

## Firmware

- **Motor plugin:** `firmware/MOTOR/main.py` (790) stays one file until the Bluetooth update
  can send several files (then: drivers, protocol, patterns, update, status LED).
- **CLUE:** splitting `rig.py` changes RAM use; measure before and after every step.

## Before anything goes public

- Run gitleaks over the whole history.
- Remove personal details: domains, names, device addresses, guest data, the relay topic.
- Fix the motor board's open update path (security review, High).
- Check the README and each module README rebuild from nothing on a clean machine.
