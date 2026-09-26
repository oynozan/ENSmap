// A deterministic two-level tree for frame timing, in the API's Graph shape
import type { Graph, GraphEdge, GraphNode } from '@ensmap/core/schema';

const ROOT_LABEL = 'synthetic.eth';

function hexId(n: number, width: number): string {
  return `0x${n.toString(16).padStart(width, '0')}`;
}

function pad(n: number): string {
  return String(n + 1).padStart(2, '0');
}

export function syntheticGraph(names: number, subnamesPerName: number): Graph {
  let next = 0;
  const nodeId = () => hexId(next++, 64);
  const rootId = nodeId();
  const root: GraphNode = {
    id: rootId,
    kind: 'name',
    label: ROOT_LABEL,
    tags: [],
    size: { metric: 'subnamesHeld', value: names * (1 + subnamesPerName) },
  };
  // Kept apart so the output follows the API's BFS node order
  const nameNodes: GraphNode[] = [];
  const subnameNodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const subnameEdge = (source: string, target: string): GraphEdge => ({
    id: `subname:${source}:${target}`,
    source,
    target,
    kind: 'subname',
    directed: true,
  });

  for (let i = 0; i < names; i++) {
    const id = nodeId();
    const address = hexId(i + 1, 40);
    const label = `name-${pad(i)}.${ROOT_LABEL}`;
    // Even subnames share their parent's wallet; odd ones have none
    const subnames = Array.from({ length: subnamesPerName }, (_, j) => ({
      id: nodeId(),
      label: `sub-${pad(j)}.${label}`,
      onWallet: j % 2 === 0,
    }));
    const walletNames = [
      id,
      ...subnames.filter((s) => s.onWallet).map((s) => s.id),
    ];

    nameNodes.push({
      id,
      kind: 'name',
      label,
      address,
      names: walletNames,
      homeName: id,
      chainId: 11155111,
      verified: true,
      verifiedBy: 'primary-name',
      tags: [],
      size: { metric: 'subnamesHeld', value: subnamesPerName },
    });
    edges.push(subnameEdge(rootId, id));

    for (const sub of subnames) {
      subnameNodes.push({
        id: sub.id,
        kind: 'subname',
        label: sub.label,
        ...(sub.onWallet
          ? {
              address,
              names: walletNames,
              homeName: id,
              chainId: 11155111,
              verified: true,
              verifiedBy: 'owner' as const,
            }
          : {}),
        tags: [],
        size: { metric: 'subnamesHeld', value: 0 },
      });
      edges.push(subnameEdge(id, sub.id));
    }
  }

  const nodes = [root, ...nameNodes, ...subnameNodes];
  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    version: 1,
    nodes,
    edges,
    meta: {
      namespace: 'sepolia-v2',
      root: rootId,
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: {
        names: nodes.length,
        indexed: { value: nodes.length, exact: true },
        wallets: names,
      },
      truncated: [],
      warnings: [],
    },
  };
}
