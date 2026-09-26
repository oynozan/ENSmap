import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv, resolveNamespace } from '../../config/index.ts';
import {
  nameId,
  parseNameInput,
  type InterpretedName,
} from '../../ens/index.ts';
import {
  CallCounter,
  createFixtureFetch,
  createHttpClient,
  FIXTURES_DIR,
  fixtureMode,
} from '../../http/index.ts';
import {
  walkTree,
  type Address,
  type DomainRecord,
  type NameSource,
  type RecordEvent,
} from '../../names/index.ts';
import { createEnsDevGraphqlSource } from './index.ts';

const SEPOLIA_V2 = resolveNamespace('sepolia-v2', loadEnv({}));
const NOW = new Date('2026-09-26T00:00:00.000Z');
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_NODE = `0x${'0'.repeat(64)}`;

// labelhash values below were computed once with viem and pinned
const FOO_HASH =
  '0x41b1a0649752af1b28b3dc29a1556eee781e4a4c3a1f7f53f90fa834de098c4d';
const AMAZON_HASH =
  '0x6ba33f82c4f5402bd4855205453a2fd9d9e90c5266bbbb03d6d54389280d3df5';

function addr(byte: string): Address {
  return `0x${byte.repeat(20)}`;
}

function hex32(n: number): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

const OWNER = addr('a1');
const RESOLVER = addr('e1');
const RESOLVER_2 = addr('e2');
const WALLET = addr('b1');
const WALLET_2 = addr('b2');
const REGISTRY = addr('c1');
const SUBREGISTRY = addr('c2');
const OTHER_REGISTRY = addr('c3');

/* Synthetic graphql.ens.dev */

interface DevRow {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
  canonicalId: string | null;
  protocol: string;
  owner: { id: string };
  resolver: { address: string } | null;
  resolvedAddress: { id: string } | null;
  subregistry: { address: string } | null;
  parent: { id: string; subregistry: { address: string } | null } | null;
  registrationDate: number | null;
  createdAt: number;
  expiryDate: number | null;
}

// foo.eth in its parent's registry, with a subregistry of its own
function devDomain(overrides: Partial<DevRow> = {}): DevRow {
  return {
    id: hex32(1),
    name: 'foo.eth',
    labelName: 'foo',
    labelhash: FOO_HASH,
    canonicalId: hex32(0xf00),
    protocol: 'v2',
    owner: { id: OWNER },
    resolver: { address: RESOLVER },
    resolvedAddress: { id: WALLET },
    subregistry: { address: SUBREGISTRY },
    parent: { id: hex32(0xaa), subregistry: { address: REGISTRY } },
    registrationDate: 1790000000,
    createdAt: 1789000000,
    expiryDate: 1800000000,
    ...overrides,
  };
}

interface SentRequest {
  operation: string;
  variables: Record<string, unknown>;
}

type Responder = (req: SentRequest, index: number) => unknown;

function fakeServer(respond: Responder, now: () => Date = () => NOW) {
  const sent: SentRequest[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(text) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const req = {
      operation: /query (\w+)/.exec(body.query)?.[1] ?? '',
      variables: body.variables,
    };
    sent.push(req);
    return Promise.resolve(
      new Response(JSON.stringify(respond(req, sent.length - 1))),
    );
  };
  const http = createHttpClient({
    provider: 'ens-dev-graphql',
    limits: SEPOLIA_V2.nameSource.limits,
    counter: new CallCounter(),
    secrets: [],
    fetch,
    sleep: () => Promise.resolve(),
  });
  return {
    source: createEnsDevGraphqlSource(SEPOLIA_V2.nameSource, http, now),
    sent,
  };
}

async function mapDomain(
  row: DevRow,
  now?: () => Date,
): Promise<DomainRecord | null> {
  const { source } = fakeServer(() => ({ data: { domain: row } }), now);
  return source.getDomain(name('foo.eth'));
}

