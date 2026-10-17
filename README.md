# Cyber Rig Controller

Phone controller for the cyber rig lighting (Pro tier). A Web Bluetooth PWA for
Chrome on the S24 Ultra, hosted on GitHub Pages at **steamworkz.net**.

```
Phone ──BLE──▶ SpotLED cap
      ──BLE──▶ Sphero BOLT
      ──BLE──▶ CLUE ──BLE──▶ Mask Bluefruit L + R
```

The phone only sends mode changes. Every device runs its own animations and keeps
its last mode if a link drops. Spec: `claude/cyber-rig-lighting.md` in the project.

## Develop (VS Code)

```bash
npm install
npm run dev        # http://localhost:5173 on the PC
```

`localhost` counts as a secure context, so Web Bluetooth works on the PC in Chrome.
To test on the phone, either:

- plug it in over USB and use `chrome://inspect` → **Port forwarding** `5173 → localhost:5173`, then open `http://localhost:5173` on the phone, or
- push to `main` and test the deployed HTTPS site.

`npm run build` → `dist/`, `npm run preview` to check the production build.

## Deploy

1. Create a public GitHub repo and push this folder to `main`.
2. Repo **Settings → Pages → Source: GitHub Actions**. The workflow in
   `.github/workflows/deploy.yml` builds and deploys on every push.
3. Custom domain: `public/CNAME` already says `steamworkz.net`. At your DNS provider
   add the four GitHub Pages `A` records for the apex (and a `CNAME` for `www` →
   `<user>.github.io`), then tick **Enforce HTTPS** in the Pages settings.

`CNAME` claims the whole domain for this repo. If steamworkz.net will also host the
Octlet game or other pages, move the controller to a sub-path (`base: '/rig/'` in
`vite.config.js`, plus `start_url`/`scope`) or a subdomain such as `rig.steamworkz.net`.

### NAS mirror

```bash
git clone https://github.com/<user>/cyber-rig-controller.git
cd cyber-rig-controller && npm ci && npm run build   # serve dist/ over HTTPS
git pull && npm run build                             # to update
```

## On the phone

- Chrome, not Samsung Internet. Open the site, then **Add to home screen**.
- Battery → Background usage limits → Chrome in **Never sleeping apps**.
- Location and Nearby devices permissions on for Chrome.
- Force-close the SpotLED app first: the cap accepts one connection.
- Start of night: tap **Connect** three times (Cap, BOLT, CLUE), one picker each.
  Tap a device chip to reconnect just that one.

## Layout

| File | What it does |
|---|---|
| `src/config.js` | Modes, palette, command strings (`M`, `B`, `H`, `S`, `T`, `P`) |
| `src/rig.js` | State, persistence, fan-out to devices |
| `src/ble/device.js` | Shared connect / auto-reconnect / status logic |
| `src/ble/clue.js` | CLUE over Nordic UART; relays to the mask, reports watch picks + mask links |
| `src/ble/bolt.js` | Sphero v2 packets (ported from `spherov2`), keep-alive |
| `src/ble/spotled.js` | SpotLED transfer protocol (ported from `python-spotled`) |
| `src/main.js` | UI wiring, wake lock |

## Status

| Device | State |
|---|---|
| CLUE | Ready to test. Firmware must advertise as `RIG-CLUE…` and use the line format in `clue.js` |
| BOLT | Ported from `spherov2`, untested. Shows a solid mode colour for now |
| Cap | Transport + brightness ported, untested. **Animation frame encoding is TODO** |

### Firmware contract for the CLUE (proposed)

- Advertise name starting `RIG-CLUE`, Nordic UART service.
- Accept newline-terminated lines: `M0`–`M5` (Glitch arrives as `M1 S<seed>`),
  `B10`–`B100`, `H0`/`H1`, `P0`/`P1`/`P2`. Relay each to both Bluefruits.
- Send back: `M<n>` when a mode is picked on the watch, `L0`/`L1` and `R0`/`R1`
  when the left/right Bluefruit link drops or comes up.

## Next

1. CLUE firmware against the contract above, then test CLUE + mask end to end.
2. Verify BOLT UUIDs/commands on hardware.
3. SpotLED: confirm the hat's GATT layout in nRF Connect, port `AnimationData`/`FrameData`
   and `gen_color_bitmap`, build one animation per mode. The hat has no "play preset N"
   command, so each mode change uploads that mode's frames.
