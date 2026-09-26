import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EnvSchema } from '@ensmap/core/config';
import { build, type Plugin } from 'vite';
import { describe, expect, it, vi } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

// Vite swaps a Node built-in imported by browser code for an empty
// __vite-browser-external module and only warns, so the emitted text never
// names it. Record those modules from every chunk, worker bundles included.
function browserExternals(found: string[]): Plugin {
  return {
    name: 'ensmap:browser-externals',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          found.push(
            ...file.moduleIds.filter((id) =>
              id.startsWith('__vite-browser-external'),
            ),
          );
        }
      }
    },
  };
}

describe('web bundle', () => {
  it(
    'contains no env var names, process.env or node: imports',
    { timeout: 60_000 },
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'ensmap-web-bundle-'));
      const externals: string[] = [];
      // Vitest sets NODE_ENV=test, which Vite would inline, bundling React's
      // development build; check the production bundle that actually ships.
      vi.stubEnv('NODE_ENV', 'production');
      try {
        await build({
          root: webRoot,
          logLevel: 'silent',
          plugins: [browserExternals(externals)],
          worker: { plugins: () => [browserExternals(externals)] },
          build: { outDir, emptyOutDir: true },
        });
        const files = await readdir(outDir, { recursive: true });
        const chunks = await Promise.all(
          files
            .filter((file) => file.endsWith('.js'))
            .map((file) => readFile(join(outDir, file), 'utf8')),
        );
        const js = chunks.join('\n');

        expect(js.length).toBeGreaterThan(0);
        for (const name of EnvSchema.keyof().options) {
          expect(js, name).not.toContain(name);
        }
        expect(js).not.toContain('process.env');
        // Quoted only: React DOM's minified code has the key {node:n,offset:…}.
        expect(js).not.toMatch(/["'`]node:/);
        expect(externals).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        await rm(outDir, { recursive: true, force: true });
      }
    },
  );
});