function record(
  id: string,
  overrides: Partial<DomainRecord> = {},
): DomainRecord {
  return {
    id,
    label: 'p',
    canonicalName: null,
    protocol: 'v2',
    registry: null,
    subregistry: null,
    owner: null,
    indexedResolver: null,
    indexedEthAddress: null,
    registeredAt: null,
    expiresAt: null,
    expired: false,
    ...overrides,
  };
}

describe('ens-dev-graphql domain mapping', () => {
  it('maps every field of a v2 domain', async () => {
    expect(await mapDomain(devDomain())).toEqual({
      id: hex32(1),
      label: 'foo',
      canonicalName: 'foo.eth',
      protocol: 'v2',
      registry: REGISTRY,
      subregistry: SUBREGISTRY,
      owner: OWNER,
      indexedResolver: RESOLVER,
      indexedEthAddress: WALLET,
      registeredAt: new Date('2026-09-21T14:13:20.000Z'),
      expiresAt: new Date('2027-01-15T08:00:00.000Z'),
      expired: false,
    });
  });

  it('keeps Domain.id as the id even when it is not the namehash of the input', async () => {
    const record = await mapDomain(devDomain({ id: hex32(0xabc) }));

    expect(record?.id).toBe(hex32(0xabc));
  });

  it('uses createdAt as registeredAt when registrationDate is null', async () => {
    const record = await mapDomain(devDomain({ registrationDate: null }));

    expect(record?.registeredAt).toEqual(new Date('2026-09-10T00:26:40.000Z'));
  });

  it('encodes an unnormalized labelName and name label as [labelhash]', async () => {
    const record = await mapDomain(
      devDomain({
        name: 'Amazon.eth',
        labelName: 'Amazon',
        labelhash: AMAZON_HASH,
      }),
    );

    expect(record?.label).toBe(`[${AMAZON_HASH.slice(2)}]`);
    expect(record?.canonicalName).toBe(`[${AMAZON_HASH.slice(2)}].eth`);
  });

  it('maps a null name to a null canonicalName', async () => {
    expect((await mapDomain(devDomain({ name: null })))?.canonicalName).toBe(
      null,
    );
  });

  it('turns a zero-address owner, resolvedAddress and resolver into null', async () => {
    const record = await mapDomain(
      devDomain({
        owner: { id: ZERO },
        resolver: { address: ZERO },
        resolvedAddress: { id: ZERO },
      }),
    );

    expect(record).toMatchObject({
      owner: null,
      indexedResolver: null,
      indexedEthAddress: null,
    });
  });

  it('stores every address lowercase', async () => {
    const record = await mapDomain(
      devDomain({
        owner: { id: '0xAbCdEf00000000000000000000000000000000A1' },
        resolver: { address: '0xAbCdEf00000000000000000000000000000000E1' },
        resolvedAddress: { id: '0xAbCdEf00000000000000000000000000000000B1' },
        subregistry: { address: '0xAbCdEf00000000000000000000000000000000C2' },
        parent: {
          id: hex32(0xaa),
          subregistry: {
            address: '0xAbCdEf00000000000000000000000000000000C1',
          },
        },
      }),
    );

    expect(record).toMatchObject({
      owner: '0xabcdef00000000000000000000000000000000a1',
      indexedResolver: '0xabcdef00000000000000000000000000000000e1',
      indexedEthAddress: '0xabcdef00000000000000000000000000000000b1',
      subregistry: '0xabcdef00000000000000000000000000000000c2',
      registry: '0xabcdef00000000000000000000000000000000c1',
    });
  });

  it('has no registry or subregistry when the source reports none', async () => {
    const orphan = await mapDomain(
      devDomain({ parent: null, subregistry: null }),
    );
    const leafParent = await mapDomain(
      devDomain({ parent: { id: hex32(0xaa), subregistry: null } }),
    );

    expect(orphan).toMatchObject({ registry: null, subregistry: null });
    expect(leafParent?.registry).toBeNull();
  });

  it('marks an entry past its expiryDate as expired', async () => {
    const record = await mapDomain(devDomain({ expiryDate: 1700000000 }));

    expect(record?.expiresAt).toEqual(new Date('2023-11-14T22:13:20.000Z'));
    expect(record?.expired).toBe(true);
  });

  it('computes expired with the injected clock', async () => {
    const later = () => new Date('2030-01-01T00:00:00.000Z');

    expect((await mapDomain(devDomain()))?.expired).toBe(false);
    expect((await mapDomain(devDomain(), later))?.expired).toBe(true);
  });

  it.each([
    ['null', null],
    ['0', 0],
  ])('treats an expiryDate of %s as no expiry', async (_label, expiryDate) => {
    const record = await mapDomain(devDomain({ expiryDate }));

    expect(record?.expiresAt).toBeNull();
    expect(record?.expired).toBe(false);
  });
});

