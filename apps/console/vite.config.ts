import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_PROXY_TARGET = process.env.ISPACE_BASE_URL ?? 'http://localhost:3100';

export default defineConfig({
  plugins: [react()],
  // 控制台挂在 /console 下
  base: '/console/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // 本地单独启动 console 时，API 仍由 deploy-service:3100 提供。
    proxy: { '/deploy': { target: DEV_PROXY_TARGET, changeOrigin: true } },
  },
});
