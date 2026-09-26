import type { Graph, GraphEdge, GraphNode } from '@ensmap/core/schema';
import { describe, expect, it } from 'vitest';

import { buildModel, radiusFor, sameWallet } from './model.ts';

const WALLET = `0x${'ab'.repeat(20)}`;

function node(id: string, label: string, extra: Partial<GraphNode> = {}) {
  return {
    id,
    kind: 'subname',
    label,
    tags: [],
    size: { metric: 'subnamesHeld', value: 0 },
    ...extra,
  } satisfies GraphNode;
}

function edge(source: string, target: string): GraphEdge {
  return {
    id: `subname:${source}:${target}`,
    source,
    target,
    kind: 'subname',
    directed: true,
  };
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return {
    version: 1,
    nodes,
    edges,
    meta: {
      namespace: 'sepolia-v2',
      root: nodes[0]?.id ?? '',
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: {
        names: nodes.length,
        indexed: { value: nodes.length, exact: true },
        wallets: 1,
      },
      truncated: [],
      warnings: [],
    },
  };
}

const sample = graph(
  [
    node('r', 'seller-a.eth', {
      kind: 'name',
      size: { metric: 'subnamesHeld', value: 3 },
    }),
    node('v', 'agent-1.seller-a.eth', { address: WALLET, verified: true }),
    node('u', 'agent-2.seller-a.eth', { address: WALLET, verified: false }),
    node('n', 'obs.seller-a.eth', { tags: ['expired'] }),
  ],
  [edge('r', 'v'), edge('r', 'u'), edge('r', 'n'), edge('r', 'gone')],
);

describe('radiusFor', () => {
  it('starts from the base radius of each kind', () => {
    expect(radiusFor('subname', false, 0)).toBe(5);
    expect(radiusFor('name', false, 0)).toBe(10);
    expect(radiusFor('name', true, 0)).toBe(26);
  });

  it('grows strictly with the size value and caps at 48', () => {
    const values = [0, 1, 2, 5, 10, 50, 100];
    const radii = values.map((value) => radiusFor('subname', false, value));
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1] ?? Infinity);
    }
    expect(radiusFor('subname', false, 10_000)).toBe(48);
    expect(radiusFor('name', true, 10_000)).toBe(48);
  });
});

describe('buildModel', () => {
  const model = buildModel(sample);

  it('maps nodes in graph order with radii and the root flag', () => {
    expect(model.nodes.map((n) => n.id)).toEqual(['r', 'v', 'u', 'n']);
    expect(model.nodes.map((n) => n.index)).toEqual([0, 1, 2, 3]);
    expect(model.nodes.map((n) => n.isRoot)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(model.nodes[0]?.radius).toBe(radiusFor('name', true, 3));
    expect(model.indexById.get('u')).toBe(2);
  });

  it('maps stroke from the wallet binding', () => {
    expect(model.nodes.map((n) => n.stroke)).toEqual([
      'none',
      'verified',
      'unverified',
      'none',
    ]);
  });

  it('marks expired names', () => {
    expect(model.nodes.map((n) => n.expired)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('cuts labels at the first dot except for the root', () => {
    expect(model.nodes[0]?.shortLabel).toBe('seller-a.eth');
    expect(model.nodes[1]?.shortLabel).toBe('agent-1');
    expect(model.nodes[1]?.label).toBe('agent-1.seller-a.eth');
  });

  it('drops edges to unknown ids', () => {
    expect(model.links).toEqual([
      { source: 0, target: 1, kind: 'subname' },
      { source: 0, target: 2, kind: 'subname' },
      { source: 0, target: 3, kind: 'subname' },
    ]);
  });
});

describe('sameWallet', () => {
  const model = buildModel(sample);

  it('groups nodes that share an address', () => {
    expect(sameWallet(model, 1)).toEqual(new Set([1, 2]));
    expect(sameWallet(model, 2)).toEqual(new Set([1, 2]));
  });

  it('returns only the node when it has no wallet', () => {
    expect(sameWallet(model, 3)).toEqual(new Set([3]));
  });
});
