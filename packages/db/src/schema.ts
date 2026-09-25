// Spec §4 data model. Column names are derived from these camelCase keys via
// the 'snake_case' casing set on both drizzle.config.ts and createDb() in client.ts.
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const names = pgTable(
  'names',
  {
    namespace: text().notNull(),
    id: text().notNull(),
    name: text().notNull(),
    parentIds: text().array().notNull(),
    // ◆ R6, registry/owner/resolver/registered_at/expiry are nullable, the source can omit them
    registry: text(),
    owner: text(),
    resolver: text(),
    registeredAt: timestamp({ withTimezone: true, mode: 'date' }),
    expiry: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.id] })],
);

// ◆ deviation, namespace scopes the binding beyond spec §4
export const bindings = pgTable(
  'bindings',
  {
    namespace: text().notNull(),
    nameId: text().notNull(),
    chainId: integer().notNull(),
    address: text().notNull(),
    validFrom: timestamp({ withTimezone: true, mode: 'date' }),
    validTo: timestamp({ withTimezone: true, mode: 'date' }),
    verified: boolean().notNull(),
    source: text().notNull(),
  },
  (table) => [
    unique('bindings_namespace_name_id_chain_id_address_valid_from_key')
      .on(
        table.namespace,
        table.nameId,
        table.chainId,
        table.address,
        table.validFrom,
      )
      .nullsNotDistinct(),
  ],
);

// ◆ deviation, from/to are reserved-adjacent so columns are from_address/to_address
export const transfers = pgTable(
  'transfers',
  {
    chainId: integer().notNull(),
    uniqueId: text().notNull(),
    txHash: text().notNull(),
    block: bigint({ mode: 'bigint' }).notNull(),
    timestamp: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    fromAddress: text().notNull(),
    // ◆ R6, to_address is null for a contract creation
    toAddress: text(),
    asset: text().notNull(),
    rawValue: numeric({ precision: 78, scale: 0, mode: 'string' }).notNull(),
    decimals: integer(),
    category: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.uniqueId] }),
    index('transfers_chain_id_from_address_block_idx').on(
      table.chainId,
      table.fromAddress,
      table.block,
    ),
  ],
);

export const syncCursors = pgTable(
  'sync_cursors',
  {
    chainId: integer().notNull(),
    address: text().notNull(),
    lastBlock: bigint({ mode: 'bigint' }).notNull(),
    truncated: boolean().notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.address] })],
);

// ◆ deviation, usd null caches "no price available" for that token/hour (a
// definite negative, not merely unresolved — spec deviation 4)
export const prices = pgTable(
  'prices',
  {
    chainId: integer().notNull(),
    token: text().notNull(),
    hourBucket: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    usd: doublePrecision(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.token, table.hourBucket] }),
  ],
);

export const addresses = pgTable(
  'addresses',
  {
    chainId: integer().notNull(),
    address: text().notNull(),
    isContract: boolean().notNull(),
    nonce: bigint({ mode: 'bigint' }).notNull(),
    primaryName: text(),
    checkedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.address] })],
);

export const labelKind = pgEnum('label_kind', [
  'cex_hot',
  'cex_cold',
  'cex_deposit',
  'dex_router',
  'dex_pool',
  'dex_singleton',
]);

export const labels = pgTable(
  'labels',
  {
    chainId: integer().notNull(),
    address: text().notNull(),
    source: text().notNull(),
    kind: labelKind().notNull(),
    entity: text().notNull(),
    confidence: real().notNull(),
    // ◆ R6, heuristic labels have no source URL
    sourceUrl: text(),
    updatedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.address, table.source] }),
  ],
);

export const maps = pgTable('maps', {
  paramsHash: text().primaryKey(),
  graphJson: jsonb().notNull(),
  computedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
});
