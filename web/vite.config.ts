import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // App shell is cached so the app opens courtside with no signal; data sync is handled in src/api.ts.
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Courtside',
        short_name: 'Courtside',
        description: 'Court queues for badminton groups',
        theme_color: '#5980a6',
        background_color: '#f2f2f3',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // Barlow comes from Google Fonts; keep a copy so the app still looks right offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
