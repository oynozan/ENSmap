import { labelhash } from 'viem';
import { z } from 'zod';

import type { EndpointConfig } from '../../config/namespaces.ts';
import {
  interpretLabel,
  nameId,
  type Hex,
  type InterpretedName,
} from '../../ens/names.ts';
import type { HttpClient } from '../../http/client.ts';
import { graphqlRequest } from '../../http/graphql.ts';
import type {
  Address,
  ChildrenPage,
  DomainRecord,
  NameSource,
  RecordEvent,
  RecordHistory,
} from '../../names/types.ts';
import {
  DOMAIN_BY_ID,
  MAX_OR_FILTERS,
  NODE_HISTORY,
  PAGE_SIZE,
  REFERRERS,
  REGISTRY_CHILDREN,
  RESOLVER_HISTORY,
} from './queries.ts';

const SOURCE_ID = 'ens-dev-graphql';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const ETH_COIN_TYPE = 60;
// Record id 0 is the resolver's "no record"
const NO_RECORD = '0';

/* Response shapes */

const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const UnixSeconds = z.number().int().nonnegative();
const AddressRef = z.object({ address: z.string() });

const DevDomain = z.object({
  id: Hash,
  name: z.string().nullable(),
  labelName: z.string().nullable(),
  labelhash: Hash,
  protocol: z.enum(['v1', 'v2']),
  owner: z.object({ id: z.string() }),
  resolver: AddressRef.nullable(),
  resolvedAddress: z.object({ id: z.string() }).nullable(),
  subregistry: AddressRef.nullable(),
  parent: z.object({ id: Hash, subregistry: AddressRef.nullable() }).nullable(),
  registrationDate: UnixSeconds.nullable(),
  createdAt: UnixSeconds,
  expiryDate: UnixSeconds.nullable(),
});
type DevDomain = z.infer<typeof DevDomain>;

const DomainData = z.object({ domain: DevDomain.nullable() });

const ChildrenData = z.object({
  domainConnection: z.object({
    totalCount: z.number().int().nonnegative().nullable(),
    pageInfo: z
      .object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
      .refine((page) => !page.hasNextPage || page.endCursor !== null, {
        message: 'hasNextPage without an endCursor',
      }),
    edges: z.array(z.object({ node: DevDomain })),
  }),
});

const ReferrersData = z.object({
  registry: z
    .object({
      referencedBy: z.array(z.object({ name: z.string().nullable() })),
    })
    .nullable(),
});

// Event ids are <transaction hash>-<log index>
const DevEvent = z.object({
  id: z.string().regex(/^0x[0-9a-fA-F]{64}-\d+$/),
  blockNumber: z.number().int().nonnegative(),
  timestamp: UnixSeconds,
  type: z.string(),
  data: z.string(),
});
type DevEvent = z.infer<typeof DevEvent>;

const NodeHistoryData = z.object({
  events: z.array(DevEvent.extend({ namehash: Hash })),
});
const ResolverHistoryData = z.object({
  addressUpdates: z.array(DevEvent),
  defaultLinks: z.array(DevEvent),
});

const RecordId = z.string().regex(/^(0|[1-9]\d*)$/);
const ResolverUpdatedData = z.object({ resolver: z.string() });
const LinkedData = z.object({ resolver: z.string(), recordId: RecordId });
const AddressUpdatedData = z.object({
  resolver: z.string(),
  recordId: RecordId,
  coinType: z.number().int(),
  address: z.string(),
});

// Event data is a JSON string whose shape depends on the event type
function eventData<T>(row: DevEvent, shape: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch (error) {
    throw new Error(`${SOURCE_ID}: event ${row.id} has invalid data JSON`, {
      cause: error,
    });
  }
  return shape.parse(parsed);
}

/* Value mapping */

// Lowercase, with 0x0 and anything that is not 20 bytes as null
function toAddress(value: string | null | undefined): Address | null {
  const lower = value?.toLowerCase();
  return lower !== undefined &&
    lower !== ZERO_ADDRESS &&
    ADDRESS_PATTERN.test(lower)
    ? (lower as Address)
    : null;
}

