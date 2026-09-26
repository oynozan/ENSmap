import { loadEnv as parseEnv, workspaceRoot } from '@ensmap/core/config';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The root .env and process.env, read here in Node and never exposed to the client
  const env = parseEnv(loadEnv(mode, workspaceRoot(), 'ENSMAP_'));
  return {
    plugins: [react()],
    server: {
      port: env.ENSMAP_WEB_PORT,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${env.ENSMAP_API_PORT}`,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    worker: { format: 'es' },
  };
});
