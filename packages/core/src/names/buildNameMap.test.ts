import { describe, expect, it } from 'vitest';

import { loadEnv, resolveNamespace } from '../config/index.ts';
import { parseNameInput, type InterpretedName } from '../ens/names.ts';
import { ProviderError } from '../http/client.ts';
import { CallCounter } from '../http/counter.ts';
import {
  createFakeChainReader,
  createFakeEnsResolver,
  type FakeChainReader,
  type FakeEnsResolver,
} from '../rpc/testing/fakes.ts';
import { createNamespaceDeps } from '../sources/index.ts';
import { buildNameMap, type NamespaceDeps } from './buildNameMap.ts';
import { NameMapJson, toNameMapJson } from './json.ts';
import {
  createFakeNameSource,
  type FakeDomain,
  type FakeNameSource,
} from './testing/fakeNameSource.ts';
import type { Address, RecordEvent, RecordHistory } from './types.ts';

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function addr(byte: string): Address {
  return `0x${byte.repeat(20)}`;
}

const W = addr('aa');
const W2 = addr('bb');
const X = addr('cc');
const O = addr('dd');
const R = addr('11');
const REG = addr('22');

const NOW = new Date('2026-09-26T00:00:00.000Z');
const REGISTERED = new Date('2020-01-01T00:00:00.000Z');
const BLOCK_100_AT = new Date('2023-01-02T03:04:05.000Z');
const V2_AT = new Date('2025-06-07T08:09:10.000Z');
const ENCODED = `[${'ab'.repeat(32)}]`;

function event(
  kind: 'resolver-set' | 'addr-set',
  block: number,
  logIndex: number,
  address: Address,
  timestamp: Date | null = null,
): RecordEvent {
  const position = { block: BigInt(block), logIndex, timestamp };
  return kind === 'resolver-set'
    ? { kind, resolver: address, ...position }
    : { kind, resolver: R, record: 'self', address, ...position };
}

function params(root: string, overrides: { fetchCap?: number } = {}) {
  return {
    namespace: 'mainnet' as const,
    chainId: 1,
    root: name(root),
    fetchCap: 1000,
    maxLevels: 16,
    now: () => NOW,
    ...overrides,
  };
}

/* Fake world under r.eth */

const R_ETH: FakeDomain = {
  id: 'r',
  label: 'r',
  canonicalName: 'r.eth',
  owner: O,
  indexedResolver: R,
  registeredAt: REGISTERED,
};

const R_CHILDREN: FakeDomain[] = [
  // Two names on W, one of them its primary name
  {
    id: 'a',
    label: 'a',
    canonicalName: 'a.r.eth',
    owner: W,
    indexedEthAddress: W,
  },
  { id: 'b', label: 'b', canonicalName: 'b.r.eth', indexedEthAddress: W },
  // Index says X, RPC says W2
  {
    id: 'c',
    label: 'c',
    canonicalName: 'c.r.eth',
    indexedEthAddress: X,
    registeredAt: REGISTERED,
  },
  { id: 'enc', label: ENCODED, canonicalName: `${ENCODED}.r.eth` },
  { id: 'err', label: 'err', canonicalName: 'err.r.eth', indexedEthAddress: X },
  {
    id: 'old',
    label: 'old',
    canonicalName: 'old.r.eth',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  },
];

const R_HISTORY: Record<string, RecordHistory> = {
  // v1 events carry no timestamp, so block 100 needs one
  a: {
    events: [event('resolver-set', 100, 0, R), event('addr-set', 100, 1, W)],
    complete: true,
  },
  b: {
    events: [
      event('resolver-set', 200, 0, R, V2_AT),
      event('addr-set', 200, 1, W, V2_AT),
    ],
    complete: true,
  },
  c: { events: [event('addr-set', 300, 0, W2)], complete: false },
};

