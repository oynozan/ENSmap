/*
 * End-to-end name map for one root.
 * The pipeline walks the tree, resolves every resolvable name over RPC, reads
 * the primary names of the wallets found, reads the record history of the
 * bound nodes, fills in block times for binding starts that lack one, then
 * derives bindings and home names. Tags and warnings annotate the result for
 * display.
 */
import type { NamespaceId } from '../config/namespaces.ts';
import { isResolvable, type InterpretedName } from '../ens/names.ts';
import { ProviderError } from '../http/client.ts';
import type { CallCounter } from '../http/counter.ts';
import { redact } from '../http/redact.ts';
import type { ChainReader } from '../rpc/chainReader.ts';
import type { EnsResolver, Resolution } from '../rpc/ensResolver.ts';
import {
  bindingStart,
  deriveBindings,
  isAliasUnresolved,
  type Binding,
} from './bindings.ts';
import { assignHomeNames, type WalletGroup } from './homes.ts';
import type {
  Address,
  NameSource,
  NameTree,
  RecordHistory,
  TreeNode,
} from './types.ts';
import { walkTree } from './walk.ts';

export interface NamespaceDeps {
  names: NameSource;
  ens: EnsResolver;
  chain: ChainReader;
  notices: string[];
  secrets: readonly string[];
}

export interface NameMapResult {
  namespace: NamespaceId;
  root: InterpretedName;
  tree: NameTree;
  resolutions: Map<InterpretedName, Resolution>;
  bindings: Binding[];
  wallets: Map<Address, WalletGroup>;
  tags: Map<string, string[]>;
  calls: Record<string, number>;
  warnings: string[];
}

export interface BuildNameMapParams {
  namespace: NamespaceId;
  chainId: number;
  root: InterpretedName;
  fetchCap: number;
  maxLevels: number;
  now: () => Date;
}

// Bindings on the namespace's own chain use the ETH coin type
const ETH_COIN_TYPE = 60n;

function boundNodes(
  tree: NameTree,
  resolutions: ReadonlyMap<InterpretedName, Resolution>,
): TreeNode[] {
  return [...tree.nodes.values()].filter((node) => {
    const resolution = resolutions.get(node.name);
    return resolution?.address != null && !isAliasUnresolved(node, resolution);
  });
}

// A failed history read costs the windows their precision, not the map
async function readHistory(
  deps: NamespaceDeps,
  bound: readonly TreeNode[],
): Promise<{
  history: Map<string, RecordHistory> | null;
  warning: string | null;
}> {
  if (bound.length === 0) {
    return { history: null, warning: null };
  }
  try {
    const records = bound.map((node) => node.record);
    return { history: await deps.names.recordHistory(records), warning: null };
  } catch (error) {
    if (!(error instanceof ProviderError)) {
      throw error;
    }
    const message = redact(error.message, deps.secrets);
    return {
      history: null,
      warning: `record history unavailable from ${deps.names.id} (${message}); bindings use the registration date`,
    };
  }
}

// Blocks whose binding start carries no timestamp, as ENSv1 events do not
function blocksWithoutTime(
  nodes: readonly TreeNode[],
  resolutions: ReadonlyMap<InterpretedName, Resolution>,
  history: ReadonlyMap<string, RecordHistory> | null,
): bigint[] {
  const blocks = new Set<bigint>();
  for (const node of nodes) {
    const entry = history?.get(node.record.id);
    const resolution = resolutions.get(node.name);
    if (entry?.complete !== true || resolution?.address == null) {
      continue;
    }
    const start = bindingStart(
      entry.events,
      resolution.address,
      resolution.resolver,
    );
    if (start !== null && start.timestamp === null) {
      blocks.add(start.block);
    }
  }
  return [...blocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function tagsOf(
  node: TreeNode,
  tree: NameTree,
  resolution: Resolution | undefined,
  now: Date,
): string[] {
  const { record } = node;
  const tags: string[] = [];
  if (
    node.record.id === tree.rootId &&
    record.owner === null &&
    record.indexedResolver === null
  ) {
    tags.push('deleted');
  }
  if (
    record.expired ||
    (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime())
  ) {
    tags.push('expired');
  }
  if (!isResolvable(node.name)) {
    tags.push('unresolvable');
  }
  const canonical = record.canonicalName;
  if (canonical !== null && canonical !== node.name) {
    tags.push('alias-path');
  }
  if (resolution !== undefined && isAliasUnresolved(node, resolution)) {
    tags.push('alias-unresolved');
  }
  if (resolution?.error != null) {
    tags.push(`resolution-error:${resolution.error}`);
  } else if (
    canonical === node.name &&
    resolution !== undefined &&
    record.indexedEthAddress !== null &&
    record.indexedEthAddress !== resolution.address
  ) {
    tags.push('index-mismatch');
  }
  return tags;
}

export async function buildNameMap(
  deps: NamespaceDeps,
  params: BuildNameMapParams,
  counter: CallCounter,
): Promise<NameMapResult> {
  const { fetchCap, maxLevels } = params;
  const tree = await walkTree(deps.names, params.root, { fetchCap, maxLevels });

  const nodes = [...tree.nodes.values()];
  const resolutions = await deps.ens.resolve(
    nodes.map((node) => node.name).filter(isResolvable),
    ETH_COIN_TYPE,
  );

  const wallets = [
    ...new Set(
      [...resolutions.values()].flatMap((resolution) =>
        resolution.address === null ? [] : [resolution.address],
      ),
    ),
  ].sort();
  const primaryNames =
    wallets.length === 0
      ? new Map<Address, InterpretedName | null>()
      : await deps.ens.primaryNames(wallets);

  const bound = boundNodes(tree, resolutions);
  const { history, warning: historyWarning } = await readHistory(deps, bound);

  const missing = blocksWithoutTime(bound, resolutions, history);
  const blockTimes =
    missing.length === 0
      ? new Map<bigint, Date>()
      : await deps.chain.blockTimestamps(missing);

  const bindings = deriveBindings({
    tree,
    chainId: params.chainId,
    source: deps.names.id,
    resolutions,
    primaryNames,
    history,
    blockTimes,
  });
  const groups = assignHomeNames(bindings, tree, primaryNames);

  const now = params.now();
  const tags = new Map(
    nodes.map((node) => [
      node.record.id,
      tagsOf(node, tree, resolutions.get(node.name), now),
    ]),
  );

  const warnings = [...deps.notices];
  if (historyWarning !== null) {
    warnings.push(historyWarning);
  }
  const untimed = missing.filter((block) => !blockTimes.has(block)).length;
  if (untimed > 0) {
    warnings.push(
      `no block time from the RPC for ${untimed} of ${missing.length} binding start blocks, likely pruned history; those bindings use the registration date`,
    );
  }
  if (tree.truncated) {
    warnings.push(`walk truncated at ${fetchCap} names or ${maxLevels} levels`);
  }

  return {
    namespace: params.namespace,
    root: params.root,
    tree,
    resolutions,
    bindings,
    wallets: groups,
    tags,
    calls: counter.snapshot(),
    warnings,
  };
}
