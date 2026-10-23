import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Collaboration server behind the /ws proxy (override for tests or a non-default port).
const serverUrl = process.env.SMARTCITY_SERVER_URL ?? 'ws://localhost:8780';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5280,
    proxy: {
      '/ws': { target: serverUrl, ws: true },
    },
  },
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Vendor chunks stay cached across app changes.
        manualChunks(id: string) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
});
