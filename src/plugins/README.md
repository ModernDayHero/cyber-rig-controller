# Plugins

Self-contained add-ons for the deck: a device or bridge, its settings panel, a status chip,
and anything that follows the rig's motions. SET → PLUGINS switches each one on and off.

```
src/plugins/
  registry.js      finds plugins, switches them on / off, runs SET -> PLUGINS
  api.js           what a plugin gets (below); tracks everything it creates
  feed.js          the rig's motion as live left / right levels
  builtin/<name>/  built-in plugins: in the repo and the public build
src/private/<name>/  private plugins: git-ignored; the dev server and npm run build:ap (ap.) only,
                     never in the public build
```

Guests never see plugins: the guest page doesn't load the registry.

## Writing one

`<folder>/index.js` exports a `manifest` and `setup(api)`:

```js
export const manifest = {
  id: 'robot',                 // unique
  name: 'Robot controller',
  version: '0.1.0',
  profile: 'party',            // 'party' (PG) | 'afterparty' (private)
  guests: false,               // guests can't reach plugins (for now always false)
  needs: ['motion feed'],      // shown in SET -> PLUGINS
  description: 'Drives a two-wheel robot with the rig\'s motions.',
  default: false,              // on the first time it's found?
};

export function setup(api) {
  const body = api.ui.panel('ROBOT');                 // a fold in SET, under PLUGINS
  const chip = api.ui.chip('Robot', 'Robot controller', () => body.reveal());
  const feed = api.motion();                          // the rig's motion
  api.every(100, () => {
    const [left, right] = feed.sides();               // -100..100 each
    // ... send them to the robot
  });
  api.on('stop', () => { /* stop the robot */ });
  api.on('hidden', () => { /* page hidden or closing: stop at once */ });
  return { dispose() { /* close your own connections */ } };
}
```

## The API

| | |
|---|---|
| `api.ui.panel(title, note)` | a fold in SET; returns its body (`body.reveal()` opens and scrolls to it) |
| `api.ui.chip(label, title, onTap)` | a status chip; `chip.set('connected' \| 'connecting' \| 'idle')` |
| `api.ui.segPick / segShow / $` | the deck's own helpers |
| `api.on(type, fn)` | `'change'` (rig state), `'shake'` (CLUE), `'stop'` / `'resume'` (MOTOR tab), `'hidden'` (page hidden or closing) |
| `api.every(ms, fn)` | a timer |
| `api.motion()` | the motion feed: `sides()` → `[left, right]`, `now()` → `{ motion, key }`, `shake()`, `idle()` |
| `api.storage.get(defaults) / set(obj)` | settings kept on this phone |
| `api.banner(msg)` | a message in the deck's banner |
| `api.rig` | the rig itself, for what the API doesn't cover yet (prefer the API) |

Everything made through the API (panels, chips, listeners, timers, the mic) is removed when
the plugin is switched off, after its own `dispose()`.

## Safety rules for plugins

- Stop outputs on `'stop'` and `'hidden'`, and in `dispose()`.
- Never reach guests: don't add anything to the relay or the guest page.
- Keep caps and the rig's STOP above anything a plugin does.

## Not sandboxed

Plugins run in the deck page with full access (Web Bluetooth only works there). The API is
the intended surface and the cleanup is automatic, but a plugin is trusted code: only add
ones you wrote or have read.