describe('ens-dev-graphql getDomain', () => {
  it('looks the name up by its namehash', async () => {
    const { source, sent } = fakeServer(() => ({
      data: { domain: devDomain() },
    }));

    await source.getDomain(name('gloomy.eth'));

    expect(sent).toEqual([
      { operation: 'DomainById', variables: { id: nameId('gloomy.eth') } },
    ]);
  });

  it('returns null for a name the index does not know', async () => {
    const { source } = fakeServer(() => ({ data: { domain: null } }));

    expect(await source.getDomain(name('nope.eth'))).toBeNull();
  });
});

describe('ens-dev-graphql listChildren', () => {
  const P = hex32(0xa1);
  const parent = record(P, { subregistry: SUBREGISTRY });

  function connection(
    rows: DevRow[],
    pageInfo = { hasNextPage: false, endCursor: 'c-end' as string | null },
    totalCount: number | null = rows.length,
  ) {
    return {
      data: {
        domainConnection: {
          totalCount,
          pageInfo,
          edges: rows.map((node) => ({ node })),
        },
      },
    };
  }

  it('returns an empty page with a zero total for a parent without a subregistry, without a request', async () => {
    const { source, sent } = fakeServer(() => ({ data: {} }));

    const page = await source.listChildren([record(P)], null);

    expect(page).toEqual({ items: [], next: null, totals: new Map([[P, 0]]) });
    expect(sent).toEqual([]);
  });

  it('lists the parent subregistry from the first page', async () => {
    const { source, sent } = fakeServer(() => connection([]));

    await source.listChildren([parent], null);

    expect(sent).toEqual([
      {
        operation: 'RegistryChildren',
        variables: { registry: SUBREGISTRY, after: null },
      },
    ]);
  });

  it('passes the cursor as after', async () => {
    const { source, sent } = fakeServer(() => connection([]));

    await source.listChildren([parent], 'c-1');

    expect(sent[0]?.variables).toEqual({ registry: SUBREGISTRY, after: 'c-1' });
  });

  it('attributes every child to the requested parent and keys totals by it', async () => {
    const { source } = fakeServer(() =>
      connection(
        [
          devDomain({ id: hex32(3) }),
          devDomain({
            id: hex32(4),
            parent: {
              id: hex32(0xbb),
              subregistry: { address: OTHER_REGISTRY },
            },
          }),
        ],
        { hasNextPage: false, endCursor: 'c-end' },
        2,
      ),
    );

    const page = await source.listChildren([parent], null);

    expect(page.items.map((item) => [item.parentId, item.record.id])).toEqual([
      [P, hex32(3)],
      [P, hex32(4)],
    ]);
    expect(page.items.map((item) => item.record.registry)).toEqual([
      SUBREGISTRY,
      SUBREGISTRY,
    ]);
    expect(page.totals).toEqual(new Map([[P, 2]]));
    expect(page.next).toBeNull();
  });

  it('returns endCursor as next when hasNextPage', async () => {
    const { source } = fakeServer(() =>
      connection([devDomain()], { hasNextPage: true, endCursor: 'c-2' }, 1500),
    );

    const page = await source.listChildren([parent], null);

    expect(page.next).toBe('c-2');
    expect(page.totals).toEqual(new Map([[P, 1500]]));
  });

  it('reports no totals when the index gives no totalCount', async () => {
    const { source } = fakeServer(() =>
      connection([], { hasNextPage: false, endCursor: null }, null),
    );

    expect((await source.listChildren([parent], null)).totals).toBeUndefined();
  });

  it('rejects a call with more than one parent', async () => {
    const { source } = fakeServer(() => connection([]));

    await expect(
      source.listChildren([parent, record(hex32(0xa2))], null),
    ).rejects.toThrow(RangeError);
  });

  it('declares one parent per call', () => {
    const { source } = fakeServer(() => ({ data: {} }));

    expect(source.id).toBe('ens-dev-graphql');
    expect(source.maxParentsPerCall).toBe(1);
  });
});

