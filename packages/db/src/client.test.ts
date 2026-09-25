import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { workspaceRoot } from '@ensmap/core/config';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, createDb } from './client.ts';

describe('createDb', () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir !== undefined && existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    dataDir = undefined;
  });

  it('opens a PGlite data directory under the workspace for pglite:<path>', async () => {
    // Unique per run so parallel/rerun test invocations never collide on disk
    const relativePath = join('.data', `test-${randomUUID()}`);
    dataDir = join(workspaceRoot(), relativePath);

    const db = await createDb(`pglite:${relativePath}`);
    try {
      // PG_VERSION only exists once PGlite initializes, not just on mkdirSync
      expect(existsSync(join(dataDir, 'PG_VERSION'))).toBe(true);
    } finally {
      await closeDb(db);
    }
  });

  it('opens an in-memory PGlite database when unset', async () => {
    const db = await createDb();
    await closeDb(db);
  });

  it('throws naming DATABASE_URL, without leaking the connection string, for an unsupported scheme', async () => {
    await expect(createDb('mysql://u:secret@h/db')).rejects.toThrow(
      /DATABASE_URL/,
    );

    const error: unknown = await createDb('mysql://u:secret@h/db').catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toContain('secret');
  });

  it('throws naming DATABASE_URL for an empty pglite: path', async () => {
    await expect(createDb('pglite:')).rejects.toThrow(/DATABASE_URL/);
  });

  it('throws naming DATABASE_URL for pglite:.', async () => {
    await expect(createDb('pglite:.')).rejects.toThrow(/DATABASE_URL/);
  });

  it('throws naming DATABASE_URL for a path that resolves to workspaceRoot()', async () => {
    await expect(createDb('pglite:.data/..')).rejects.toThrow(/DATABASE_URL/);
  });

  it('throws naming DATABASE_URL for a pglite://<path> double-slash prefix', async () => {
    await expect(createDb('pglite://.data/x')).rejects.toThrow(/DATABASE_URL/);
  });
});