function rWorld(root: FakeDomain = R_ETH) {
  const source = createFakeNameSource({
    domains: [root, ...R_CHILDREN],
    children: { r: R_CHILDREN.map((domain) => domain.id) },
    history: R_HISTORY,
    reportTotals: true,
  });
  const ens = createFakeEnsResolver({
    resolutions: {
      'a.r.eth': { address: W, resolver: R },
      'b.r.eth': { address: W, resolver: R },
      'c.r.eth': { address: W2, resolver: R },
      'err.r.eth': { error: 'ResolverError' },
    },
    primaryNames: { [W]: 'a.r.eth' },
  });
  const chain = createFakeChainReader({
    blockTimes: new Map([[100n, BLOCK_100_AT]]),
  });
  return { source, ens, chain };
}

function depsOf(
  world: {
    source: FakeNameSource;
    ens: FakeEnsResolver;
    chain: FakeChainReader;
  },
  notices: string[] = [],
): NamespaceDeps {
  return {
    names: world.source,
    ens: world.ens,
    chain: world.chain,
    notices,
    secrets: [],
  };
}

// Every call lands in one log, labelled by its pipeline step
function loggedDeps(
  world: ReturnType<typeof rWorld>,
  log: string[],
): NamespaceDeps {
  const { source, ens, chain } = world;
  return {
    names: {
      id: source.id,
      maxParentsPerCall: source.maxParentsPerCall,
      getDomain: (n) => {
        log.push('walk');
        return source.getDomain(n);
      },
      listChildren: (parents, cursor) => {
        log.push('walk');
        return source.listChildren(parents, cursor);
      },
      registryReferrers: (registry) => {
        log.push('walk');
        return source.registryReferrers(registry);
      },
      recordHistory: (domains) => {
        log.push('recordHistory');
        return source.recordHistory(domains);
      },
    },
    ens: {
      resolve: (names, coinType) => {
        log.push('resolve');
        return ens.resolve(names, coinType);
      },
      primaryNames: (addresses) => {
        log.push('primaryNames');
        return ens.primaryNames(addresses);
      },
    },
    chain: {
      blockTimestamps: (blocks) => {
        log.push('blockTimestamps');
        return chain.blockTimestamps(blocks);
      },
    },
    notices: [],
    secrets: [],
  };
}

