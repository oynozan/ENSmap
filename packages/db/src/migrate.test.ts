import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createDb, type Db } from './client.ts';
import { migrate } from './migrate.ts';
import { bindings, labels, names, transfers } from './schema.ts';

describe('migrate', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb();
    await migrate(db);
  });

  afterEach(async () => {
    await closeDb(db);
  });

  it('creates exactly the 8 spec tables in the public schema', async () => {
    const result = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'addresses',
      'bindings',
      'labels',
      'maps',
      'names',
      'prices',
      'sync_cursors',
      'transfers',
    ]);
  });

  it('succeeds when run a second time', async () => {
    await expect(migrate(db)).resolves.not.toThrow();
  });

  it('round-trips a uint256-max raw_value on transfers', async () => {
    const maxUint256 =
      '115792089237316195423570985008687907853269984665640564039457584007913129639935';

    await db.insert(transfers).values({
      chainId: 1,
      uniqueId: 'tx-max-uint256',
      txHash: '0xabc',
      block: 1n,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: '0x0000000000000000000000000000000000000002',
      asset: 'native',
      rawValue: maxUint256,
      decimals: 18,
      category: 'external',
    });

    const rows = await db.select().from(transfers);
    expect(rows[0]?.rawValue).toBe(maxUint256);
  });

  it('accepts a names row with registry, owner, resolver, registered_at and expiry null', async () => {
    await db.insert(names).values({
      namespace: 'mainnet',
      id: 'name-source-omitted-fields',
      name: 'example.eth',
      parentIds: [],
      registry: null,
      owner: null,
      resolver: null,
      registeredAt: null,
      expiry: null,
    });

    const rows = await db
      .select()
      .from(names)
      .where(eq(names.id, 'name-source-omitted-fields'));
    expect(rows[0]).toMatchObject({
      registry: null,
      owner: null,
      resolver: null,
      registeredAt: null,
      expiry: null,
    });
  });

  it('accepts a transfers row with to_address null for a contract creation', async () => {
    await db.insert(transfers).values({
      chainId: 1,
      uniqueId: 'tx-contract-creation',
      txHash: '0xdef',
      block: 1n,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: null,
      asset: 'native',
      rawValue: '0',
      decimals: 18,
      category: 'external',
    });

    const rows = await db
      .select()
      .from(transfers)
      .where(eq(transfers.uniqueId, 'tx-contract-creation'));
    expect(rows[0]?.toAddress).toBeNull();
  });

  it('raises a unique violation for a duplicate (chain_id, unique_id)', async () => {
    const row = {
      chainId: 1,
      uniqueId: 'dup-tx',
      txHash: '0xabc',
      block: 1n,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      fromAddress: '0x0000000000000000000000000000000000000001',
      toAddress: '0x0000000000000000000000000000000000000002',
      asset: 'native',
      rawValue: '0',
      decimals: 18,
      category: 'external',
    };

    await db.insert(transfers).values(row);

    await expect(db.insert(transfers).values(row)).rejects.toThrow();
  });

  it('accepts a labels row with source_url null for a heuristic label', async () => {
    await db.insert(labels).values({
      chainId: 1,
      address: '0x0000000000000000000000000000000000000001',
      source: 'heuristic',
      kind: 'cex_hot',
      entity: 'example',
      confidence: 0.5,
      sourceUrl: null,
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    });

    const rows = await db
      .select()
      .from(labels)
      .where(eq(labels.source, 'heuristic'));
    expect(rows[0]?.sourceUrl).toBeNull();
  });

  it('conflicts two bindings rows that differ only by both having a null valid_from', async () => {
    const row = {
      namespace: 'mainnet',
      nameId: 'name-1',
      chainId: 1,
      address: '0x0000000000000000000000000000000000000001',
      validFrom: null,
      validTo: null,
      verified: true,
      source: 'resolver',
    };

    await db.insert(bindings).values(row);

    await expect(db.insert(bindings).values(row)).rejects.toThrow();
  });
});
