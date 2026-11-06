import { networkInterfaces } from 'node:os';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Testing guests from a phone: the deck runs on localhost (Web Bluetooth needs it), but
// the phone can't open localhost, so dev guest links / QRs use this PC's Wi-Fi address.
// LAN_HOST=... overrides the guess (it skips VirtualBox / Hyper-V adapters).
const lanHost = process.env.LAN_HOST || Object.entries(networkInterfaces())
  .filter(([name]) => !/virtual|vethernet|vmware|loopback|wsl/i.test(name))
  .flatMap(([, list]) => list)
  .find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))?.address || '';


// Two builds:
//   npm run build      dist/     the public deck (deck. / jack.): the deck + guest.html
//   npm run build:ap   dist-ap/  the afterparty deck (ap., behind its own login): the deck
//                                + the private plugins (src/private/), no guests
// The dev server has the private plugins too, and guests.
export default defineConfig(({ command, mode }) => {
  const base = process.env.BASE || '/';   // the site root
  const ap = mode === 'ap';
  return {
  base,
  define: {
    __LAN_HOST__: JSON.stringify(lanHost),
    __AP__: JSON.stringify(ap),                          // no guests on this build
    __PRIVATE__: JSON.stringify(ap || command === 'serve'),   // load src/private/ plugins
  },
  build: {
    outDir: ap ? 'dist-ap' : 'dist',
    // The public build: the deck itself, and guest.html, which friends open from the invite QR.
    rollupOptions: { input: ap ? { main: 'index.html' } : { main: 'index.html', guest: 'guest.html' } },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['octlet.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        id: ap ? '/?ap' : '/',      // installs as its own app next to the deck
        name: ap ? 'STEAMWorkz Cyber Deck AP' : 'STEAMWorkz Cyber Deck',
        short_name: ap ? 'Deck AP' : 'Cyber Deck',
        description: 'The deck that runs the STEAMWorkz cyber rig',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'any',          // portrait or turned sideways (landscape layout)
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is precached and served cache-first, so the page opens
        // offline (and never hits a login redirect) once installed.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: `${base}index.html`,
        // The rig visualizers are separate pages: not precached, never answered with the app.
        globIgnores: ['viz/**'],
        navigateFallbackDenylist: [/\/viz\//],
      },
    }),
  ],
};
});
