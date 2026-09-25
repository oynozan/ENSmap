import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    setupFiles: [new URL('./vitest.setup.ts', import.meta.url).pathname],
  },
});
