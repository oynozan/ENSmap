/*
 * Name to wallet bindings.
 * A node's wallet and effective resolver come from resolving its in-scope
 * path. An alias path answered by a resolver other than the node's indexed
 * one, such as an ancestor's wildcard fallback, binds nothing, since that
 * answer is the ancestor's record. The binding is verified when the wallet's
 * primary name is one of the node's names, or when the wallet owns the node.
 * Its window starts where the record history last made the wallet the
 * effective value, falling back to the registration date.
 */
import type { InterpretedName } from '../ens/names.ts';
import type {
  Address,
  NameTree,
  RecordEvent,
  RecordHistory,
  TreeNode,
} from './types.ts';

export interface Binding {
  nameId: string;
  name: InterpretedName;
  chainId: number;
  address: Address;
  resolver: Address | null;
  verified: boolean;
  verifiedBy: 'primary-name' | 'owner' | null;
  validFrom: Date | null;
  validTo: null;
  windowSource: 'record-history' | 'registration' | 'unknown';
  source: string;
}

export interface DeriveBindingsInput {
  tree: NameTree;
  chainId: number;
  source: string;
  resolutions: Map<
    InterpretedName,
    { address: Address | null; resolver: Address | null }
  >;
  primaryNames: Map<Address, InterpretedName | null>;
  history: Map<string, RecordHistory> | null;
  blockTimes: Map<bigint, Date>;
}

export type EventPosition = Pick<
  RecordEvent,
  'block' | 'logIndex' | 'timestamp'
>;

// An unlinked resolver serves the record that v1 sources write as 'self'
const SELF_RECORD = 'self';

export function lowerAddress(address: Address): Address {
  return address.toLowerCase() as Address;
}

// A non-null name wins over a null one under another casing of the address
export function primaryNameLookup(
  primaryNames: ReadonlyMap<Address, InterpretedName | null>,
): Map<Address, InterpretedName> {
  const lookup = new Map<Address, InterpretedName>();
  for (const [address, primary] of primaryNames) {
    const key = lowerAddress(address);
    if (primary !== null && !lookup.has(key)) {
      lookup.set(key, primary);
    }
  }
  return lookup;
}

function byPosition(a: RecordEvent, b: RecordEvent): number {
  if (a.block !== b.block) {
    return a.block < b.block ? -1 : 1;
  }
  return a.logIndex - b.logIndex;
}

export function bindingStart(
  events: readonly RecordEvent[],
  wallet: Address,
  seedResolver: Address | null,
): EventPosition | null {
  const sorted = events.toSorted(byPosition);
  const target = lowerAddress(wallet);
  // Before a history's first resolver-set the name had no resolver
  let active = sorted.some((event) => event.kind === 'resolver-set')
    ? null
    : seedResolver && lowerAddress(seedResolver);
  const links = new Map<Address, string>();
  const values = new Map<string, Address | null>();
  const slot = (resolver: Address, record: string) =>
    `${lowerAddress(resolver)} ${record}`;

  let effective: Address | null = null;
  let start: EventPosition | null = null;
  for (const event of sorted) {
    switch (event.kind) {
      case 'resolver-set':
        active = event.resolver && lowerAddress(event.resolver);
        break;
      case 'record-linked':
        links.set(lowerAddress(event.resolver), event.record);
        break;
      case 'addr-set':
        values.set(
          slot(event.resolver, event.record),
          event.address && lowerAddress(event.address),
        );
        break;
      case 'records-cleared':
        values.delete(slot(event.resolver, event.record));
        break;
    }
    const next =
      active === null
        ? null
        : (values.get(slot(active, links.get(active) ?? SELF_RECORD)) ?? null);
    // Paired events repeat a value, so only a change moves the start
    if (next !== effective) {
      effective = next;
      if (next === target) {
        const { block, logIndex, timestamp } = event;
        start = { block, logIndex, timestamp };
      }
    }
  }
  return effective === target ? start : null;
}

export function isAliasUnresolved(
  node: TreeNode,
  resolution: { resolver: Address | null },
): boolean {
  const { canonicalName, indexedResolver } = node.record;
  if (canonicalName === null || canonicalName === node.name) {
    return false;
  }
  const resolved = resolution.resolver && lowerAddress(resolution.resolver);
  return resolved !== (indexedResolver && lowerAddress(indexedResolver));
}

export function nameMatches(node: TreeNode, name: InterpretedName): boolean {
  return (
    node.name === name ||
    node.aliasNames.includes(name) ||
    node.record.canonicalName === name
  );
}

function verification(
  node: TreeNode,
  wallet: Address,
  primary: InterpretedName | undefined,
): Binding['verifiedBy'] {
  if (primary !== undefined && nameMatches(node, primary)) {
    return 'primary-name';
  }
  const owner = node.record.owner;
  return owner !== null && lowerAddress(owner) === wallet ? 'owner' : null;
}

function validity(
  node: TreeNode,
  wallet: Address,
  resolver: Address | null,
  input: DeriveBindingsInput,
): Pick<Binding, 'validFrom' | 'windowSource'> {
  const history = input.history?.get(node.record.id);
  if (history?.complete === true) {
    const start = bindingStart(history.events, wallet, resolver);
    const time =
      start === null
        ? undefined
        : (start.timestamp ?? input.blockTimes.get(start.block));
    if (time !== undefined) {
      return { validFrom: time, windowSource: 'record-history' };
    }
  }
  const registeredAt = node.record.registeredAt;
  return registeredAt === null
    ? { validFrom: null, windowSource: 'unknown' }
    : { validFrom: registeredAt, windowSource: 'registration' };
}

export function deriveBindings(input: DeriveBindingsInput): Binding[] {
  const primaryNames = primaryNameLookup(input.primaryNames);
  const bindings: Binding[] = [];
  for (const node of input.tree.nodes.values()) {
    const resolution = input.resolutions.get(node.name);
    if (
      resolution === undefined ||
      resolution.address === null ||
      isAliasUnresolved(node, resolution)
    ) {
      continue;
    }
    const address = lowerAddress(resolution.address);
    const resolver = resolution.resolver && lowerAddress(resolution.resolver);
    const verifiedBy = verification(node, address, primaryNames.get(address));
    bindings.push({
      nameId: node.record.id,
      name: node.name,
      chainId: input.chainId,
      address,
      resolver,
      verified: verifiedBy !== null,
      verifiedBy,
      ...validity(node, address, resolver, input),
      validTo: null,
      source: input.source,
    });
  }
  return bindings;
}
