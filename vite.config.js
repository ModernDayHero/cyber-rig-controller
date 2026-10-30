import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served as a GitHub Pages project site: https://<user>.github.io/cyber-rig-controller/
// For a custom domain at the root later, build with BASE=/ and add public/CNAME.
const base = process.env.BASE || '/cyber-rig-controller/';

export default defineConfig({
  base,
  // Two pages: the deck itself, and guest.html, which friends open from the invite QR.
  build: { rollupOptions: { input: { main: 'index.html', guest: 'guest.html' } } },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['octlet.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'STEAMWorkz Cyber Deck',
        short_name: 'Cyber Deck',
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
});
