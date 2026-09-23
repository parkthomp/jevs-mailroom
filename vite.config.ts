import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Follow the same PORT the server reads from .env so a custom port still proxies in development.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const port = Number(env.PORT) || 3001;
  return {
    plugins: [react()],
    build: { outDir: 'dist/client' },
    server: {
      port: 5173,
      proxy: {
        '/api': `http://127.0.0.1:${port}`,
        '/ws': { target: `ws://127.0.0.1:${port}`, ws: true },
      },
    },
  };
});
