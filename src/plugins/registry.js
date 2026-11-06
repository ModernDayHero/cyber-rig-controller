// The plugin registry: finds plugins, switches them on and off, and runs SET -> PLUGINS.
//
// A plugin is a folder with an index.js that exports:
//   manifest = { id, name, version, profile: 'party' | 'afterparty', needs: [...],
//                guests: false, description, default: false }
//   setup(api)  -> optional { dispose() }        (api.js: what a plugin can use)
//
// Where plugins come from:
//   built-in   src/plugins/builtin/<name>/index.js   in the repo and the public build
//   private    src/private/<name>/index.js           git-ignored; dev server and the ap. build only
// Guests never see plugins: the guest page doesn't load this file.

import { createApi } from './api.js';

const STORE = 'rig-plugins';            // { id: true | false }: which are switched on

function loadEnabled() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }

export async function setupPlugins(helpers) {
  const { $ } = helpers;
  const sources = [
    ['built-in', import.meta.glob('./builtin/*/index.js')],
  ];
  // Private plugins: the dev server and npm run build:ap (ap.steamworkz.net, behind its own
  // login). In the public build __PRIVATE__ is false, so this whole branch is dropped.
  if (__PRIVATE__) sources.push(['private', import.meta.glob('../private/*/index.js')]);

  const plugins = [];                   // { manifest, source, module, running }
  for (const [source, found] of sources) {
    for (const [path, load] of Object.entries(found)) {
      try {
        const module = await load();
        const manifest = module.manifest;
        if (!manifest?.id || typeof module.setup !== 'function') {
          console.warn(`[plugins] ${path}: needs a manifest with an id, and setup(api)`);
          continue;
        }
        if (plugins.some((p) => p.manifest.id === manifest.id)) {
          console.warn(`[plugins] ${path}: id '${manifest.id}' is taken`);
          continue;
        }
        plugins.push({ manifest, source, module, running: null });
      } catch (e) {
        console.warn(`[plugins] couldn't load ${path}`, e);
      }
    }
  }

  const enabled = loadEnabled();
  const isOn = (p) => enabled[p.manifest.id] ?? !!p.manifest.default;

  function start(p) {
    if (p.running) return;
    const { api, cleanup } = createApi({ ...helpers, manifest: p.manifest });
    try {
      const handle = p.module.setup(api) || {};
      p.running = { handle, cleanup };
    } catch (e) {
      cleanup();
      helpers.showBanner(`Plugin ${p.manifest.name} couldn't start: ${e.message}`);
      console.error(`[plugins] ${p.manifest.id}`, e);
    }
  }
  function stop(p) {
    if (!p.running) return;
    try { p.running.handle.dispose?.(); } catch (e) { console.warn(`[plugins] ${p.manifest.id} dispose`, e); }
    p.running.cleanup();
    p.running = null;
  }
  function set(p, on) {
    enabled[p.manifest.id] = on;
    try { localStorage.setItem(STORE, JSON.stringify(enabled)); } catch {}
    if (on) start(p); else stop(p);
    render();
  }

  // ---- SET -> PLUGINS
  function render() {
    $('pluginNone').hidden = plugins.length > 0;
    $('pluginList').replaceChildren(...plugins.map((p) => {
      const m = p.manifest, row = document.createElement('div');
      row.className = 'plugin';
      const info = document.createElement('div');
      const title = Object.assign(document.createElement('strong'), { textContent: m.name || m.id });
      const tags = Object.assign(document.createElement('span'), { className: 'hint' });
      tags.textContent = ` v${m.version ?? '?'} · ${p.source.toUpperCase()} · ${(m.profile || 'party').toUpperCase()}`;
      info.append(title, tags);
      if (m.description) info.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: m.description }));
      if (m.needs?.length) info.append(Object.assign(document.createElement('div'), { className: 'hint', textContent: `uses: ${m.needs.join(', ')}` }));
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [on, label] of [[true, 'ON'], [false, 'OFF']]) {
        const b = Object.assign(document.createElement('button'), { textContent: label });
        b.classList.toggle('on', !!p.running === on);
        b.addEventListener('click', () => set(p, on));
        seg.append(b);
      }
      row.append(info, seg);
      return row;
    }));
  }

  for (const p of plugins) if (isOn(p)) start(p);
  render();
  return { plugins, set: (id, on) => { const p = plugins.find((x) => x.manifest.id === id); if (p) set(p, on); } };
}
