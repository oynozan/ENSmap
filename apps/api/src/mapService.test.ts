import type { NamespaceId } from '@ensmap/core/config';
import { parseNameInput, type InterpretedName } from '@ensmap/core/ens';
import type { Graph } from '@ensmap/core/schema';
import { describe, expect, it } from 'vitest';

import {
  createCachedMapService,
  MAP_CACHE_MAX_ENTRIES,
  MAP_CACHE_TTL_MS,
} from './mapService.ts';

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function graph(namespace: NamespaceId, root: string): Graph {
  return {
    version: 1,
    nodes: [
      {
        id: root,
        kind: 'name',
        label: root,
        tags: [],
        size: { metric: 'subnamesHeld', value: 0 },
      },
    ],
    edges: [],
    meta: {
      namespace,
      root,
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: { names: 1, indexed: { value: 1, exact: true }, wallets: 0 },
      truncated: [],
      warnings: [],
    },
  };
}

function setup() {
  let clock = 0;
  const calls: string[] = [];
  let next: (namespace: NamespaceId, root: string) => Promise<Graph> = (
    namespace,
    root,
  ) => Promise.resolve(graph(namespace, root));
  const maps = createCachedMapService(
    (namespace, root) => {
      calls.push(`${namespace}:${root}`);
      return next(namespace, root);
    },
    {
      ttlMs: MAP_CACHE_TTL_MS,
      maxEntries: MAP_CACHE_MAX_ENTRIES,
      now: () => clock,
    },
  );
  return {
    maps,
    calls,
    setClock: (ms: number) => {
      clock = ms;
    },
    setBuild: (build: typeof next) => {
      next = build;
    },
  };
}

describe('createCachedMapService', () => {
  it('keeps a map for 6 hours and at most 100 entries', () => {
    expect(MAP_CACHE_TTL_MS).toBe(6 * 60 * 60 * 1000);
    expect(MAP_CACHE_MAX_ENTRIES).toBe(100);
  });

  it('builds once within the TTL and again after it', async () => {
    const { maps, calls, setClock } = setup();

    const first = await maps.nameMap('sepolia-v2', name('a.eth'));
    setClock(MAP_CACHE_TTL_MS);
    const second = await maps.nameMap('sepolia-v2', name('a.eth'));

    expect(calls).toEqual(['sepolia-v2:a.eth']);
    expect(second).toBe(first);

    setClock(MAP_CACHE_TTL_MS + 1);
    await maps.nameMap('sepolia-v2', name('a.eth'));

    expect(calls).toEqual(['sepolia-v2:a.eth', 'sepolia-v2:a.eth']);
  });

  it('shares one in-flight build between concurrent calls', async () => {
    const { maps, calls, setBuild } = setup();
    let release: (value: Graph) => void = () => undefined;
    setBuild(
      () =>
        new Promise<Graph>((resolve) => {
          release = resolve;
        }),
    );

    const a = maps.nameMap('sepolia-v2', name('a.eth'));
    const b = maps.nameMap('sepolia-v2', name('a.eth'));
    release(graph('sepolia-v2', 'a.eth'));

    const [ga, gb] = await Promise.all([a, b]);
    expect(calls).toEqual(['sepolia-v2:a.eth']);
    expect(gb).toBe(ga);
  });

  it('does not keep a rejected build', async () => {
    const { maps, calls, setBuild } = setup();
    setBuild(() => Promise.reject(new Error('source down')));

    await expect(maps.nameMap('sepolia-v2', name('a.eth'))).rejects.toThrow(
      'source down',
    );

    setBuild((namespace, root) => Promise.resolve(graph(namespace, root)));
    const retried = await maps.nameMap('sepolia-v2', name('a.eth'));

    expect(calls).toEqual(['sepolia-v2:a.eth', 'sepolia-v2:a.eth']);
    expect(retried.meta.root).toBe('a.eth');
  });

  it('rejects instead of throwing when the build throws synchronously', async () => {
    const { maps, setBuild } = setup();
    setBuild(() => {
      throw new Error('bad config');
    });

    await expect(maps.nameMap('mainnet', name('a.eth'))).rejects.toThrow(
      'bad config',
    );
  });

  it('drops the oldest entry past 100 keys', async () => {
    const { maps, calls } = setup();
    for (let i = 1; i <= MAP_CACHE_MAX_ENTRIES + 1; i += 1) {
      await maps.nameMap('sepolia-v2', name(`n${i}.eth`));
    }
    expect(calls).toHaveLength(101);

    for (const kept of ['n2.eth', 'n50.eth', 'n101.eth']) {
      await maps.nameMap('sepolia-v2', name(kept));
    }
    expect(calls).toHaveLength(101);

    await maps.nameMap('sepolia-v2', name('n1.eth'));
    expect(calls).toHaveLength(102);
    expect(calls.at(-1)).toBe('sepolia-v2:n1.eth');
  });

  it('never evicts a build that is still in flight', async () => {
    const { maps, calls, setBuild } = setup();
    let release: (value: Graph) => void = () => undefined;
    setBuild(
      () =>
        new Promise<Graph>((resolve) => {
          release = resolve;
        }),
    );
    const pending = maps.nameMap('sepolia-v2', name('slow.eth'));

    setBuild((namespace, root) => Promise.resolve(graph(namespace, root)));
    for (let i = 1; i <= MAP_CACHE_MAX_ENTRIES; i += 1) {
      await maps.nameMap('sepolia-v2', name(`n${i}.eth`));
    }
    const again = maps.nameMap('sepolia-v2', name('slow.eth'));
    release(graph('sepolia-v2', 'slow.eth'));

    expect(await again).toBe(await pending);
    expect(calls.filter((call) => call === 'sepolia-v2:slow.eth')).toHaveLength(
      1,
    );
  });

  it('keys entries by namespace and name', async () => {
    const { maps, calls } = setup();

    const sepolia = await maps.nameMap('sepolia-v2', name('a.eth'));
    const mainnet = await maps.nameMap('mainnet', name('a.eth'));

    expect(calls).toEqual(['sepolia-v2:a.eth', 'mainnet:a.eth']);
    expect(sepolia.meta.namespace).toBe('sepolia-v2');
    expect(mainnet.meta.namespace).toBe('mainnet');
  });
});
