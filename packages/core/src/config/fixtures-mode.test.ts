import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fixtureMode } from '../http/fixtures.ts';
import { loadEnv, workspaceRoot } from './env.ts';

describe('fixtures mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults ENSMAP_FIXTURES to replay via the shared vitest.setup.ts', () => {
    expect(process.env['ENSMAP_FIXTURES']).toBe('replay');
  });

  it('matches the README setup, where the CLI calls live endpoints by default', () => {
    const readme = readFileSync(join(workspaceRoot(), 'README.md'), 'utf8');
    const setup = readme.slice(
      readme.indexOf('## Setup'),
      readme.indexOf('## Workspace layout'),
    );
    vi.stubEnv('VITEST', '');

    expect(fixtureMode(loadEnv({}))).toBe('off');
    expect(setup).toMatch(/the CLI calls [^.]* live/);
    expect(setup).not.toMatch(/without credentials ENSmap runs against/);
  });
});