describe('ens-dev-graphql registryReferrers', () => {
  it('returns the interpreted names of every referrer', async () => {
    const { source, sent } = fakeServer(() => ({
      data: {
        registry: {
          referencedBy: [
            { name: 'foo.eth' },
            { name: 'Amazon.eth' },
            { name: null },
          ],
        },
      },
    }));

    const referrers = await source.registryReferrers(REGISTRY);

    expect(referrers).toEqual(['foo.eth', `[${AMAZON_HASH.slice(2)}].eth`]);
    expect(sent).toEqual([
      { operation: 'Referrers', variables: { address: REGISTRY } },
    ]);
  });

  it('returns no referrers for a registry the index does not know', async () => {
    const { source } = fakeServer(() => ({ data: { registry: null } }));

    expect(await source.registryReferrers(REGISTRY)).toEqual([]);
  });
});

/* Record history */

const D1 = hex32(0xd1);
const D2 = hex32(0xd2);
const T0 = 1790000000;

interface EventRow {
  id: string;
  blockNumber: number;
  timestamp: number;
  type: string;
  data: string;
  namehash?: string;
}

function eventRow(
  type: string,
  block: number,
  logIndex: number,
  data: Record<string, unknown>,
  namehash?: string,
): EventRow {
  return {
    id: `${hex32(block)}-${logIndex}`,
    blockNumber: block,
    timestamp: T0 + block,
    type,
    data: JSON.stringify(data),
    ...(namehash === undefined ? {} : { namehash }),
  };
}

function resolverUpdated(
  node: string,
  resolver: string,
  block: number,
  logIndex: number,
): EventRow {
  return eventRow(
    'ResolverUpdated',
    block,
    logIndex,
    { tokenId: 1, resolver, sender: OWNER },
    node,
  );
}

function linked(
  node: string,
  resolver: string,
  recordId: string,
  block: number,
  logIndex: number,
): EventRow {
  return eventRow(
    'Linked',
    block,
    logIndex,
    { resolver, recordId, node, name: '' },
    node,
  );
}

function addressUpdated(
  resolver: string,
  recordId: string,
  address: string,
  block: number,
  logIndex: number,
  coinType = 60,
): EventRow {
  return eventRow('AddressUpdated', block, logIndex, {
    resolver,
    recordId,
    coinType,
    address,
  });
}

interface HistoryData {
  nodeEvents?: EventRow[];
  addressUpdates?: EventRow[];
  defaultLinks?: EventRow[];
}

function requested(
  req: SentRequest | undefined,
  key: string,
  field: string,
): string[] {
  const filters = (req?.variables[key] ?? []) as Record<string, string>[];
  return filters.map((filter) => filter[field] ?? '');
}

function resolverOf(row: EventRow): string {
  return (JSON.parse(row.data) as { resolver: string }).resolver;
}

// Answers like the index, filtering by the requested nodes and resolvers
function historyServer(history: HistoryData) {
  return fakeServer((req) => {
    if (req.operation === 'NodeHistory') {
      const nodes = requested(req, 'nodes', 'namehash');
      return {
        data: {
          events: (history.nodeEvents ?? []).filter((row) =>
            nodes.includes(row.namehash ?? ''),
          ),
        },
      };
    }
    const resolvers = requested(req, 'resolvers', 'contractAddress');
    const onResolvers = (rows: EventRow[] = []) =>
      rows.filter((row) => resolvers.includes(resolverOf(row)));
    return {
      data: {
        addressUpdates: onResolvers(history.addressUpdates),
        defaultLinks: onResolvers(history.defaultLinks),
      },
    };
  });
}

