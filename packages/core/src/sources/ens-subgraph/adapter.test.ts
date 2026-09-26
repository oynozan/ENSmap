import { beforeAll, describe, expect, it } from 'vitest';

import { loadEnv, resolveNamespace } from '../../config/index.ts';
import { parseNameInput, type InterpretedName } from '../../ens/index.ts';
import {
  CallCounter,
  createFixtureFetch,
  createHttpClient,
  FIXTURES_DIR,
  fixtureMode,
} from '../../http/index.ts';
import type {
  Address,
  DomainRecord,
  NameSource,
  RecordEvent,
} from '../../names/index.ts';
import { createEnsSubgraphSource } from './index.ts';

const MAINNET = resolveNamespace('mainnet', loadEnv({}));
const NOW = new Date('2026-09-26T00:00:00.000Z');
const ZERO = '0x0000000000000000000000000000000000000000';

// namehash and labelhash values below were computed once with viem and pinned
const ETH_NODE =
  '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';
const ENS_ETH =
  '0x4e34d3a81dc3a20f71bbdf2160492ddaa17ee7e5523757d47153379c13cb46df';
const UMBRA_ETH =
  '0x2bd24f861db34646ddb2ad289c900afad96daff108b9d677e25b13f0158426eb';
const FOO_HASH =
  '0x41b1a0649752af1b28b3dc29a1556eee781e4a4c3a1f7f53f90fa834de098c4d';
const AMAZON_HASH =
  '0x6ba33f82c4f5402bd4855205453a2fd9d9e90c5266bbbb03d6d54389280d3df5';
// Domain whose resolver was cleared (vvvvvv.luxe, NewResolver 10000316-85)
const CLEARED_RESOLVER_DOMAIN =
  '0x3d8946310840d3d42c6323916d1b53e0481f9623537c3a363bb04345c0be26bc';
// NameWrapper, from https://raw.githubusercontent.com/ensdomains/ens-subgraph/723f1b6/subgraph.yaml
const NAME_WRAPPER_CHECKSUMMED = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';

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

const CONTROLLER = addr('c1');
const REGISTRANT = addr('a1');
const WRAPPED_OWNER = addr('a2');
const SUB_OWNER = addr('a3');
const RESOLVER = addr('e1');
const RESOLVER_2 = addr('e2');
const WALLET = addr('b1');
const WALLET_2 = addr('b2');

/* Synthetic subgraph */

interface SubgraphRow {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
  parent: { id: string } | null;
  owner: { id: string };
  registrant: { id: string } | null;
  wrappedOwner: { id: string } | null;
  resolver: { address: string } | null;
  resolvedAddress: { id: string } | null;
  createdAt: string;
  expiryDate: string | null;
  registration: { registrationDate: string; expiryDate: string } | null;
}

// Unwrapped foo.eth whose registry owner is a controller, not the registrant
function eth2ld(overrides: Partial<SubgraphRow> = {}): SubgraphRow {
  return {
    id: hex32(1),
    name: 'foo.eth',
    labelName: 'foo',
    labelhash: FOO_HASH,
    parent: { id: ETH_NODE },
    owner: { id: CONTROLLER },
    registrant: { id: REGISTRANT },
    wrappedOwner: null,
    resolver: { address: RESOLVER },
    resolvedAddress: { id: WALLET },
    createdAt: '1500000000',
    // Registration expiry plus the 90-day grace, as the subgraph stores it
    expiryDate: '1807776000',
    registration: { registrationDate: '1600000000', expiryDate: '1800000000' },
    ...overrides,
  };
}

// foo.umbra.eth, a subname with no registration
function subname(overrides: Partial<SubgraphRow> = {}): SubgraphRow {
  return {
    id: hex32(2),
    name: 'foo.umbra.eth',
    labelName: 'foo',
    labelhash: FOO_HASH,
    parent: { id: UMBRA_ETH },
    owner: { id: SUB_OWNER },
    registrant: null,
    wrappedOwner: null,
    resolver: { address: RESOLVER },
    resolvedAddress: { id: WALLET },
    createdAt: '1500000000',
    expiryDate: null,
    registration: null,
    ...overrides,
  };
}

interface SentRequest {
  operation: string;
  variables: Record<string, unknown>;
}

type Responder = (req: SentRequest, index: number) => unknown;

