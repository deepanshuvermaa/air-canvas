import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'bootstrap': resolve(__dirname, 'src/content/bootstrap.ts'),
        'popup': resolve(__dirname, 'src/popup/popup.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        // Each entry must be self-contained (no shared chunks)
        // because Chrome extensions load each script independently
        manualChunks: undefined,
      },
    },
  },
});
