import {
  compareLabels,
  firstLabel,
  nameDepth,
  type InterpretedName,
} from '../ens/names.ts';
import {
  lowerAddress,
  nameMatches,
  primaryNameLookup,
  type Binding,
} from './bindings.ts';
import type { Address, NameTree, TreeNode } from './types.ts';

export interface WalletGroup {
  address: Address;
  homeNameId: string;
  memberNameIds: string[];
}

// Shallowest first, then by first label and name, with the id breaking ties
function byHomeOrder(a: TreeNode, b: TreeNode): number {
  return (
    nameDepth(a.name) - nameDepth(b.name) ||
    compareLabels(firstLabel(a.name), firstLabel(b.name)) ||
    compareLabels(a.name, b.name) ||
    compareLabels(a.record.id, b.record.id)
  );
}

export function assignHomeNames(
  bindings: readonly Binding[],
  tree: NameTree,
  primaryNames: Map<Address, InterpretedName | null>,
): Map<Address, WalletGroup> {
  const membersByWallet = new Map<Address, Map<string, TreeNode>>();
  for (const binding of bindings) {
    const node = tree.nodes.get(binding.nameId);
    if (node === undefined) {
      throw new Error(`binding for ${binding.nameId} has no node in the tree`);
    }
    const wallet = lowerAddress(binding.address);
    const members = membersByWallet.get(wallet) ?? new Map<string, TreeNode>();
    members.set(node.record.id, node);
    membersByWallet.set(wallet, members);
  }

  const primaries = primaryNameLookup(primaryNames);
  const groups = new Map<Address, WalletGroup>();
  for (const wallet of [...membersByWallet.keys()].toSorted()) {
    const members = [...(membersByWallet.get(wallet)?.values() ?? [])].sort(
      byHomeOrder,
    );
    const primary = primaries.get(wallet);
    const home =
      members.find(
        (node) => primary !== undefined && nameMatches(node, primary),
      ) ?? members[0];
    if (home !== undefined) {
      groups.set(wallet, {
        address: wallet,
        homeNameId: home.record.id,
        memberNameIds: members.map((node) => node.record.id),
      });
    }
  }
  return groups;
}