// 0 and values past the Date range mean no date
function unixDate(seconds: number | null): Date | null {
  if (seconds === null || seconds === 0) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canonicalName(name: string | null): InterpretedName | null {
  if (name === null || name === '') {
    return null;
  }
  return name
    .split('.')
    .map((label) => interpretLabel(label, labelhash(label)))
    .join('.') as InterpretedName;
}

function toRecord(
  d: DevDomain,
  registry: Address | null,
  now: Date,
): DomainRecord {
  const expiresAt = unixDate(d.expiryDate);
  return {
    id: d.id,
    label: interpretLabel(d.labelName, d.labelhash as Hex),
    canonicalName: canonicalName(d.name),
    protocol: d.protocol,
    registry,
    subregistry: toAddress(d.subregistry?.address),
    owner: toAddress(d.owner.id),
    indexedResolver: toAddress(d.resolver?.address),
    indexedEthAddress: toAddress(d.resolvedAddress?.id),
    registeredAt: unixDate(d.registrationDate ?? d.createdAt),
    expiresAt,
    expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
  };
}

/* Record history */

interface Position {
  block: bigint;
  logIndex: number;
  timestamp: Date;
}

interface Link extends Position {
  resolver: Address;
  record: string;
  own: boolean;
}

type AddrSet = Extract<RecordEvent, { kind: 'addr-set' }>;
type RecordLinked = Extract<RecordEvent, { kind: 'record-linked' }>;

interface NodeEvents {
  id: string;
  events: RecordEvent[];
  links: Link[];
  resolvers: Set<Address>;
}

function position(row: DevEvent): Position {
  return {
    block: BigInt(row.blockNumber),
    logIndex: Number(row.id.slice(row.id.lastIndexOf('-') + 1)),
    timestamp: new Date(row.timestamp * 1000),
  };
}

type Ordered = Pick<Position, 'block' | 'logIndex'>;

function comparePositions(a: Ordered, b: Ordered): number {
  if (a.block !== b.block) {
    return a.block < b.block ? -1 : 1;
  }
  return a.logIndex - b.logIndex;
}

function link(row: DevEvent, own: boolean): Link | null {
  const data = eventData(row, LinkedData);
  const resolver = toAddress(data.resolver);
  return resolver === null
    ? null
    : { resolver, record: data.recordId, own, ...position(row) };
}

// Own link wins, else the resolver default, and record 0 unlinks either
function linkEvents(own: Link[], defaults: Link[]): RecordLinked[] {
  let ownRecord = NO_RECORD;
  let defaultRecord = NO_RECORD;
  let current: string | undefined;
  const events: RecordLinked[] = [];
  for (const next of [...own, ...defaults].sort(comparePositions)) {
    if (next.own) {
      ownRecord = next.record;
    } else {
      defaultRecord = next.record;
    }
    const effective = ownRecord === NO_RECORD ? defaultRecord : ownRecord;
    if (effective !== current) {
      current = effective;
      const { resolver, block, logIndex, timestamp } = next;
      events.push({
        kind: 'record-linked',
        resolver,
        record: effective,
        block,
        logIndex,
        timestamp,
      });
    }
  }
  return events;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group === undefined) {
      groups.set(k, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
}

export function createEnsDevGraphqlSource(
  cfg: EndpointConfig,
  http: HttpClient,
  now: () => Date = () => new Date(),
): NameSource {
  function query<T>(
    doc: string,
    variables: Record<string, unknown>,
    data: z.ZodType<T>,
  ): Promise<T> {
    return graphqlRequest(http, cfg.url, doc, variables, data, cfg.headers);
  }

  async function nodeEvents(
    domains: readonly DomainRecord[],
  ): Promise<{ byNode: Map<string, NodeEvents>; complete: boolean }> {
    const byNode = new Map<string, NodeEvents>();
    for (const domain of domains) {
      const resolvers = new Set<Address>();
      if (domain.indexedResolver !== null) {
        resolvers.add(domain.indexedResolver);
      }
      byNode.set(domain.id.toLowerCase(), {
        id: domain.id,
        events: [],
        links: [],
        resolvers,
      });
    }

    const { events } = await query(
      NODE_HISTORY,
      { nodes: [...byNode.keys()].map((namehash) => ({ namehash })) },
      NodeHistoryData,
    );
    for (const row of events) {
      const node = byNode.get(row.namehash.toLowerCase());
      if (node === undefined) {
        continue;
      }
      if (row.type === 'ResolverUpdated') {
        const resolver = toAddress(
          eventData(row, ResolverUpdatedData).resolver,
        );
        node.events.push({ kind: 'resolver-set', resolver, ...position(row) });
        if (resolver !== null) {
          node.resolvers.add(resolver);
        }
      } else if (row.type === 'Linked') {
        const own = link(row, true);
        if (own !== null) {
          node.links.push(own);
          node.resolvers.add(own.resolver);
        }
      }
    }
    return { byNode, complete: events.length < PAGE_SIZE };
  }

  async function resolverEvents(resolvers: readonly Address[]): Promise<{
    addressUpdates: DevEvent[];
    defaultLinks: DevEvent[];
    complete: boolean;
  }> {
    const pages = await Promise.all(
      chunk(resolvers, MAX_OR_FILTERS).map((part) =>
        query(
          RESOLVER_HISTORY,
          { resolvers: part.map((contractAddress) => ({ contractAddress })) },
          ResolverHistoryData,
        ),
      ),
    );
    return {
      addressUpdates: pages.flatMap((page) => page.addressUpdates),
      defaultLinks: pages.flatMap((page) => page.defaultLinks),
      complete: pages.every(
        (page) =>
          page.addressUpdates.length < PAGE_SIZE &&
          page.defaultLinks.length < PAGE_SIZE,
      ),
    };
  }

  async function historyBatch(
    domains: readonly DomainRecord[],
  ): Promise<[string, RecordHistory][]> {
    const nodes = await nodeEvents(domains);
    const resolvers = new Set(
      [...nodes.byNode.values()].flatMap((node) => [...node.resolvers]),
    );
    const onResolvers =
      resolvers.size === 0
        ? { addressUpdates: [], defaultLinks: [], complete: true }
        : await resolverEvents([...resolvers]);

    const defaults = groupBy(
      onResolvers.defaultLinks.flatMap((row) => link(row, false) ?? []),
      (entry) => entry.resolver,
    );
    const addressSets = groupBy(
      onResolvers.addressUpdates.flatMap((row): AddrSet[] => {
        const data = eventData(row, AddressUpdatedData);
        const resolver = toAddress(data.resolver);
        if (data.coinType !== ETH_COIN_TYPE || resolver === null) {
          return [];
        }
        return [
          {
            kind: 'addr-set',
            resolver,
            record: data.recordId,
            address: toAddress(data.address),
            ...position(row),
          },
        ];
      }),
      (event) => `${event.resolver} ${event.record}`,
    );

    const complete = nodes.complete && onResolvers.complete;
    return [...nodes.byNode.values()].map((node) => {
      const events = [...node.events];
      for (const resolver of node.resolvers) {
        const links = linkEvents(
          node.links.filter((own) => own.resolver === resolver),
          defaults.get(resolver) ?? [],
        );
        events.push(...links);
        const records = new Set(links.map((event) => event.record));
        records.delete(NO_RECORD);
        for (const record of records) {
          events.push(...(addressSets.get(`${resolver} ${record}`) ?? []));
        }
      }
      return [node.id, { events: events.sort(comparePositions), complete }];
    });
  }

  return {
    id: SOURCE_ID,
    maxParentsPerCall: 1,

    async getDomain(name: InterpretedName): Promise<DomainRecord | null> {
      const { domain } = await query(
        DOMAIN_BY_ID,
        { id: nameId(name) },
        DomainData,
      );
      return domain === null
        ? null
        : toRecord(
            domain,
            toAddress(domain.parent?.subregistry?.address),
            now(),
          );
    },

    async listChildren(
      parents: readonly DomainRecord[],
      cursor: string | null,
    ): Promise<ChildrenPage> {
      const [parent] = parents;
      if (parent === undefined || parents.length > 1) {
        throw new RangeError(
          `${SOURCE_ID} lists exactly one parent per call, got ${parents.length}`,
        );
      }
      const registry = parent.subregistry;
      if (registry === null) {
        return { items: [], next: null, totals: new Map([[parent.id, 0]]) };
      }

      const { domainConnection } = await query(
        REGISTRY_CHILDREN,
        { registry, after: cursor },
        ChildrenData,
      );
      const at = now();
      const { totalCount, pageInfo, edges } = domainConnection;
      return {
        items: edges.map(({ node }) => ({
          parentId: parent.id,
          record: toRecord(node, registry, at),
        })),
        next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
        ...(totalCount === null
          ? {}
          : { totals: new Map([[parent.id, totalCount]]) }),
      };
    },

    async registryReferrers(
      registry: Address,
    ): Promise<InterpretedName[] | null> {
      const data = await query(REFERRERS, { address: registry }, ReferrersData);
      return (data.registry?.referencedBy ?? []).flatMap(
        (referrer) => canonicalName(referrer.name) ?? [],
      );
    },

    async recordHistory(
      domains: readonly DomainRecord[],
    ): Promise<Map<string, RecordHistory>> {
      const unique = [
        ...new Map(domains.map((domain) => [domain.id, domain])).values(),
      ];
      const batches = await Promise.all(
        chunk(unique, MAX_OR_FILTERS).map(historyBatch),
      );
      return new Map(batches.flat());
    },
  };
}