function fakeSubgraph(respond: Responder, now: () => Date = () => NOW) {
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
    provider: 'ens-subgraph',
    limits: MAINNET.nameSource.limits,
    counter: new CallCounter(),
    secrets: [],
    fetch,
    sleep: () => Promise.resolve(),
  });
  return {
    source: createEnsSubgraphSource(MAINNET.nameSource, http, now),
    sent,
  };
}

async function mapDomain(
  row: SubgraphRow,
  now?: () => Date,
): Promise<DomainRecord | null> {
  const { source } = fakeSubgraph(() => ({ data: { domain: row } }), now);
  return source.getDomain(name('foo.eth'));
}

function parent(id: string): DomainRecord {
  return {
    id,
    label: 'p',
    canonicalName: null,
    protocol: 'v1',
    registry: null,
    subregistry: null,
    owner: null,
    indexedResolver: null,
    indexedEthAddress: null,
    registeredAt: null,
    expiresAt: null,
    expired: false,
  };
}

describe('ens-subgraph domain mapping', () => {
  it('maps an unwrapped 2LD .eth with registrant, registration dates and v1 fields', async () => {
    expect(await mapDomain(eth2ld())).toEqual({
      id: hex32(1),
      label: 'foo',
      canonicalName: 'foo.eth',
      protocol: 'v1',
      registry: null,
      subregistry: null,
      owner: REGISTRANT,
      indexedResolver: RESOLVER,
      indexedEthAddress: WALLET,
      registeredAt: new Date('2020-09-13T12:26:40.000Z'),
      expiresAt: new Date('2027-01-15T08:00:00.000Z'),
      expired: false,
    });
  });

  it('encodes an unnormalized labelName and name label as [labelhash]', async () => {
    const record = await mapDomain(
      subname({
        name: 'Amazon.umbra.eth',
        labelName: 'Amazon',
        labelhash: AMAZON_HASH,
      }),
    );

    expect(record?.label).toBe(`[${AMAZON_HASH.slice(2)}]`);
    expect(record?.canonicalName).toBe(`[${AMAZON_HASH.slice(2)}].umbra.eth`);
  });

  it('keeps an already encoded label in the subgraph name', async () => {
    const encoded = `[${AMAZON_HASH.slice(2)}]`;
    const record = await mapDomain(
      subname({
        name: `${encoded}.luxe`,
        labelName: null,
        labelhash: AMAZON_HASH,
      }),
    );

    expect(record?.label).toBe(encoded);
    expect(record?.canonicalName).toBe(`${encoded}.luxe`);
  });

  it('maps a null subgraph name to a null canonicalName', async () => {
    const record = await mapDomain(subname({ name: null }));

    expect(record?.canonicalName).toBeNull();
    expect(record?.label).toBe('foo');
  });

  it('turns a zero-address owner, resolvedAddress and resolver into null', async () => {
    const record = await mapDomain(
      subname({
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

  it('turns a missing resolver and resolvedAddress into null', async () => {
    const record = await mapDomain(
      subname({ resolver: null, resolvedAddress: null }),
    );

    expect(record).toMatchObject({
      indexedResolver: null,
      indexedEthAddress: null,
    });
  });

  it('stores addresses lowercase', async () => {
    const record = await mapDomain(
      subname({
        owner: { id: '0xAbCdEf00000000000000000000000000000000A1' },
        resolver: { address: '0xAbCdEf00000000000000000000000000000000E1' },
        resolvedAddress: { id: '0xAbCdEf00000000000000000000000000000000B1' },
      }),
    );

    expect(record).toMatchObject({
      owner: '0xabcdef00000000000000000000000000000000a1',
      indexedResolver: '0xabcdef00000000000000000000000000000000e1',
      indexedEthAddress: '0xabcdef00000000000000000000000000000000b1',
    });
  });
});

describe('ens-subgraph owner rule', () => {
  it.each([
    ['lowercase', NAME_WRAPPER_CHECKSUMMED.toLowerCase()],
    ['checksummed', NAME_WRAPPER_CHECKSUMMED],
  ])(
    'uses wrappedOwner when the registry owner is the NameWrapper (%s)',
    async (_spelling, nameWrapper) => {
      const record = await mapDomain(
        eth2ld({
          owner: { id: nameWrapper },
          registrant: { id: nameWrapper },
          wrappedOwner: { id: WRAPPED_OWNER },
        }),
      );

      expect(record?.owner).toBe(WRAPPED_OWNER);
    },
  );

  it('uses the registrant for an unwrapped 2LD .eth', async () => {
    expect((await mapDomain(eth2ld()))?.owner).toBe(REGISTRANT);
  });

  it('uses the registry owner for a subname and ignores a stale wrappedOwner', async () => {
    const record = await mapDomain(
      subname({ wrappedOwner: { id: WRAPPED_OWNER } }),
    );

    expect(record?.owner).toBe(SUB_OWNER);
  });
});

describe('ens-subgraph registration and expiry', () => {
  it('uses createdAt as registeredAt for a subname', async () => {
    const record = await mapDomain(subname());

    expect(record?.registeredAt).toEqual(new Date('2017-07-14T02:40:00.000Z'));
    expect(record?.expiresAt).toBeNull();
    expect(record?.expired).toBe(false);
  });

  it('marks a 2LD .eth past its registration expiry as expired', async () => {
    const record = await mapDomain(
      eth2ld({
        registration: {
          registrationDate: '1500000000',
          expiryDate: '1700000000',
        },
      }),
    );

    expect(record?.expiresAt).toEqual(new Date('2023-11-14T22:13:20.000Z'));
    expect(record?.expired).toBe(true);
  });

  it('computes expired with the injected clock', async () => {
    const later = () => new Date('2030-01-01T00:00:00.000Z');

    expect((await mapDomain(eth2ld()))?.expired).toBe(false);
    expect((await mapDomain(eth2ld(), later))?.expired).toBe(true);
  });

  it('does not expire a wrapped subname whose Domain.expiryDate is in the future', async () => {
    const record = await mapDomain(
      subname({
        owner: { id: NAME_WRAPPER_CHECKSUMMED.toLowerCase() },
        wrappedOwner: { id: WRAPPED_OWNER },
        expiryDate: '1800000000',
      }),
    );

    expect(record?.expiresAt).toEqual(new Date('2027-01-15T08:00:00.000Z'));
    expect(record?.expired).toBe(false);
  });

  it('treats a Domain.expiryDate of "0" as no expiry', async () => {
    const record = await mapDomain(subname({ expiryDate: '0' }));

    expect(record?.expiresAt).toBeNull();
    expect(record?.expired).toBe(false);
  });

  it('marks a subname past its enforced Domain.expiryDate as expired', async () => {
    const record = await mapDomain(subname({ expiryDate: '1700000000' }));

    expect(record?.expiresAt).toEqual(new Date('2023-11-14T22:13:20.000Z'));
    expect(record?.expired).toBe(true);
  });
});

describe('ens-subgraph getDomain', () => {
  it('looks the name up by its namehash', async () => {
    const { source, sent } = fakeSubgraph(() => ({
      data: { domain: eth2ld() },
    }));

    await source.getDomain(name('ens.eth'));

    expect(sent).toEqual([
      { operation: 'DomainById', variables: { id: ENS_ETH } },
    ]);
  });

  it('returns null for a name the subgraph does not know', async () => {
    const { source } = fakeSubgraph(() => ({ data: { domain: null } }));

    expect(await source.getDomain(name('nope.eth'))).toBeNull();
  });

  it('retries a 200 rate-limit body and returns the data that follows', async () => {
    const { source, sent } = fakeSubgraph((_req, index) =>
      index === 0
        ? { message: 'Rate-limit on ensdomains/ens community key exceeded' }
        : { data: { domain: eth2ld() } },
    );

    const record = await source.getDomain(name('foo.eth'));

    expect(record?.id).toBe(hex32(1));
    expect(sent).toHaveLength(2);
  });
});

describe('ens-subgraph listChildren', () => {
  const P1 = hex32(0xa1);
  const P2 = hex32(0xa2);

  it('requests the first page with after "" and the parent ids', async () => {
    const { source, sent } = fakeSubgraph(() => ({ data: { domains: [] } }));

    await source.listChildren([parent(P1), parent(P2)], null);

    expect(sent).toEqual([
      { operation: 'Children', variables: { parents: [P1, P2], after: '' } },
    ]);
  });

  it('passes the cursor as after', async () => {
    const { source, sent } = fakeSubgraph(() => ({ data: { domains: [] } }));

    await source.listChildren([parent(P1)], hex32(7));

    expect(sent[0]?.variables).toEqual({ parents: [P1], after: hex32(7) });
  });

  it('attributes each child to its parent, reports no totals and ends a short page', async () => {
    const { source } = fakeSubgraph(() => ({
      data: {
        domains: [
          subname({ id: hex32(3), parent: { id: P1 } }),
          subname({ id: hex32(4), parent: { id: P2 } }),
        ],
      },
    }));

    const page = await source.listChildren([parent(P1), parent(P2)], null);

    expect(page.items.map((item) => [item.parentId, item.record.id])).toEqual([
      [P1, hex32(3)],
      [P2, hex32(4)],
    ]);
    expect(page.next).toBeNull();
    expect(page.totals).toBeUndefined();
  });

  it('returns the last id as next when a page holds 1000 rows', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      subname({ id: hex32(i + 1), parent: { id: P1 } }),
    );
    const { source } = fakeSubgraph(() => ({ data: { domains: rows } }));

    const page = await source.listChildren([parent(P1)], null);

    expect(page.items).toHaveLength(1000);
    expect(page.next).toBe(hex32(1000));
  });

  it('ends paging on a page of 999 rows', async () => {
    const rows = Array.from({ length: 999 }, (_, i) =>
      subname({ id: hex32(i + 1), parent: { id: P1 } }),
    );
    const { source } = fakeSubgraph(() => ({ data: { domains: rows } }));

    expect((await source.listChildren([parent(P1)], null)).next).toBeNull();
  });
});

describe('ens-subgraph registryReferrers', () => {
  it('resolves null without a request', async () => {
    const { source, sent } = fakeSubgraph(() => ({ data: {} }));

    expect(await source.registryReferrers(addr('11'))).toBeNull();
    expect(sent).toEqual([]);
  });
});

/* Record history */

const D1 = hex32(0xd1);
const D2 = hex32(0xd2);

interface ResolverChangesPage {
  set: {
    id: string;
    blockNumber: number;
    domain: { id: string };
    resolver: { address: string };
  }[];
  cleared: { id: string; blockNumber: number; domain: { id: string } }[];
}

interface AddrEventsPage {
  addrChangeds: {
    id: string;
    blockNumber: number;
    resolver: { id: string; address: string };
    addr: { id: string };
  }[];
  multicoinAddrChangeds: {
    id: string;
    blockNumber: number;
    resolver: { id: string; address: string };
    addr: string;
  }[];
  versionChangeds: {
    id: string;
    blockNumber: number;
    resolver: { id: string; address: string };
  }[];
}

const NO_ADDR_EVENTS: AddrEventsPage = {
  addrChangeds: [],
  multicoinAddrChangeds: [],
  versionChangeds: [],
};

function setRow(
  id: string,
  domain: string,
  resolver: Address,
): ResolverChangesPage['set'][number] {
  return {
    id,
    blockNumber: Number(id.split('-')[0]),
    domain: { id: domain },
    resolver: { address: resolver },
  };
}

function clearedRow(
  id: string,
  domain: string,
): ResolverChangesPage['cleared'][number] {
  return { id, blockNumber: Number(id.split('-')[0]), domain: { id: domain } };
}

function resolverRef(resolver: Address, domain: string) {
  return { id: `${resolver}-${domain}`, address: resolver };
}

function historySubgraph(
  changes: (req: SentRequest) => ResolverChangesPage,
  events: AddrEventsPage = NO_ADDR_EVENTS,
) {
  return fakeSubgraph((req) => ({
    data: req.operation === 'ResolverChanges' ? changes(req) : events,
  }));
}

function at(block: number, logIndex: number) {
  return { block: BigInt(block), logIndex, timestamp: null };
}

describe('ens-subgraph recordHistory', () => {
  it('maps resolver changes and resolver events, sorted by block and log index', async () => {
    const { source } = historySubgraph(
      () => ({
        set: [
          setRow('12000000-3', D1, RESOLVER_2),
          setRow('9000000-2', D1, RESOLVER),
        ],
        cleared: [clearedRow('11000000-7', D1)],
      }),
      {
        addrChangeds: [
          {
            id: '9000000-11',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: { id: WALLET },
          },
        ],
        multicoinAddrChangeds: [
          {
            id: '12000000-9',
            blockNumber: 12000000,
            resolver: resolverRef(RESOLVER_2, D1),
            addr: WALLET_2,
          },
          {
            id: '9000000-10',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: WALLET,
          },
        ],
        versionChangeds: [
          {
            id: '10000000-2',
            blockNumber: 10000000,
            resolver: resolverRef(RESOLVER, D1),
          },
        ],
      },
    );

    const history = await source.recordHistory([parent(D1)]);

    expect(history?.get(D1)).toEqual({
      complete: true,
      events: [
        { kind: 'resolver-set', resolver: RESOLVER, ...at(9000000, 2) },
        {
          kind: 'addr-set',
          resolver: RESOLVER,
          record: 'self',
          address: WALLET,
          ...at(9000000, 10),
        },
        {
          kind: 'addr-set',
          resolver: RESOLVER,
          record: 'self',
          address: WALLET,
          ...at(9000000, 11),
        },
        {
          kind: 'records-cleared',
          resolver: RESOLVER,
          record: 'self',
          ...at(10000000, 2),
        },
        { kind: 'resolver-set', resolver: null, ...at(11000000, 7) },
        { kind: 'resolver-set', resolver: RESOLVER_2, ...at(12000000, 3) },
        {
          kind: 'addr-set',
          resolver: RESOLVER_2,
          record: 'self',
          address: WALLET_2,
          ...at(12000000, 9),
        },
      ] satisfies RecordEvent[],
    });
  });

  it('queries AddrEvents with every resolver each domain ever had', async () => {
    const { source, sent } = historySubgraph(() => ({
      set: [
        setRow('9000000-2', D1, RESOLVER),
        setRow('9500000-4', D1, RESOLVER_2),
        setRow('9600000-1', D1, RESOLVER),
        setRow('9700000-5', D2, RESOLVER),
      ],
      cleared: [],
    }));

    await source.recordHistory([parent(D1), parent(D2)]);

    const addrEvents = sent.filter((req) => req.operation === 'AddrEvents');
    expect(addrEvents).toHaveLength(1);
    const ids = addrEvents[0]?.variables['resolverIds'];
    expect(Array.isArray(ids) ? [...(ids as string[])].sort() : ids).toEqual(
      [`${RESOLVER}-${D1}`, `${RESOLVER}-${D2}`, `${RESOLVER_2}-${D1}`].sort(),
    );
  });

  it('drops an addr event repeated at the same block and log index', async () => {
    const { source } = historySubgraph(
      () => ({ set: [setRow('9000000-2', D1, RESOLVER)], cleared: [] }),
      {
        ...NO_ADDR_EVENTS,
        addrChangeds: [
          {
            id: '9000000-10',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: { id: WALLET },
          },
        ],
        multicoinAddrChangeds: [
          {
            id: '9000000-10',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: WALLET,
          },
        ],
      },
    );

    const events = (await source.recordHistory([parent(D1)]))?.get(D1)?.events;

    expect(events?.filter((event) => event.kind === 'addr-set')).toHaveLength(
      1,
    );
  });

  it('maps a zero or empty address to null', async () => {
    const { source } = historySubgraph(
      () => ({ set: [setRow('9000000-2', D1, RESOLVER)], cleared: [] }),
      {
        ...NO_ADDR_EVENTS,
        addrChangeds: [
          {
            id: '9000000-10',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: { id: ZERO },
          },
        ],
        multicoinAddrChangeds: [
          {
            id: '9000000-12',
            blockNumber: 9000000,
            resolver: resolverRef(RESOLVER, D1),
            addr: '0x',
          },
        ],
      },
    );

    const events = (await source.recordHistory([parent(D1)]))?.get(D1)?.events;

    expect(
      events?.flatMap((event) =>
        event.kind === 'addr-set' ? [event.address] : [],
      ),
    ).toEqual([null, null]);
  });

  it('pages each resolver alias until it returns fewer than 1000 rows', async () => {
    const fullSet = Array.from({ length: 1000 }, (_, i) =>
      setRow(`${9000000 + i}-0`, D1, RESOLVER),
    );
    const { source, sent } = historySubgraph((req) =>
      req.variables['afterSet'] === ''
        ? { set: fullSet, cleared: [clearedRow('8000000-1', D1)] }
        : { set: [setRow('9999999-0', D1, RESOLVER_2)], cleared: [] },
    );

    const history = await source.recordHistory([parent(D1)]);

    expect(
      sent
        .filter((req) => req.operation === 'ResolverChanges')
        .map((req) => req.variables),
    ).toEqual([
      { ids: [D1], afterSet: '', afterCleared: '' },
      { ids: [D1], afterSet: '9000999-0', afterCleared: '8000000-1' },
    ]);
    expect(
      history?.get(D1)?.events.filter((e) => e.kind === 'resolver-set'),
    ).toHaveLength(1002);
  });

  it('marks every domain in the batch incomplete when an event list holds 1000 rows', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      id: `${9000000 + i}-0`,
      blockNumber: 9000000 + i,
      resolver: resolverRef(RESOLVER, D1),
    }));
    const { source } = historySubgraph(
      () => ({
        set: [
          setRow('8000000-1', D1, RESOLVER),
          setRow('8000000-2', D2, RESOLVER),
        ],
        cleared: [],
      }),
      { ...NO_ADDR_EVENTS, versionChangeds: full },
    );

    const history = await source.recordHistory([parent(D1), parent(D2)]);

    expect(history?.get(D1)?.complete).toBe(false);
    expect(history?.get(D2)?.complete).toBe(false);
  });

  it('returns an empty complete history without AddrEvents when no resolver was ever set', async () => {
    const { source, sent } = historySubgraph(() => ({ set: [], cleared: [] }));

    const history = await source.recordHistory([parent(D1)]);

    expect(history?.get(D1)).toEqual({ events: [], complete: true });
    expect(sent.map((req) => req.operation)).toEqual(['ResolverChanges']);
  });

  it('queries at most 100 domains per batch', async () => {
    const domains = Array.from({ length: 150 }, (_, i) => parent(hex32(i)));
    const { source, sent } = historySubgraph(() => ({ set: [], cleared: [] }));

    const history = await source.recordHistory(domains);

    expect(
      sent
        .map((req) => (req.variables['ids'] as string[]).length)
        .sort((a, b) => a - b),
    ).toEqual([50, 100]);
    expect(history?.size).toBe(150);
  });
});

