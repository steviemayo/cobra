import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The gateway serves this build at /room/:id and its assets at /assets/*.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } } },
});
