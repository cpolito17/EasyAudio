import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('lamejs')) return 'encoder';
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
  worker: { format: 'es' },
});
