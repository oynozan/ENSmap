/*
 * Level-by-level breadth-first walk of a name's subname tree.
 * A parent's listing key is its subregistry, or its own id when it has none,
 * and each key is listed once through its first parent in name order. The
 * listed children then fan out to every in-scope parent with that key, so an
 * ENSv2 registry shared by several parents, or containing its own parent,
 * yields one node with several parent edges instead of duplicates or a loop.
 */
import {
  childName,
  compareLabels,
  type InterpretedName,
} from '../ens/names.ts';
import type {
  Address,
  DomainRecord,
  NameSource,
  NameTree,
  TreeNode,
} from './types.ts';

export class NameNotFoundError extends Error {
  override name = 'NameNotFoundError';
  readonly input: InterpretedName;

  constructor(input: InterpretedName) {
    super(`name not found: ${input}`);
    this.input = input;
  }
}

export interface WalkOptions {
  fetchCap: number;
  maxLevels: number;
}

interface Listing {
  children: DomainRecord[];
  total: number | undefined;
}

function listingKey(record: DomainRecord): string {
  return record.subregistry ?? record.id;
}

function byName(a: TreeNode, b: TreeNode): number {
  return compareLabels(a.name, b.name);
}

function byLabel(a: DomainRecord, b: DomainRecord): number {
  return compareLabels(a.label, b.label) || compareLabels(a.id, b.id);
}