describe('buildNameMap', () => {
  it('runs walk, resolve, primary names, history, block times in that order', async () => {
    const world = rWorld();
    const log: string[] = [];

    await buildNameMap(
      loggedDeps(world, log),
      params('r.eth'),
      new CallCounter(),
    );

    const steps = log.filter((step, i) => step !== log[i - 1]);
    expect(steps).toEqual([
      'walk',
      'resolve',
      'primaryNames',
      'recordHistory',
      'blockTimestamps',
    ]);
  });

  it('resolves only resolvable names, and asks primary names of the unique wallets', async () => {
    const world = rWorld();

    const result = await buildNameMap(
      depsOf(world),
      params('r.eth'),
      new CallCounter(),
    );

    expect(world.ens.calls).toEqual([
      {
        method: 'resolve',
        names: [
          'r.eth',
          'a.r.eth',
          'b.r.eth',
          'c.r.eth',
          'err.r.eth',
          'old.r.eth',
        ],
        coinType: 60n,
      },
      { method: 'primaryNames', addresses: [W, W2] },
    ]);
    expect(result.resolutions.has(name(`${ENCODED}.r.eth`))).toBe(false);
  });

  it('reads history for bound nodes and block times only for starts without a timestamp', async () => {
    const world = rWorld();

    const result = await buildNameMap(
      depsOf(world),
      params('r.eth'),
      new CallCounter(),
    );

    expect(
      world.source.calls.filter((call) => call.method === 'recordHistory'),
    ).toEqual([{ method: 'recordHistory', ids: ['a', 'b', 'c'] }]);
    expect(world.chain.calls).toEqual([
      { method: 'blockTimestamps', blocks: [100n] },
    ]);
    const windows = result.bindings.map((binding) => [
      binding.nameId,
      binding.validFrom,
      binding.windowSource,
    ]);
    expect(windows).toEqual([
      ['a', BLOCK_100_AT, 'record-history'],
      ['b', V2_AT, 'record-history'],
      ['c', REGISTERED, 'registration'],
    ]);
  });

  it('falls back to the registration date and warns when the RPC has no block time', async () => {
    const world = rWorld();

    const result = await buildNameMap(
      {
        ...depsOf(world),
        chain: { blockTimestamps: () => Promise.resolve(new Map()) },
      },
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.bindings[0]).toMatchObject({
      nameId: 'a',
      validFrom: null,
      windowSource: 'unknown',
    });
    expect(result.warnings).toEqual([
      'no block time from the RPC for 1 of 1 binding start blocks, likely pruned history; those bindings use the registration date',
    ]);
  });

  it('falls back to registration dates with a redacted warning when record history fails', async () => {
    const world = rWorld();
    const failure = new ProviderError(
      'fake: HTTP 500 from https://x.test/k3y',
      {
        provider: 'fake',
        status: 500,
        retryable: true,
      },
    );

    const result = await buildNameMap(
      {
        ...depsOf(world),
        names: {
          ...world.source,
          recordHistory: () => Promise.reject(failure),
        },
        secrets: ['/k3y'],
      },
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.bindings.map((b) => [b.nameId, b.windowSource])).toEqual([
      ['a', 'unknown'],
      ['b', 'unknown'],
      ['c', 'registration'],
    ]);
    expect(result.warnings).toEqual([
      'record history unavailable from fake (fake: HTTP 500 from https://x.test[redacted]); bindings use the registration date',
    ]);
    expect(world.chain.calls).toEqual([]);
  });

  it('rethrows a record history failure that is not a ProviderError', async () => {
    const world = rWorld();
    const failure = new Error('boom');

    const build = buildNameMap(
      {
        ...depsOf(world),
        names: {
          ...world.source,
          recordHistory: () => Promise.reject(failure),
        },
      },
      params('r.eth'),
      new CallCounter(),
    );

    await expect(build).rejects.toBe(failure);
  });

  it('skips primary names, history and block times when nothing is bound', async () => {
    const source = createFakeNameSource({ domains: [R_ETH] });
    const ens = createFakeEnsResolver();
    const chain = createFakeChainReader();

    const result = await buildNameMap(
      depsOf({ source, ens, chain }),
      params('r.eth'),
      new CallCounter(),
    );

    expect(ens.calls.map((call) => call.method)).toEqual(['resolve']);
    expect(source.calls.map((call) => call.method)).not.toContain(
      'recordHistory',
    );
    expect(chain.calls).toEqual([]);
    expect(result.bindings).toEqual([]);
    expect(result.wallets.size).toBe(0);
  });

  it('gives two names on one wallet a single WalletGroup homed at its primary name', async () => {
    const result = await buildNameMap(
      depsOf(rWorld()),
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.wallets.get(W)).toEqual({
      address: W,
      homeNameId: 'a',
      memberNameIds: ['a', 'b'],
    });
    expect([...result.wallets.keys()]).toEqual([W, W2]);
  });

  it('tags expired, unresolvable, index-mismatch and resolution errors', async () => {
    const result = await buildNameMap(
      depsOf(rWorld()),
      params('r.eth'),
      new CallCounter(),
    );

    expect(Object.fromEntries(result.tags)).toEqual({
      r: [],
      enc: ['unresolvable'],
      a: [],
      b: [],
      c: ['index-mismatch'],
      // An error leaves the address unknown, so it is no mismatch
      err: ['resolution-error:ResolverError'],
      old: ['expired'],
    });
  });

  it('fires index-mismatch on a canonical node whose index and RPC addresses differ', async () => {
    const result = await buildNameMap(
      depsOf(rWorld()),
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.tags.get('c')).toContain('index-mismatch');
    expect(result.tags.get('a')).not.toContain('index-mismatch');
  });

  it('tags alias-path and suppresses index-mismatch on a shared-registry child', async () => {
    const source = createFakeNameSource({
      domains: [
        {
          id: 's',
          label: 's',
          canonicalName: 's.eth',
          protocol: 'v2',
          owner: O,
          subregistry: REG,
        },
        {
          id: 'v',
          label: 'v',
          canonicalName: 'v.eth',
          protocol: 'v2',
          owner: O,
          subregistry: REG,
        },
        {
          id: 'k',
          label: 'k',
          canonicalName: 'k.v.eth',
          protocol: 'v2',
          registry: REG,
          indexedEthAddress: X,
        },
      ],
      children: { [REG]: ['k'] },
      referrers: { [REG]: ['s.eth', 'v.eth'] },
    });
    const ens = createFakeEnsResolver({
      resolutions: { 'k.s.eth': { address: W, resolver: R } },
    });

    const result = await buildNameMap(
      depsOf({ source, ens, chain: createFakeChainReader() }),
      params('s.eth'),
      new CallCounter(),
    );

    expect(result.tree.nodes.get('k')?.name).toBe('k.s.eth');
    expect(result.tags.get('k')).toEqual(['alias-path', 'alias-unresolved']);
    expect(result.tree.externalReferrers.get('s')).toEqual(['v.eth']);
  });

  describe('alias-path children of a shared registry', () => {
    const OWN = addr('ab');

    // s.eth and v.eth share REG, whose child k is canonical under v.eth
    function sharedRegistry(
      k: Partial<FakeDomain>,
      resolution: { address: Address; resolver: Address },
    ) {
      const source = createFakeNameSource({
        domains: [
          { id: 's', label: 's', canonicalName: 's.eth', subregistry: REG },
          { id: 'v', label: 'v', canonicalName: 'v.eth', subregistry: REG },
          {
            id: 'k',
            label: 'k',
            canonicalName: 'k.v.eth',
            registry: REG,
            indexedResolver: OWN,
            ...k,
          },
        ],
        children: { [REG]: ['k'] },
        referrers: { [REG]: ['s.eth', 'v.eth'] },
      });
      const ens = createFakeEnsResolver({
        resolutions: { 'k.s.eth': resolution },
      });
      return { source, ens, chain: createFakeChainReader() };
    }

    it('binds no wallet when the path falls back to an ancestor resolver, and tags alias-unresolved', async () => {
      const world = sharedRegistry({}, { address: W, resolver: R });

      const result = await buildNameMap(
        depsOf(world),
        params('s.eth'),
        new CallCounter(),
      );

      expect(result.tags.get('k')).toEqual(['alias-path', 'alias-unresolved']);
      expect(result.bindings).toEqual([]);
      expect(result.wallets.size).toBe(0);
      expect(result.resolutions.get(name('k.s.eth'))).toEqual({
        address: W,
        resolver: R,
        error: null,
      });
      expect(world.source.calls.map((call) => call.method)).not.toContain(
        'recordHistory',
      );
    });

    it('binds normally when the path is answered by its own indexed resolver', async () => {
      const world = sharedRegistry(
        { indexedEthAddress: X },
        { address: W, resolver: `0x${'AB'.repeat(20)}` },
      );

      const result = await buildNameMap(
        depsOf(world),
        params('s.eth'),
        new CallCounter(),
      );

      expect(result.tags.get('k')).toEqual(['alias-path']);
      expect(result.bindings.map((b) => [b.nameId, b.address])).toEqual([
        ['k', W],
      ]);
      expect(result.wallets.get(W)?.memberNameIds).toEqual(['k']);
    });
  });

  it('tags a root with neither owner nor resolver as deleted and still maps it', async () => {
    const deleted: FakeDomain = { id: 'r', label: 'r', canonicalName: 'r.eth' };

    const result = await buildNameMap(
      depsOf(rWorld(deleted)),
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.tags.get('r')).toEqual(['deleted']);
    expect(result.tree.nodes.size).toBe(7);
  });

  it('puts the notices and a truncation notice in warnings', async () => {
    const result = await buildNameMap(
      depsOf(rWorld(), ['keyless ENS subgraph: heavily rate-limited']),
      params('r.eth', { fetchCap: 3 }),
      new CallCounter(),
    );

    expect(result.tree.truncated).toBe(true);
    expect(result.warnings).toEqual([
      'keyless ENS subgraph: heavily rate-limited',
      'walk truncated at 3 names or 16 levels',
    ]);
  });

  it('has no truncation warning for a complete walk', async () => {
    const result = await buildNameMap(
      depsOf(rWorld(), ['n']),
      params('r.eth'),
      new CallCounter(),
    );

    expect(result.warnings).toEqual(['n']);
  });

  it('reports the call counter snapshot and the build parameters', async () => {
    const counter = new CallCounter();
    counter.inc('fake');

    const result = await buildNameMap(
      depsOf(rWorld()),
      params('r.eth'),
      counter,
    );

    expect(result.calls).toEqual({ fake: 1 });
    expect(result.namespace).toBe('mainnet');
    expect(result.root).toBe('r.eth');
  });
});