function at(block: number, logIndex: number) {
  return {
    block: BigInt(block),
    logIndex,
    timestamp: new Date((T0 + block) * 1000),
  };
}

describe('ens-dev-graphql recordHistory mapping', () => {
  it('maps resolver, link and coin-60 address events, sorted by block and log index', async () => {
    const { source } = historyServer({
      nodeEvents: [
        resolverUpdated(D1, RESOLVER_2, 1000, 2),
        resolverUpdated(D1, ZERO, 103, 10),
        linked(D1, RESOLVER, '7', 100, 6),
        resolverUpdated(D1, RESOLVER, 100, 5),
      ],
      addressUpdates: [
        addressUpdated(RESOLVER, '7', WALLET, 101, 12),
        addressUpdated(RESOLVER, '7', WALLET_2, 101, 3, 0),
        addressUpdated(RESOLVER, '7', ZERO, 102, 1),
      ],
    });

    const history = await source.recordHistory([record(D1)]);

    expect(history?.get(D1)).toEqual({
      complete: true,
      events: [
        { kind: 'resolver-set', resolver: RESOLVER, ...at(100, 5) },
        {
          kind: 'record-linked',
          resolver: RESOLVER,
          record: '7',
          ...at(100, 6),
        },
        {
          kind: 'addr-set',
          resolver: RESOLVER,
          record: '7',
          address: WALLET,
          ...at(101, 12),
        },
        {
          kind: 'addr-set',
          resolver: RESOLVER,
          record: '7',
          address: null,
          ...at(102, 1),
        },
        { kind: 'resolver-set', resolver: null, ...at(103, 10) },
        { kind: 'resolver-set', resolver: RESOLVER_2, ...at(1000, 2) },
      ] satisfies RecordEvent[],
    });
  });

  it('matches AddressUpdated by resolver and record id, not by namehash', async () => {
    const { source } = historyServer({
      nodeEvents: [
        resolverUpdated(D1, RESOLVER, 100, 1),
        linked(D1, RESOLVER, '7', 100, 2),
        resolverUpdated(D2, RESOLVER_2, 100, 3),
        linked(D2, RESOLVER_2, '7', 100, 4),
      ],
      addressUpdates: [
        { ...addressUpdated(RESOLVER, '7', WALLET, 101, 1), namehash: D2 },
        addressUpdated(RESOLVER, '8', WALLET_2, 101, 2),
        addressUpdated(RESOLVER_2, '7', WALLET_2, 101, 3),
      ],
    });

    const history = await source.recordHistory([record(D1), record(D2)]);
    const addrSets = (id: string) =>
      history
        ?.get(id)
        ?.events.filter((event) => event.kind === 'addr-set')
        .map((event) => [event.resolver, event.record, event.address]);

    expect(addrSets(D1)).toEqual([[RESOLVER, '7', WALLET]]);
    expect(addrSets(D2)).toEqual([[RESOLVER_2, '7', WALLET_2]]);
  });

  it('takes logIndex from the id after its last dash and timestamp from the event', async () => {
    const row = {
      ...resolverUpdated(D1, RESOLVER, 100, 0),
      id: `${hex32(0xdead)}-417`,
      timestamp: 1700000000,
    };
    const { source } = historyServer({ nodeEvents: [row] });

    const events = (await source.recordHistory([record(D1)]))?.get(D1)?.events;

    expect(events).toEqual([
      {
        kind: 'resolver-set',
        resolver: RESOLVER,
        block: 100n,
        logIndex: 417,
        timestamp: new Date('2023-11-14T22:13:20.000Z'),
      },
    ]);
  });

  it("links a node without a Linked event to the resolver's default record at the resolver's first event", async () => {
    const { source } = historyServer({
      nodeEvents: [resolverUpdated(D1, RESOLVER, 200, 1)],
      defaultLinks: [linked(ZERO_NODE, RESOLVER, '3', 150, 4)],
      addressUpdates: [
        addressUpdated(RESOLVER, '3', WALLET, 150, 5),
        addressUpdated(RESOLVER, '4', WALLET_2, 160, 1),
      ],
    });

    const history = await source.recordHistory([record(D1)]);

    expect(history?.get(D1)?.events).toEqual([
      { kind: 'record-linked', resolver: RESOLVER, record: '3', ...at(150, 4) },
      {
        kind: 'addr-set',
        resolver: RESOLVER,
        record: '3',
        address: WALLET,
        ...at(150, 5),
      },
      { kind: 'resolver-set', resolver: RESOLVER, ...at(200, 1) },
    ] satisfies RecordEvent[]);
  });

  it('falls back to the default record while the node is unlinked (record 0)', async () => {
    const { source } = historyServer({
      nodeEvents: [
        resolverUpdated(D1, RESOLVER, 5, 1),
        linked(D1, RESOLVER, '1', 10, 1),
        linked(D1, RESOLVER, '0', 20, 1),
        linked(D1, RESOLVER, '1', 40, 1),
      ],
      defaultLinks: [
        linked(ZERO_NODE, RESOLVER, '2', 8, 1),
        linked(ZERO_NODE, RESOLVER, '5', 30, 1),
      ],
    });

    const links = (await source.recordHistory([record(D1)]))
      ?.get(D1)
      ?.events.filter((event) => event.kind === 'record-linked')
      .map((event) => [event.block, event.record]);

    expect(links).toEqual([
      [8n, '2'],
      [10n, '1'],
      [20n, '2'],
      [30n, '5'],
      [40n, '1'],
    ]);
  });

  it('marks an unlinked node without a default record as linked to record 0', async () => {
    const { source } = historyServer({
      nodeEvents: [
        resolverUpdated(D1, RESOLVER, 5, 1),
        linked(D1, RESOLVER, '1', 10, 1),
        linked(D1, RESOLVER, '0', 20, 1),
      ],
    });

    const links = (await source.recordHistory([record(D1)]))
      ?.get(D1)
      ?.events.filter((event) => event.kind === 'record-linked')
      .map((event) => event.record);

    expect(links).toEqual(['1', '0']);
  });

  it('returns an empty complete history without ResolverHistory when no resolver is involved', async () => {
    const { source, sent } = historyServer({
      nodeEvents: [resolverUpdated(D1, ZERO, 100, 1)],
    });

    const history = await source.recordHistory([record(D1), record(D2)]);

    expect(history?.get(D1)).toEqual({
      complete: true,
      events: [{ kind: 'resolver-set', resolver: null, ...at(100, 1) }],
    });
    expect(history?.get(D2)).toEqual({ complete: true, events: [] });
    expect(sent.map((req) => req.operation)).toEqual(['NodeHistory']);
  });
});

