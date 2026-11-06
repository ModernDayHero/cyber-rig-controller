// The plugin API: what a plugin's setup(api) gets. Everything a plugin creates through it
// (panels, chips, listeners, timers, the mic) is tracked, so switching the plugin off
// removes all of it, even if the plugin's own dispose() forgets something.

import { MotionFeed } from './feed.js';

export function createApi({ rig, $, segPick, segShow, showBanner, manifest }) {
  const id = manifest.id, cleanups = [];
  const track = (fn) => { cleanups.push(fn); return fn; };
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    track(() => target.removeEventListener(type, fn, opts));
  };
  const STORE = `rig-plugin-${id}`;
  let feed = null;

  const api = {
    id,
    manifest,
    /** A message in the deck's banner. */
    banner: (msg) => showBanner(msg),

    /** The plugin's own settings, kept on this phone. */
    storage: {
      get(defaults = {}) { try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE)) }; } catch { return { ...defaults }; } },
      set(value) { try { localStorage.setItem(STORE, JSON.stringify(value)); } catch {} },
    },

    ui: {
      $, segPick, segShow,
      /** A fold in SET, under PLUGINS. Returns its body; write the panel into it. */
      panel(title, note = '') {
        const fold = document.createElement('details');
        fold.className = 'fold';
        fold.dataset.fold = `plugin-${id}`;
        const summary = document.createElement('summary');
        summary.textContent = title;
        if (note) summary.append(' ', Object.assign(document.createElement('small'), { textContent: note, style: 'opacity:.6' }));
        const body = Object.assign(document.createElement('div'), { className: 'fold-body' });
        fold.append(summary, body);
        const anchor = $('pluginPanels');
        anchor.append(fold);
        track(() => fold.remove());
        body.reveal = () => { fold.open = true; fold.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
        return body;
      },
      /** A status chip with the devices' (top of the deck). set('connected'|'connecting'|'idle'). */
      chip(label, title, onTap) {
        const el = document.createElement('button');
        el.className = 'dev';
        el.dataset.key = `plugin-${id}`;
        el.dataset.s = 'idle';
        el.innerHTML = '<span class="dot"></span><span></span>';
        el.lastChild.textContent = label;
        if (title) el.title = title;
        if (onTap) el.addEventListener('click', onTap);
        $('status').append(el);
        track(() => el.remove());
        return { el, set: (s) => { el.dataset.s = s; } };
      },
    },

    /** Events: 'change' (rig state), 'shake' (CLUE), 'stop' / 'resume' (the MOTOR tab's
     *  STOP / RESUME), 'hidden' (the page is hidden or closing: stop outputs at once). */
    on(type, fn) {
      if (type === 'change') return listen(rig, 'change', (e) => fn(e.detail));
      if (type === 'shake') return listen(rig.clue, 'shake', (e) => fn(e.detail));
      if (type === 'stop') return listen(rig, 'stopall', () => fn());
      if (type === 'resume') return listen(rig, 'resumeall', () => fn());
      if (type === 'hidden') {
        listen(document, 'visibilitychange', () => { if (document.hidden) fn(); });
        return listen(window, 'pagehide', () => fn());
      }
      throw new Error(`plugin ${id}: no event '${type}'`);
    },

    /** A repeating timer, cleared when the plugin is switched off. */
    every(ms, fn) {
      const t = setInterval(fn, ms);
      track(() => clearInterval(t));
      return t;
    },

    /** The rig's motion as live left / right levels (feed.js). One per plugin. */
    motion() {
      if (!feed) {
        feed = new MotionFeed(rig, id);
        track(() => feed.idle());
      }
      return feed;
    },

    /** The rig itself, for what the API doesn't cover yet (e.g. rig.motor for the Pico).
     *  Prefer the API: it's what stays stable. */
    rig,
  };

  return {
    api,
    /** Undo everything the plugin set up through the API (last first). */
    cleanup() { while (cleanups.length) { try { cleanups.pop()(); } catch (e) { console.warn(`[plugin ${id}] cleanup`, e); } } },
  };
}
