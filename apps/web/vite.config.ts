import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.AJWF_SERVER ?? 'http://localhost:8710';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5710, strictPort: true,
    proxy: {
      '/api': target,
      '/sprites': target,
      '/skill': target,
      '/heartbeat.md': target,
      '/mcp': target,
      '/healthz': target,
      '/og': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
