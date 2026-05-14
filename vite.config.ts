import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  server: {
    port: 5173,
    proxy: {
      // Regex so /api/foo proxies but the source file /api.ts does not.
      '^/api/': 'http://localhost:3001',
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
