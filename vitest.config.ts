import { globSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const workspaceRoot = fileURLToPath(new URL('.', import.meta.url));
const setupFile = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));

// Every packages/* and apps/* directory becomes its own project. None has its
// own Vitest config, so extends: true (the inline-project default) pulls in
// this file's settings, including setupFiles, without needing one per package.
const projectRoots = [
  ...globSync('packages/*', { cwd: workspaceRoot }),
  ...globSync('apps/*', { cwd: workspaceRoot }),
]
  .map((dir) => join(workspaceRoot, dir))
  .filter((dir) => statSync(dir).isDirectory());

export default defineConfig({
  test: {
    setupFiles: [setupFile],
    projects: projectRoots.map((root) => ({ root, extends: true })),
  },
});
