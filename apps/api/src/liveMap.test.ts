import { loadEnv } from '@ensmap/core/config';
import { parseNameInput, type InterpretedName } from '@ensmap/core/ens';
import { createFixtureFetch, FIXTURES_DIR } from '@ensmap/core/http';
import { Graph } from '@ensmap/core/schema';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLiveMapService } from './mapService.ts';

const NOW = Date.parse('2026-09-26T00:00:00.000Z');

// viem sends CCIP-Read gateway calls through the global fetch
const ccipFetch = createFixtureFetch({
  dir: FIXTURES_DIR,
  mode: 'replay',
  secrets: [],
  inner: globalThis.fetch,
});

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

describe('createLiveMapService against recorded fixtures', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', ccipFetch);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('builds the seller-a.eth graph once and caches it', async () => {
    const lines: string[] = [];
    const maps = createLiveMapService({
      env: loadEnv({ ENSMAP_FIXTURES: 'replay' }),
      sleep: () => Promise.resolve(),
      now: () => NOW,
      log: (line) => lines.push(line),
    });

    const graph = Graph.parse(
      await maps.nameMap('sepolia-v2', name('seller-a.eth')),
    );

    const rootId = graph.meta.root;
    const root = graph.nodes.find((node) => node.id === rootId);
    expect(root?.label).toBe('seller-a.eth');
    expect(root?.kind).toBe('name');
    expect(root?.sharedWith).toContain('vet402.eth');
    expect(graph.meta.computedAt).toBe('2026-09-26T00:00:00.000Z');

    for (const label of ['agent-2', 'atst', 'obs']) {
      const node = graph.nodes.find(
        (candidate) => candidate.label === `${label}.seller-a.eth`,
      );
      expect(node?.canonical).toBe(`${label}.vet402.eth`);
      expect(node?.tags).toContain('alias-unresolved');
      expect(node).not.toHaveProperty('address');
    }

    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.source).toBe(rootId);
    }

    await maps.nameMap('sepolia-v2', name('seller-a.eth'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^map sepolia-v2 seller-a\.eth · API calls: .*ens-dev-graphql=\d+/,
    );
  });
});