/* Recorded fixtures */

const mode = fixtureMode(loadEnv());
const LIVE_TIMEOUT_MS = 600_000;

describe(
  'ens-subgraph against recorded fixtures',
  { timeout: mode === 'replay' ? 5_000 : LIVE_TIMEOUT_MS },
  () => {
    let source: NameSource;
    let ensEth: DomainRecord;

    beforeAll(async () => {
      const http = createHttpClient({
        provider: 'ens-subgraph',
        limits: MAINNET.nameSource.limits,
        counter: new CallCounter(),
        secrets: MAINNET.secrets,
        fetch: createFixtureFetch({
          dir: FIXTURES_DIR,
          mode,
          secrets: MAINNET.secrets,
        }),
        ...(mode === 'replay' ? { sleep: () => Promise.resolve() } : {}),
      });
      source = createEnsSubgraphSource(MAINNET.nameSource, http, () => NOW);
      const found = await source.getDomain(name('ens.eth'));
      if (found === null) {
        throw new Error('ens.eth missing from the subgraph');
      }
      ensEth = found;
    }, LIVE_TIMEOUT_MS);

    it('getDomain(ens.eth) returns its namehash id', () => {
      expect(ensEth.id).toBe(ENS_ETH);
      expect(ensEth.canonicalName).toBe('ens.eth');
    });

    it('lists the 22 on-chain children of ens.eth', async () => {
      const page = await source.listChildren([ensEth], null);

      expect(page.items).toHaveLength(22);
      expect(page.items.every((item) => item.parentId === ensEth.id)).toBe(
        true,
      );
      expect(page.next).toBeNull();
    });

    it('reads a history batch that includes a domain whose resolver was cleared', async () => {
      const cleared = parent(CLEARED_RESOLVER_DOMAIN);

      const history = await source.recordHistory([ensEth, cleared]);

      expect(history?.get(CLEARED_RESOLVER_DOMAIN)?.events).toContainEqual({
        kind: 'resolver-set',
        resolver: null,
        ...at(10000316, 85),
      });
      expect(history?.get(ENS_ETH)?.events).toContainEqual({
        kind: 'addr-set',
        resolver: '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
        record: 'self',
        address: '0xfe89cc7abb2c4183683ab71653c4cdc9b02d44b7',
        ...at(14091662, 298),
      });
    });
  },
);
