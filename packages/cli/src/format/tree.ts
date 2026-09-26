import {
  beautifyName,
  compareLabels,
  type InterpretedName,
} from '@ensmap/core/ens';
import type {
  Address,
  Binding,
  NameMapResult,
  TreeNode,
} from '@ensmap/core/names';

const INDENT = '  ';
const SEPARATOR = ' · ';

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function names(list: readonly InterpretedName[]): string {
  return list.map(beautifyName).join(', ');
}

function walletParts(r: NameMapResult, binding: Binding | undefined): string[] {
  if (binding === undefined) {
    return ['no wallet'];
  }
  const parts = [
    shortAddress(binding.address),
    binding.verified ? 'verified' : 'unverified',
  ];
  const homeId = r.wallets.get(binding.address)?.homeNameId;
  const home = homeId === undefined ? undefined : r.tree.nodes.get(homeId);
  if (home !== undefined) {
    parts.push(
      home.record.id === binding.nameId
        ? 'home'
        : `same wallet as ${beautifyName(home.name)}`,
    );
  }
  return parts;
}

function nodeLine(
  r: NameMapResult,
  node: TreeNode,
  binding: Binding | undefined,
): string {
  const { tree } = r;
  const id = node.record.id;
  const parts = [beautifyName(node.name), ...walletParts(r, binding)];

  // A node is printed under its first parent, the root under none
  const printedUnder = id === tree.rootId ? undefined : node.parentIds[0];
  const otherParents = [...new Set(node.parentIds)]
    .filter((parentId) => parentId !== printedUnder && parentId !== id)
    .flatMap((parentId) => {
      const parent = tree.nodes.get(parentId);
      return parent === undefined ? [] : [beautifyName(parent.name)];
    });
  if (node.parentIds.includes(id)) {
    otherParents.push('itself (its registry contains it)');
  }
  if (otherParents.length > 0) {
    parts.push(`also under: ${otherParents.join(', ')}`);
  }

  const tags = r.tags.get(id) ?? [];
  const canonical = node.record.canonicalName;
  if (tags.includes('alias-path') && canonical !== null) {
    parts.push(`canonical: ${beautifyName(canonical)}`);
  }
  const shared = tree.externalReferrers.get(id) ?? [];
  if (shared.length > 0) {
    parts.push(`registry shared with: ${names(shared)}`);
  }
  if (tags.length > 0) {
    parts.push(`tags: ${tags.join(', ')}`);
  }
  return parts.join(SEPARATOR);
}

function footer(r: NameMapResult): string {
  const { nodes, indexedTotal, truncated } = r.tree;
  const indexed = `${indexedTotal.exact ? '' : '≥'}${indexedTotal.value}`;
  return [
    `${nodes.size} names (indexed: ${indexed})`,
    `truncated: ${truncated ? 'yes' : 'no'}`,
    `wallets: ${r.wallets.size}`,
  ].join(SEPARATOR);
}

export function formatTree(r: NameMapResult): string {
  const { tree } = r;
  const bindings = new Map(r.bindings.map((b) => [b.nameId, b]));
  const children = new Map<string, TreeNode[]>();
  for (const node of tree.nodes.values()) {
    const parentId = node.parentIds[0];
    if (node.record.id === tree.rootId || parentId === undefined) {
      continue;
    }
    children.set(parentId, [...(children.get(parentId) ?? []), node]);
  }

  const lines: string[] = [];
  const visit = (node: TreeNode, depth: number): void => {
    const id = node.record.id;
    lines.push(`${INDENT.repeat(depth)}${nodeLine(r, node, bindings.get(id))}`);
    const below = (children.get(id) ?? []).toSorted((a, b) =>
      compareLabels(a.name, b.name),
    );
    for (const child of below) {
      visit(child, depth + 1);
    }
  };
  const root = tree.nodes.get(tree.rootId);
  if (root !== undefined) {
    visit(root, 0);
  }

  lines.push(footer(r), ...r.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join('\n')}\n`;
}
