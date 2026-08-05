import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 控制台挂在 /console 下
  base: '/console/',
  build: { outDir: 'dist', emptyOutDir: true },
});
