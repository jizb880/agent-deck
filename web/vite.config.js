import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.BACKEND || 'http://127.0.0.1:4173';

// In dev, Vite serves the UI on :5173 and proxies API + WS to the backend so
// there is a single origin from the browser's point of view.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
