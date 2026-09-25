import { fileURLToPath } from 'node:url';

import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';

import { isPgliteDb, type Db } from './client.ts';

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function migrate(db: Db): Promise<void> {
  if (isPgliteDb(db)) {
    await migratePglite(db, { migrationsFolder });
  } else {
    await migrateNodePg(db, { migrationsFolder });
  }
}
