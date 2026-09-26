import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ApiError, Graph, GRAPH_VERSION } from './index.ts';

const ROOT = '0xroot';

function minimalGraph(): Record<string, unknown> {
  return {
    version: GRAPH_VERSION,
    nodes: [
      {
        id: ROOT,
        kind: 'name',
        label: 'gloomy.eth',
        address: `0x${'ab'.repeat(20)}`,
        names: [ROOT],
        homeName: ROOT,
        chainId: 11155111,
        verified: true,
        verifiedBy: 'primary-name',
        owner: `0x${'cd'.repeat(20)}`,
        tags: [],
        size: { metric: 'subnamesHeld', value: 0 },
      },
    ],
    edges: [],
    meta: {
      namespace: 'sepolia-v2',
      root: ROOT,
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: { names: 1, indexed: { value: 1, exact: true }, wallets: 1 },
      truncated: [],
      warnings: [],
    },
  };
}

function withRoot(overrides: Record<string, unknown>): unknown {
  const graph = minimalGraph();
  const [root] = graph['nodes'] as Record<string, unknown>[];
  return { ...graph, nodes: [{ ...root, ...overrides }] };
}

describe('Graph', () => {
  it('parses a one-node graph with a full meta', () => {
    const parsed = Graph.parse(minimalGraph());

    expect(parsed.version).toBe(1);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.meta.totals.indexed).toEqual({ value: 1, exact: true });
  });

  it('rejects an uppercase address', () => {
    const graph = withRoot({ address: `0x${'AB'.repeat(20)}` });

    expect(Graph.safeParse(graph).success).toBe(false);
  });

  it('rejects another version', () => {
    const graph = { ...minimalGraph(), version: 2 };

    expect(Graph.safeParse(graph).success).toBe(false);
  });

  it('rejects a computedAt that is not a date', () => {
    const graph = minimalGraph();
    const meta = graph['meta'] as Record<string, unknown>;

    expect(
      Graph.safeParse({ ...graph, meta: { ...meta, computedAt: 'soon' } })
        .success,
    ).toBe(false);
  });
});

describe('ApiError', () => {
  it('parses an error body', () => {
    expect(
      ApiError.parse({ error: { code: 'not-found', message: 'x' } }),
    ).toEqual({ error: { code: 'not-found', message: 'x' } });
  });

  it('rejects an unknown code', () => {
    expect(
      ApiError.safeParse({ error: { code: 'teapot', message: 'x' } }).success,
    ).toBe(false);
  });
});

describe('schema module', () => {
  it('imports only zod, so the browser can load it', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual(['zod']);
  });
});