function assertIntegerAtLeast(what: string, value: number, min: number) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${what} must be an integer >= ${min}, got ${value}`);
  }
}

export async function walkTree(
  source: NameSource,
  root: InterpretedName,
  opts: WalkOptions,
): Promise<NameTree> {
  assertIntegerAtLeast('fetchCap', opts.fetchCap, 1);
  assertIntegerAtLeast('maxLevels', opts.maxLevels, 0);
  assertIntegerAtLeast(
    `${source.id} maxParentsPerCall`,
    source.maxParentsPerCall,
    1,
  );

  const rootRecord = await source.getDomain(root);
  if (rootRecord === null) {
    throw new NameNotFoundError(root);
  }
  const rootNode: TreeNode = {
    record: rootRecord,
    name: root,
    aliasNames: [],
    parentIds: [],
    level: 0,
  };
  const nodes = new Map([[rootRecord.id, rootNode]]);
  const listings = new Map<string, Listing>();
  let truncated = false;
  let frontier = [rootNode];

  for (let level = 0; frontier.length > 0 && !truncated; level += 1) {
    const parents = frontier.toSorted(byName);
    // The boundary level is listed only to learn if a deeper one exists
    const capacity = level < opts.maxLevels ? opts.fetchCap - nodes.size : 0;
    await listPendingKeys(source, parents, listings, nodes, capacity);

    frontier = [];
    for (const parent of parents) {
      const listing = listings.get(listingKey(parent.record));
      for (const child of listing?.children ?? []) {
        const existing = nodes.get(child.id);
        if (existing !== undefined) {
          existing.parentIds.push(parent.record.id);
          existing.aliasNames.push(childName(child.label, parent.name));
          existing.level = Math.min(existing.level, level + 1);
        } else if (level < opts.maxLevels && nodes.size < opts.fetchCap) {
          const created: TreeNode = {
            record: child,
            name: childName(child.label, parent.name),
            aliasNames: [],
            parentIds: [parent.record.id],
            level: level + 1,
          };
          nodes.set(child.id, created);
          frontier.push(created);
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    rootId: rootRecord.id,
    nodes,
    truncated,
    indexedTotal: indexedTotal(listings, rootRecord, nodes.size, truncated),
    externalReferrers: await findExternalReferrers(source, nodes),
  };
}

// Stops once more new children arrive than capacity allows
async function listPendingKeys(
  source: NameSource,
  parents: readonly TreeNode[],
  listings: Map<string, Listing>,
  nodes: ReadonlyMap<string, TreeNode>,
  capacity: number,
): Promise<void> {
  const representatives: DomainRecord[] = [];
  const pendingKeys = new Set<string>();
  for (const parent of parents) {
    const key = listingKey(parent.record);
    if (!listings.has(key) && !pendingKeys.has(key)) {
      pendingKeys.add(key);
      representatives.push(parent.record);
    }
  }

  const fetchedIds = new Set<string>();
  const newIds = new Set<string>();
  const perCall = source.maxParentsPerCall;
  for (
    let start = 0;
    start < representatives.length && newIds.size <= capacity;
    start += perCall
  ) {
    const batch = representatives.slice(start, start + perCall);
    const batchListings = new Map<string, Listing>();
    for (const representative of batch) {
      const listing: Listing = { children: [], total: undefined };
      listings.set(listingKey(representative), listing);
      batchListings.set(representative.id, listing);
    }
    const listingFor = (parentId: string): Listing => {
      const listing = batchListings.get(parentId);
      if (listing === undefined) {
        throw new Error(
          `${source.id} listChildren answered for parent ${parentId}, which was not requested`,
        );
      }
      return listing;
    };

    let cursor: string | null = null;
    do {
      const page = await source.listChildren(batch, cursor);
      if (page.next !== null && page.next === cursor) {
        throw new Error(
          `${source.id} listChildren answered cursor ${JSON.stringify(cursor)} with the same cursor, so paging would never end`,
        );
      }
      for (const { parentId, record } of page.items) {
        const listing = listingFor(parentId);
        if (fetchedIds.has(record.id)) {
          continue;
        }
        fetchedIds.add(record.id);
        listing.children.push(record);
        if (!nodes.has(record.id)) {
          newIds.add(record.id);
        }
      }
      for (const [parentId, total] of page.totals ?? []) {
        listingFor(parentId).total = total;
      }
      cursor = page.next;
    } while (cursor !== null && newIds.size <= capacity);

    for (const listing of batchListings.values()) {
      listing.children.sort(byLabel);
    }
  }
}

function indexedTotal(
  listings: ReadonlyMap<string, Listing>,
  rootRecord: DomainRecord,
  nodeCount: number,
  truncated: boolean,
): NameTree['indexedTotal'] {
  let sum = 0;
  let everyTotal = true;
  for (const listing of listings.values()) {
    if (listing.total === undefined) {
      everyTotal = false;
    } else {
      sum += listing.total;
    }
  }
  // A root listed inside its own registry is already part of that total
  const rootListed =
    rootRecord.registry !== null &&
    listings.get(rootRecord.registry)?.total !== undefined;
  return {
    value: Math.max(nodeCount, sum + (rootListed ? 0 : 1)),
    exact: !truncated && everyTotal,
  };
}

async function findExternalReferrers(
  source: NameSource,
  nodes: ReadonlyMap<string, TreeNode>,
): Promise<Map<string, InterpretedName[]>> {
  // Referrers are canonical names, so canonical names count as in scope
  const inScope = new Set<string>();
  const registries = new Set<Address>();
  for (const node of nodes.values()) {
    inScope.add(node.name);
    node.aliasNames.forEach((alias) => inScope.add(alias));
    if (node.record.canonicalName !== null) {
      inScope.add(node.record.canonicalName);
    }
    if (node.record.protocol === 'v2' && node.record.subregistry !== null) {
      registries.add(node.record.subregistry);
    }
  }

  const answers = await Promise.all(
    [...registries].map(async (registry) => {
      const referrers = await source.registryReferrers(registry);
      const outside = [
        ...new Set((referrers ?? []).filter((name) => !inScope.has(name))),
      ].sort(compareLabels);
      return [registry, outside] as const;
    }),
  );
  const outsideByRegistry = new Map(answers);

  const external = new Map<string, InterpretedName[]>();
  for (const node of nodes.values()) {
    const registry = node.record.subregistry;
    const outside =
      node.record.protocol === 'v2' && registry !== null
        ? outsideByRegistry.get(registry)
        : undefined;
    if (outside !== undefined && outside.length > 0) {
      external.set(node.record.id, [...outside]);
    }
  }
  return external;
}