describe('ens-dev-graphql recordHistory requests', () => {
  it('filters node events by namehash and asks for every resolver involved', async () => {
    const { source, sent } = historyServer({
      nodeEvents: [
        resolverUpdated(D1, RESOLVER, 100, 1),
        resolverUpdated(D1, ZERO, 101, 1),
        linked(D2, RESOLVER_2, '1', 102, 1),
      ],
    });

    await source.recordHistory([
      record(D1),
      record(D2, { indexedResolver: addr('e3') }),
    ]);

    expect(sent[0]).toEqual({
      operation: 'NodeHistory',
      variables: { nodes: [{ namehash: D1 }, { namehash: D2 }] },
    });
    expect(sent[1]?.operation).toBe('ResolverHistory');
    expect(requested(sent[1], 'resolvers', 'contractAddress').sort()).toEqual(
      [RESOLVER, RESOLVER_2, addr('e3')].sort(),
    );
  });

  it('asks for at most 25 nodes and 25 resolvers per request', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => hex32(0x100 + i));
    const { source, sent } = historyServer({
      nodeEvents: ids.map((id, i) =>
        resolverUpdated(
          id,
          `0x${(0x1000 + i).toString(16).padStart(40, '0')}`,
          100,
          i,
        ),
      ),
    });

    const history = await source.recordHistory(ids.map((id) => record(id)));

    const sizes = (operation: string, key: string) =>
      sent
        .filter((req) => req.operation === operation)
        .map((req) => (req.variables[key] as unknown[]).length)
        .sort((a, b) => a - b);
    expect(sizes('NodeHistory', 'nodes')).toEqual([10, 25, 25]);
    expect(sizes('ResolverHistory', 'resolvers')).toEqual([10, 25, 25]);
    expect(history?.size).toBe(60);
  });

  it.each<[string, Partial<Record<keyof HistoryData, number>>]>([
    ['node', { nodeEvents: 1000 }],
    ['address', { addressUpdates: 1000 }],
    ['default link', { defaultLinks: 1000 }],
  ])(
    'marks the whole batch incomplete when the %s list reaches the page limit',
    async (_list, full) => {
      const rows = (n: number | undefined, make: (i: number) => EventRow) =>
        Array.from({ length: n ?? 0 }, (_, i) => make(i));
      const { source } = historyServer({
        nodeEvents: [
          resolverUpdated(D1, RESOLVER, 1, 1),
          resolverUpdated(D2, RESOLVER, 1, 2),
          ...rows(full.nodeEvents, (i) =>
            linked(D1, RESOLVER, '1', 10 + i, 0),
          ).slice(2),
        ],
        addressUpdates: rows(full.addressUpdates, (i) =>
          addressUpdated(RESOLVER, '9', WALLET, 10 + i, 0),
        ),
        defaultLinks: rows(full.defaultLinks, (i) =>
          linked(ZERO_NODE, RESOLVER, '9', 10 + i, 0),
        ),
      });

      const history = await source.recordHistory([record(D1), record(D2)]);

      expect(history?.get(D1)?.complete).toBe(false);
      expect(history?.get(D2)?.complete).toBe(false);
    },
  );

  it('sends no request for no domains', async () => {
    const { source, sent } = historyServer({});

    expect(await source.recordHistory([])).toEqual(new Map());
    expect(sent).toEqual([]);
  });
});

