import type { Graph, GraphNode, NodeKind } from '@ensmap/core/schema';

import { RADII } from './forceConfig.ts';
import type { MapModel, SimLink, SimNode, Stroke } from './types.ts';

export function radiusFor(
  kind: NodeKind,
  isRoot: boolean,
  sizeValue: number,
): number {
  const base = isRoot
    ? RADII.root
    : kind === 'name'
      ? RADII.name
      : RADII.subname;
  return Math.min(
    RADII.max,
    base + RADII.perSqrt * (Math.sqrt(1 + sizeValue) - 1),
  );
}

function strokeFor(node: GraphNode): Stroke {
  if (node.address === undefined) return 'none';
  return node.verified === true ? 'verified' : 'unverified';
}

function shortLabelOf(label: string): string {
  const dot = label.indexOf('.');
  return dot === -1 ? label : label.slice(0, dot);
}

export function buildModel(graph: Graph): MapModel {
  const indexById = new Map<string, number>();
  const nodes = graph.nodes.map((node, index): SimNode => {
    indexById.set(node.id, index);
    const isRoot = node.id === graph.meta.root;
    return {
      id: node.id,
      index,
      kind: node.kind,
      isRoot,
      radius: radiusFor(node.kind, isRoot, node.size.value),
      label: node.label,
      shortLabel: isRoot ? node.label : shortLabelOf(node.label),
      stroke: strokeFor(node),
      expired: node.tags.includes('expired'),
      walletKey: node.address ?? null,
    };
  });

  const links: SimLink[] = [];
  for (const edge of graph.edges) {
    const source = indexById.get(edge.source);
    const target = indexById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    links.push({ source, target, kind: edge.kind });
  }

  return { nodes, links, indexById };
}

export function sameWallet(model: MapModel, index: number): Set<number> {
  const key = model.nodes[index]?.walletKey ?? null;
  if (key === null) return new Set([index]);
  const group = new Set<number>();
  for (const node of model.nodes) {
    if (node.walletKey === key) group.add(node.index);
  }
  return group;
}
