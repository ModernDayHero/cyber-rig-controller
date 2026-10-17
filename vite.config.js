import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served from the root of steamworkz.net (see public/CNAME).
// If you move the controller under a sub-path (e.g. /rig/), set base: '/rig/'.
export default defineConfig({
  base: '/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Cyber Rig Controller',
        short_name: 'Rig',
        description: 'Mode controller for the cyber rig lighting',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App shell is precached and served cache-first, so the page opens
        // offline (and never hits a login redirect) once installed.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
});
