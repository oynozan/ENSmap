import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { workspaceRoot } from '@ensmap/core/config';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { Pool } from 'pg';

import * as schema from './schema.ts';

export type PgliteDb = PgliteDatabase<typeof schema> & { $client: PGlite };
export type NodePostgresDb = NodePgDatabase<typeof schema> & {
  $client: Pool;
};
export type Db = PgliteDb | NodePostgresDb;

export function isPgliteDb(db: Db): db is PgliteDb {
  return db.$client instanceof PGlite;
}

const unsupportedDatabaseUrlError = (): Error =>
  new Error(
    'Unsupported DATABASE_URL. Use postgres://, postgresql://, pglite:<path>, or memory:.',
  );

export async function createDb(url?: string): Promise<Db> {
  const connection = url ?? 'memory:';

  if (
    connection.startsWith('postgres://') ||
    connection.startsWith('postgresql://')
  ) {
    const pool = new Pool({ connectionString: connection });
    return drizzleNodePg(pool, { schema, casing: 'snake_case' });
  }

  if (connection.startsWith('pglite:')) {
    const rawPath = connection.slice('pglite:'.length);

    // A '//' prefix (a mistyped pglite://path) slices to a root-relative path
    if (rawPath.startsWith('//')) {
      throw unsupportedDatabaseUrlError();
    }

    const dataDir = isAbsolute(rawPath)
      ? rawPath
      : join(workspaceRoot(), rawPath);

    // An empty path, '.', or workspaceRoot() itself would put a Postgres cluster in the repo root
    if (resolve(dataDir) === resolve(workspaceRoot())) {
      throw unsupportedDatabaseUrlError();
    }

    // PGlite's node fs backend does not create the parent directory itself
    mkdirSync(dataDir, { recursive: true });
    // create() awaits readiness, so the directory exists once this resolves
    const client = await PGlite.create(dataDir);
    return drizzlePglite(client, { schema, casing: 'snake_case' });
  }

  if (connection === 'memory:') {
    const client = await PGlite.create();
    return drizzlePglite(client, { schema, casing: 'snake_case' });
  }

  throw unsupportedDatabaseUrlError();
}

export async function closeDb(db: Db): Promise<void> {
  if (isPgliteDb(db)) {
    await db.$client.close();
  } else {
    await db.$client.end();
  }
}
