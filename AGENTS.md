# AGENTS.md: context for AI sessions on the cyber rig

Read this first. It says what the project is, how it's laid out, the versions it's pinned
to, and the rules that apply to every change. The learning side (stage logs, exercises,
quizzes) lives in a separate repo, `cyber-rig-lab`, next to this one.

## What it is

A wearable "cyber rig" controlled from a phone: a Vite PWA (the **deck**) using Web
Bluetooth, plus firmware for each device. Guests at a party join from their own phones
through a relay.

```
Phone (deck) ──BLE──► CLUE watch (CircuitPython) ──BLE──► mask L + R (Circuit Playground Bluefruit)
             ──BLE──► SpotLED hat · Sphero BOLT · LilyGO T5 e-ink badge · Pico motor plugin
Guests' phones ──HTTPS──► relay (Cloudflare Worker + Durable Object) ──SSE──► deck
```

## Modules

| Module | Deck code | Firmware / server | Status |
|---|---|---|---|
| Deck core: Bluetooth layer, rig state, views | `src/ble/device.js`, `src/rig.js`, `src/config.js`, `src/main.js`, `index.html` | | to restructure |
| Lights: CLUE + mask | `src/ble/clue.js`, `src/recipes.js`, `src/cycle.js` | `firmware/src/rig.py` -> `firmware/CLUE/rig.mpy`; `firmware/src/leds.py` | to restructure |
| Hat + BOLT | `src/ble/spotled.js`, `src/ble/bolt.js`, `src/drive.js`, `src/image.js` | | to restructure |
| Badge | `src/badgetab.js`, `src/ble/badge.js` | `firmware/BADGE/badge/badge.ino` | to restructure |
| Guests | `guest.html`, `src/guest.js`, `src/guests.js`, `src/i18n.js` | `worker/relay/` | to restructure |
| **Motors** | **`src/motors/`** (see its README) | **`firmware/MOTOR/`** | **restructured: the template** |
| Hosting | | `worker/site.js`, `wrangler.jsonc` (deck. + jack.), `wrangler.ap.jsonc` (ap.: the afterparty deck), `docs/deploy.md` | |
| **Plugins** | **`src/plugins/`** (registry, API, motion feed; see its README); private ones in `src/private/` (git-ignored; dev server and the `ap.` build only) | | **new: step 1 of the plugin system** |

The motor module is the pattern for the others: one folder per module, a README, pure logic
separated from Bluetooth and from the page, a controller that the rig owns, and UI parts that
share a small context. The plan for the rest is in `docs/restructure-plan.md`.

## Pinned versions

| Part | Version |
|---|---|
| Node / Vite / vite-plugin-pwa / wrangler | Node 24.20, Vite 8.3, vite-plugin-pwa 2.0, wrangler 4.156 |
| CLUE, Bluefruits, Express | CircuitPython 9.2.9; `rig.py` compiled with mpy-cross 9.2.9 (too big to compile on the CLUE) |
| Motor plugin | Pimoroni MicroPython 1.29 for the Pico Plus 2 (wireless build) |
| Badge | Arduino: ESP32 core 2.0.17, LilyGo-EPD47 1.1.0, NimBLE 2.5.2 (`firmware/BADGE/build.ps1`) |

## Rules for every change

- **Test locally first** (`npm run dev`, Chrome on the PC; Web Bluetooth needs localhost or HTTPS).
- **Deploy only when the owner says "deploy"** (`npm run deploy`: the site and the relay;
  `npm run deploy:ap`: the afterparty deck at ap., with the private plugins and no guests).
- **No git pushes** unless asked. The repo will be cleaned up before it goes public.
- **No secrets in the repo or the site's code.** The deck site is public, so anything in its
  JavaScript is readable. Device passwords go in the phone's local storage and in a
  `secrets.json` on each board, left out of git.
- **Guests are untrusted.** Everything from the relay is checked in `src/guests.js` (token,
  permission, operator turn, caps). Names and text from guests or devices go into the page
  with `textContent`, never `innerHTML`.
- **Safety never unlocks:** motor STOP, the 1.5 s auto-stop and the speed caps hold for
  everyone, including in the hack game.
- **Firmware:** recompile `rig.mpy` after editing `rig.py`. Keep each board's protocol in
  step with its deck driver (`src/ble/*.js`, `src/motors/ble.js`).
- **The BLE sniffer stays home:** capture only your own devices, never at a party.
