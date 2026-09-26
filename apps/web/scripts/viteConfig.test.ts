import { fileURLToPath } from 'node:url';

import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

async function devServer() {
  const config = await resolveConfig(
    { root: webRoot, logLevel: 'silent' },
    'serve',
  );
  const proxy = config.server.proxy?.['/api'];
  return {
    port: config.server.port,
    strictPort: config.server.strictPort,
    target: typeof proxy === 'object' ? proxy.target : proxy,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('vite dev server config', () => {
  it('defaults to port 5180 and proxies /api to port 3002', async () => {
    vi.stubEnv('ENSMAP_WEB_PORT', '');
    vi.stubEnv('ENSMAP_API_PORT', '');
    expect(await devServer()).toEqual({
      port: 5180,
      strictPort: true,
      target: 'http://localhost:3002',
    });
  });

  it('follows ENSMAP_WEB_PORT and ENSMAP_API_PORT', async () => {
    vi.stubEnv('ENSMAP_WEB_PORT', '5190');
    vi.stubEnv('ENSMAP_API_PORT', '3190');
    expect(await devServer()).toEqual({
      port: 5190,
      strictPort: true,
      target: 'http://localhost:3190',
    });
  });
});