describe('toNameMapJson', () => {
  it('produces output that parses with NameMapJson', async () => {
    const result = await buildNameMap(
      depsOf(rWorld(), ['n']),
      params('r.eth'),
      new CallCounter(),
    );

    const json = JSON.parse(JSON.stringify(toNameMapJson(result))) as unknown;
    const parsed = NameMapJson.parse(json);

    expect(parsed.root).toBe('r.eth');
    expect(Object.keys(parsed.tree.nodes)).toEqual([
      'r',
      'enc',
      'a',
      'b',
      'c',
      'err',
      'old',
    ]);
    expect(parsed.tree.nodes['r']?.record.registeredAt).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect(parsed.bindings[0]?.validFrom).toBe('2023-01-02T03:04:05.000Z');
    expect(parsed.wallets[W]?.memberNameIds).toEqual(['a', 'b']);
    expect(parsed.resolutions['err.r.eth']?.error).toBe('ResolverError');
    expect(parsed.tags['c']).toEqual(['index-mismatch']);
    expect(parsed.tree.indexedTotal).toEqual({ value: 7, exact: true });
    expect(parsed.warnings).toEqual(['n']);
  });

  it('writes an out-of-range date as null', async () => {
    const root: FakeDomain = { ...R_ETH, expiresAt: new Date(Number.NaN) };

    const result = await buildNameMap(
      depsOf(rWorld(root)),
      params('r.eth'),
      new CallCounter(),
    );

    expect(toNameMapJson(result).tree.nodes['r']?.record.expiresAt).toBeNull();
  });
});

describe('createNamespaceDeps', () => {
  const counter = new CallCounter();

  it('warns about a keyless subgraph and a keyless RPC on mainnet', () => {
    const deps = createNamespaceDeps(resolveNamespace('mainnet', loadEnv({})), {
      counter,
    });

    expect(deps.names.id).toBe('ens-subgraph');
    expect(deps.notices).toEqual([
      'keyless ENS subgraph: heavily rate-limited; set GRAPH_API_KEY',
      'keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_1',
    ]);
  });

  it('has no notices when both keys are set', () => {
    const deps = createNamespaceDeps(
      resolveNamespace(
        'mainnet',
        loadEnv({ GRAPH_API_KEY: 'g', ALCHEMY_API_KEY: 'a' }),
      ),
      { counter },
    );

    expect(deps.notices).toEqual([]);
  });

  it('warns only about the RPC on sepolia-v2, whose source has no key', () => {
    const deps = createNamespaceDeps(
      resolveNamespace('sepolia-v2', loadEnv({})),
      { counter },
    );

    expect(deps.names.id).toBe('ens-dev-graphql');
    expect(deps.notices).toEqual([
      'keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_11155111',
    ]);
  });
});
