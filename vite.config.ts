import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  server: {
    port: 5173,
    proxy: {
      // Regex so /api/foo proxies but the source file /api.ts does not.
      '^/api/': `http://localhost:${serverPort}`,
      // Agent-discovery files served at root by the Express server.
      '^/llms\\.txt$': `http://localhost:${serverPort}`,
      '^/agents\\.md$': `http://localhost:${serverPort}`,
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
});
