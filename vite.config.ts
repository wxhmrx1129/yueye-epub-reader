import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { output: { manualChunks: {
    'react-vendor': ['react', 'react-dom'],
    'epub-engine': ['epubjs/lib/epubcfi', 'fflate', 'dompurify'],
    storage: ['dexie'],
  } } } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.ts'] },
});
