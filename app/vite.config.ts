import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    // AM_API 可指向别的实例（联调/临时测试用），默认连本机 8787
    proxy: { '/api': process.env.AM_API || 'http://127.0.0.1:8787' }
  }
});
