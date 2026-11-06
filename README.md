# STEAMWorkz Cyber Deck

The phone deck that runs the STEAMWorkz cyber rig. A Web Bluetooth PWA for Chrome on
Android, served from Cloudflare at deck.steamworkz.net (guests: jack.steamworkz.net);
see docs/deploy.md.

```
Phone ──BLE──▶ CLUE (watch) ──BLE──▶ Rebreather mask, left + right (Circuit Playground Bluefruit ×2)
      ──BLE──▶ SpotLED hat (32x16)
      ──BLE──▶ Sphero BOLT (8x8)
```

The CLUE owns the mask and is the source of truth: the page sends it commands and
takes its reports back, so presses on the watch, the random hack and pad-0 standby
all show up on the phone. The hat and BOLT follow the rig's look or show their own
content from their tabs. Every device keeps animating on its own if a link drops.

**Rig visualizers:** design-time sims and renders of the rig (rig sim, 3D headgear
configurator, respirator concept, Byte vs BUG.EXE) live in `public/viz/` and are served at
`https://deck.steamworkz.net/viz/`.

## Tabs

| Tab | What it does |
|---|---|
| **RIG** | STEAMWorkz OS set (Dark, Glitch, Rainfall, Matrix) and ALT set (VU, Rainbow, Rebreather, Hack). Rebreather colour pickers, Rainbow speed / width / flow, purge, standby, shut down. |
| **BOLT** | Follow the rig, or show a look / colour / scrolling text / uploaded image or GIF (8x8, 16 colours). Shake to purge a hack, sensitivity, brightness. |
| **HAT** | Follow the rig, or upload a PNG / JPEG / GIF (32x16, 256 colours, up to 20 frames) with fit, dithering, transition effect and frame time. Rainfall lightning amount, flip / mirror, brightness. |

## Project layout

`AGENTS.md` maps the modules, pinned versions and the rules for every change; the motor
module (`src/motors/`) is the restructured template, and `docs/restructure-plan.md` is the
plan for the rest. The learning side (stage logs, exercises, quizzes) is the separate
`cyber-rig-lab` repo.

## Learning notes

Background and ideas from building the rig (BLE, security, mesh networks, animations as
data, the hack game): `docs/learning/ble-security-and-animations.md`.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/
```

`localhost` counts as a secure context, so Web Bluetooth works in Chrome on the PC.
`npm run build` → `dist/`, `npm run preview` to check the production build.

## Deploy

`npm run deploy` builds and deploys the site (`wrangler.jsonc`) and the guest relay
(`worker/relay`) to Cloudflare. Test with `npm run dev` first. Details: `docs/deploy.md`.

## On the phone

- Chrome, not Samsung Internet. Open the site, then **Add to home screen**.
- Battery → Background usage limits → Chrome in **Never sleeping apps**.
- Location and Nearby devices permissions on for Chrome, or the Bluetooth picker is empty.
- Close the SpotLED app first: the hat accepts one connection.
- Tap each status chip once (CLUE, Hat, BOLT) and pick the device. Chrome remembers them.

## Devices

### CLUE (`RIG-CLUE`, Nordic UART, text lines)

| Phone → CLUE | |
|---|---|
| `M <os\|alt> <i>` | pick a mode (index into the set) |
| `C r g b r g b` | rebreather colours (switches to Rebreather) |
| `R speed width dir` | rainbow settings: speed 5–250 (50 = 1x), width 5–200, dir 1/0 |
| `P standby\|off\|wake` | power |
| `H` / `K` / `?` | start the hack / purge it / report everything |

CLUE → phone, on every change: `M <set> <i>`, `C …`, `R …`, `P on|waking|blink|off`,
`V 0|1` (hacked: M and C are refused, K still purges), `L <left> <right>` (mask links, 0|1 each), `E <why>`.

### SpotLED hat (`SpotLED_2986`)

32x16, full colour, **one byte per pixel, RGB323** (`rrr gg bbb`), frame limit 20,
120-byte transfer buffer. Protocol from `python-spotled`, but notifications start
with the length byte (the library's 3 leading bytes are a Linux gattlib artefact).
The hat drops idle links, so the page connects per upload and lets go ~8 s later.
Uploads take ~0.35 s per frame.

### Sphero BOLT (`SB-…`)

Sphero v2 API, ported from `spherov2`: targeted packets carry the source id, and
writes go in 20-byte pieces, waiting for each response. Each look is an 8x8
animation uploaded once and looped by the BOLT. Collision events = shake.

## Layout

| File | What it does |
|---|---|
| `src/config.js` | Mode sets, palette, phone ↔ CLUE commands |
| `src/rig.js` | State, persistence, CLUE reports, BOLT / hat fan-out |
| `src/image.js` | Image / GIF decoding and conversion for the BOLT and hat |
| `src/ble/device.js` | Shared connect / auto-reconnect / status |
| `src/ble/clue.js` | CLUE link |
| `src/ble/bolt.js` | BOLT packets, animations, text, shake |
| `src/ble/spotled.js` | Hat transfer, RGB323, the rig looks (Octlet logo, rain, virus…) |
| `src/main.js` | UI wiring, wake lock |
| `firmware/` | CircuitPython 9.x for the CLUE and both mask Bluefruits; see `firmware/README.txt` and `firmware/src/BUILD.txt` |
