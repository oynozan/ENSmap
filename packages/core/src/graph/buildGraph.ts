/*
 * Graph JSON from a name map (web map spec section 2).
 * The root and each wallet's home name are name bubbles and every other node
 * is a subname. Each in-tree parent becomes one subname edge, except a
 * registry that contains its own node, which only tags it self-parent. Size
 * counts the distinct descendants below a node.
 */
import { beautifyName } from '../ens/names.ts';
import type { Binding } from '../names/bindings.ts';
import type { NameMapResult } from '../names/buildNameMap.ts';
import type { WalletGroup } from '../names/homes.ts';
import type { NameTree, TreeNode } from '../names/types.ts';
import {
  GRAPH_VERSION,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from '../schema/index.ts';

export interface BuildGraphOptions {
  computedAt: Date;
  fetchCap: number;
}

function inTreeParents(tree: NameTree, node: TreeNode): string[] {
  const id = node.record.id;
  return [
    ...new Set(
      node.parentIds.filter(
        (parentId) => parentId !== id && tree.nodes.has(parentId),
      ),
    ),
  ];
}

function subnameEdges(tree: NameTree): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [id, node] of tree.nodes) {
    for (const parentId of inTreeParents(tree, node)) {
      edges.push({
        id: `subname:${parentId}:${id}`,
        source: parentId,
        target: id,
        kind: 'subname',
        directed: true,
      });
    }
  }
  // Code-unit order, which localeCompare does not give
  return edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A walk per node is enough at the 1,000-name fetch cap
function descendantCounts(
  ids: readonly string[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.source) ?? [];
    list.push(edge.target);
    children.set(edge.source, list);
  }
  const counts = new Map<string, number>();
  for (const id of ids) {
    const seen = new Set<string>([id]);
    const stack = [id];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      for (const child of children.get(next) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    counts.set(id, seen.size - 1);
  }
  return counts;
}

function walletFields(
  binding: Binding | undefined,
  group: WalletGroup | undefined,
): Pick<
  GraphNode,
  'address' | 'chainId' | 'verified' | 'verifiedBy' | 'homeName' | 'names'
> {
  if (binding === undefined) {
    return {};
  }
  return {
    address: binding.address,
    chainId: binding.chainId,
    verified: binding.verified,
    ...(binding.verifiedBy === null ? {} : { verifiedBy: binding.verifiedBy }),
    ...(group === undefined
      ? {}
      : {
          homeName: group.homeNameId,
          names: [
            group.homeNameId,
            ...group.memberNameIds.filter((id) => id !== group.homeNameId),
          ],
        }),
  };
}

export function buildGraph(r: NameMapResult, opts: BuildGraphOptions): Graph {
  const { tree } = r;
  const edges = subnameEdges(tree);
  const sizes = descendantCounts([...tree.nodes.keys()], edges);
  const bindings = new Map(
    r.bindings.map((binding) => [binding.nameId, binding]),
  );
  const homes = new Set(
    [...r.wallets.values()].map((group) => group.homeNameId),
  );

  const nodes = [...tree.nodes].map(([id, node]): GraphNode => {
    const { record } = node;
    const tags = [...(r.tags.get(id) ?? [])];
    if (node.parentIds.includes(id)) {
      tags.push('self-parent');
    }
    const binding = bindings.get(id);
    const group =
      binding === undefined ? undefined : r.wallets.get(binding.address);
    const sharedWith = tree.externalReferrers.get(id) ?? [];
    return {
      id,
      kind: id === tree.rootId || homes.has(id) ? 'name' : 'subname',
      label: beautifyName(node.name),
      ...walletFields(binding, group),
      ...(record.owner === null ? {} : { owner: record.owner }),
      ...(tags.includes('alias-path') && record.canonicalName !== null
        ? { canonical: beautifyName(record.canonicalName) }
        : {}),
      ...(sharedWith.length === 0
        ? {}
        : { sharedWith: sharedWith.map(beautifyName) }),
      tags,
      size: { metric: 'subnamesHeld', value: sizes.get(id) ?? 0 },
    };
  });

  return {
    version: GRAPH_VERSION,
    nodes,
    edges,
    meta: {
      namespace: r.namespace,
      root: tree.rootId,
      computedAt: opts.computedAt.toISOString(),
      caps: { fetch: opts.fetchCap },
      filters: {},
      totals: {
        names: tree.nodes.size,
        indexed: { ...tree.indexedTotal },
        wallets: r.wallets.size,
      },
      truncated: tree.truncated ? ['names'] : [],
      warnings: [...r.warnings],
    },
  };
}
