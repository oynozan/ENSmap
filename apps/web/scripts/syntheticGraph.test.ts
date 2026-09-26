import { Graph } from '@ensmap/core/schema';
import { describe, expect, it } from 'vitest';

import { syntheticGraph } from './syntheticGraph.ts';

describe('syntheticGraph', () => {
  it('builds a 301-node tree that parses as a Graph', () => {
    const graph = Graph.parse(syntheticGraph(20, 14));
    expect(graph.nodes).toHaveLength(301);
    expect(graph.edges).toHaveLength(300);
    expect(graph.meta.totals.names).toBe(301);
  });

  it('gives the root and every wallet-bearing name the name kind', () => {
    const graph = syntheticGraph(3, 2);
    const root = graph.nodes[0];
    expect(root?.id).toBe(graph.meta.root);
    expect(graph.nodes.filter((node) => node.kind === 'name')).toHaveLength(4);
    const names = graph.nodes.filter(
      (node) => node.kind === 'name' && node.id !== graph.meta.root,
    );
    for (const name of names) {
      expect(name.address).toMatch(/^0x[0-9a-f]{40}$/);
      expect(name.homeName).toBe(name.id);
      expect(name.size.value).toBe(2);
    }
    expect(root?.size.value).toBe(9);
  });

  it('keeps every edge on known nodes, sorted by id', () => {
    const graph = syntheticGraph(4, 3);
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
    }
    const edgeIds = graph.edges.map((edge) => edge.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
  });
});