/* Recorded fixtures */

const mode = fixtureMode(loadEnv());
const LIVE_TIMEOUT_MS = 600_000;
const WALK = {
  fetchCap: SEPOLIA_V2.fetchCap,
  maxLevels: SEPOLIA_V2.maxLevels,
};
// Registry shared by seller-a.eth and vet402.eth, per https://graphql.ens.dev
const SHARED_REGISTRY = '0xb093cec6d1cc355c40020f0df5103eceffd30dac';

describe(
  'ens-dev-graphql against recorded fixtures',
  { timeout: mode === 'replay' ? 5_000 : LIVE_TIMEOUT_MS },
  () => {
    let source: NameSource;
    let sellerA: DomainRecord;

    beforeAll(async () => {
      const http = createHttpClient({
        provider: 'ens-dev-graphql',
        limits: SEPOLIA_V2.nameSource.limits,
        counter: new CallCounter(),
        secrets: SEPOLIA_V2.secrets,
        fetch: createFixtureFetch({
          dir: FIXTURES_DIR,
          mode,
          secrets: SEPOLIA_V2.secrets,
        }),
        ...(mode === 'replay' ? { sleep: () => Promise.resolve() } : {}),
      });
      source = createEnsDevGraphqlSource(
        SEPOLIA_V2.nameSource,
        http,
        () => NOW,
      );
      const found = await source.getDomain(name('seller-a.eth'));
      if (found === null) {
        throw new Error('seller-a.eth missing from the index');
      }
      sellerA = found;
    }, LIVE_TIMEOUT_MS);

    it('getDomain(seller-a.eth) reads its shared subregistry', () => {
      expect(sellerA.id).toBe(nameId('seller-a.eth'));
      expect(sellerA.subregistry).toBe(SHARED_REGISTRY);
      expect(sellerA.protocol).toBe('v2');
    });

    it('lists the 4 labels of the shared registry under seller-a.eth', async () => {
      const page = await source.listChildren([sellerA], null);

      expect(page.items).toHaveLength(4);
      expect(page.items.every((item) => item.parentId === sellerA.id)).toBe(
        true,
      );
      expect(page.totals).toEqual(new Map([[sellerA.id, 4]]));
      expect(page.next).toBeNull();
    });

    it('names seller-a.eth and vet402.eth as referrers of the shared registry', async () => {
      const referrers = await source.registryReferrers(SHARED_REGISTRY);

      expect(referrers).toEqual(
        expect.arrayContaining(['seller-a.eth', 'vet402.eth']),
      );
    });

    it('walks gloomy.eth through the registry that contains its own parent', async () => {
      const tree = await walkTree(source, name('gloomy.eth'), WALK);
      const tinyTest = tree.nodes.get(nameId('tiny.test.gloomy.eth'));
      const tinyGloomy = tree.nodes.get(nameId('tiny.gloomy.eth'));

      expect(tinyTest?.parentIds).toEqual([
        nameId('test.gloomy.eth'),
        nameId('tiny.test.gloomy.eth'),
      ]);
      expect(tinyGloomy?.parentIds).toEqual([nameId('gloomy.eth')]);
      expect(tree.truncated).toBe(false);
    });

    it('walks tiny.test.gloomy.eth to a single root counted once', async () => {
      const root = nameId('tiny.test.gloomy.eth');

      const tree = await walkTree(source, name('tiny.test.gloomy.eth'), WALK);

      expect([...tree.nodes.keys()]).toEqual([root]);
      expect(tree.nodes.get(root)?.parentIds).toEqual([root]);
      expect(tree.indexedTotal).toEqual({ value: 1, exact: true });
      expect(tree.externalReferrers.get(root)).toEqual(['test.gloomy.eth']);
    });

    it('reads the record history of a resolver switch and of a default-record resolver', async () => {
      // Unlinks and relinks on a default-record resolver, per https://graphql.ens.dev
      const relinked = record(nameId('ensv2subgraph416bb.eth'), {
        indexedResolver: '0x7aaee2e6a4f493fc7840436d9e5bed788c714732',
      });
      const project = (events: RecordEvent[] | undefined) =>
        events?.map((event) => [
          event.kind,
          event.block,
          event.logIndex,
          'record' in event ? event.record : null,
          'address' in event ? event.address : null,
          event.resolver,
        ]);

      const history = await source.recordHistory([sellerA, relinked]);

      // Resolvers and wallet of seller-a.eth, per https://graphql.ens.dev
      const oldResolver = '0x49f5022dde516b92ac1609158bc6adc772088055';
      const newResolver = '0xc54403186db35b9d92cc393ae665d3960117ac14';
      const sellerWallet = '0xc0f58df8753a4c53fd98c17e46e9f4ce6b8e9fa6';
      expect(history?.get(sellerA.id)?.complete).toBe(true);
      expect(project(history?.get(sellerA.id)?.events)).toEqual([
        ['resolver-set', 11721545n, 290, null, null, oldResolver],
        ['record-linked', 11721545n, 292, '1', null, oldResolver],
        ['addr-set', 11721545n, 293, '1', sellerWallet, oldResolver],
        ['record-linked', 11779398n, 386, '1', null, newResolver],
        ['addr-set', 11779398n, 389, '1', sellerWallet, newResolver],
        ['resolver-set', 11779399n, 248, null, null, newResolver],
      ]);
      expect(
        project(
          history
            ?.get(relinked.id)
            ?.events.filter((event) => event.kind === 'record-linked'),
        )?.map(([, block, , recordId]) => [block, recordId]),
      ).toEqual([
        [11779611n, '1'],
        [11779674n, '0'],
        [11779738n, '2'],
        [11779754n, '1'],
      ]);
    });
  },
);
