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
  ADDR_EVENTS,
  CHILDREN,
  DOMAIN_BY_ID,
  PAGE_SIZE,
  RESOLVER_CHANGES,
} from './queries.ts';

const MAX_PARENTS_PER_CALL = 100;
const HISTORY_BATCH_SIZE = 100;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const ETH_NODE = nameId('eth');
// NameWrapper, from https://raw.githubusercontent.com/ensdomains/ens-subgraph/723f1b6/subgraph.yaml
const NAME_WRAPPER = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401'.toLowerCase();

/* Response shapes */

const UnixSeconds = z.string().regex(/^\d+$/);
const EventId = z.string().regex(/^\d+-\d+$/);
const Ref = z.object({ id: z.string() });
const ResolverRef = z.object({ id: z.string(), address: z.string() });

const SubgraphDomain = z.object({
  id: z.string(),
  name: z.string().nullable(),
  labelName: z.string().nullable(),
  labelhash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  parent: Ref.nullable(),
  owner: Ref,
  registrant: Ref.nullable(),
  wrappedOwner: Ref.nullable(),
  resolver: z.object({ address: z.string() }).nullable(),
  resolvedAddress: Ref.nullable(),
  createdAt: UnixSeconds,
  expiryDate: UnixSeconds.nullable(),
  registration: z
    .object({ registrationDate: UnixSeconds, expiryDate: UnixSeconds })
    .nullable(),
});
type SubgraphDomain = z.infer<typeof SubgraphDomain>;

const DomainData = z.object({ domain: SubgraphDomain.nullable() });
const ChildrenData = z.object({
  domains: z.array(SubgraphDomain.extend({ parent: Ref })),
});

const EventFields = { id: EventId, blockNumber: z.number().int() };
const ResolverChangesData = z.object({
  set: z.array(
    z.object({
      ...EventFields,
      domain: Ref,
      resolver: z.object({ address: z.string() }),
    }),
  ),
  cleared: z.array(z.object({ ...EventFields, domain: Ref })),
});
type ResolverChangesData = z.infer<typeof ResolverChangesData>;

const AddrEventsData = z.object({
  addrChangeds: z.array(
    z.object({ ...EventFields, resolver: ResolverRef, addr: Ref }),
  ),
  multicoinAddrChangeds: z.array(
    z.object({ ...EventFields, resolver: ResolverRef, addr: z.string() }),
  ),
  versionChangeds: z.array(z.object({ ...EventFields, resolver: ResolverRef })),
});

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

function unixDate(seconds: string): Date {
  return new Date(Number(seconds) * 1000);
}

function canonicalName(name: string | null): InterpretedName | null {
  if (name === null) {
    return null;
  }
  return name
    .split('.')
    .map((label) => interpretLabel(label, labelhash(label)))
    .join('.') as InterpretedName;
}

function ownerOf(d: SubgraphDomain, isEth2ld: boolean): Address | null {
  // wrappedOwner goes stale after an unwrap, so trust it only while wrapped
  if (d.owner.id.toLowerCase() === NAME_WRAPPER) {
    return toAddress(d.wrappedOwner?.id);
  }
  return toAddress(isEth2ld ? d.registrant?.id : d.owner.id);
}

// Outside .eth 2LDs, Domain.expiryDate is set only while it is enforced
function expiryOf(d: SubgraphDomain, isEth2ld: boolean): Date | null {
  if (isEth2ld) {
    return d.registration === null ? null : unixDate(d.registration.expiryDate);
  }
  return d.expiryDate === null || d.expiryDate === '0'
    ? null
    : unixDate(d.expiryDate);
}

function toRecord(d: SubgraphDomain, now: Date): DomainRecord {
  const isEth2ld = d.parent?.id.toLowerCase() === ETH_NODE;
  const expiresAt = expiryOf(d, isEth2ld);
  let registeredAt: Date | null = unixDate(d.createdAt);
  if (isEth2ld) {
    registeredAt =
      d.registration === null
        ? null
        : unixDate(d.registration.registrationDate);
  }
  return {
    id: d.id,
    label: interpretLabel(d.labelName, d.labelhash as Hex),
    canonicalName: canonicalName(d.name),
    protocol: 'v1',
    registry: null,
    subregistry: null,
    owner: ownerOf(d, isEth2ld),
    indexedResolver: toAddress(d.resolver?.address),
    indexedEthAddress: toAddress(d.resolvedAddress?.id),
    registeredAt,
    expiresAt,
    expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
  };
}

/* Record history */

function position(row: { id: string; blockNumber: number }): {
  block: bigint;
  logIndex: number;
  timestamp: null;
} {
  return {
    block: BigInt(row.blockNumber),
    logIndex: Number(row.id.slice(row.id.indexOf('-') + 1)),
    timestamp: null,
  };
}

function compareEvents(a: RecordEvent, b: RecordEvent): number {
  if (a.block !== b.block) {
    return a.block < b.block ? -1 : 1;
  }
  return a.logIndex - b.logIndex;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function createEnsSubgraphSource(
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

  // Each alias pages on its own cursor, rows of an exhausted alias are ignored
  async function resolverChanges(ids: string[]): Promise<ResolverChangesData> {
    const all: ResolverChangesData = { set: [], cleared: [] };
    const cursor = { set: '', cleared: '' };
    const done = { set: false, cleared: false };
    while (!done.set || !done.cleared) {
      const page = await query(
        RESOLVER_CHANGES,
        { ids, afterSet: cursor.set, afterCleared: cursor.cleared },
        ResolverChangesData,
      );
      if (!done.set) {
        all.set.push(...page.set);
        cursor.set = page.set.at(-1)?.id ?? cursor.set;
        done.set = page.set.length < PAGE_SIZE;
      }
      if (!done.cleared) {
        all.cleared.push(...page.cleared);
        cursor.cleared = page.cleared.at(-1)?.id ?? cursor.cleared;
        done.cleared = page.cleared.length < PAGE_SIZE;
      }
    }
    return all;
  }

  async function historyBatch(
    domains: readonly DomainRecord[],
  ): Promise<[string, RecordHistory][]> {
    const events = new Map<string, RecordEvent[]>(
      domains.map((domain) => [domain.id, []]),
    );
    const push = (domainId: string, event: RecordEvent): void => {
      events.get(domainId)?.push(event);
    };

    const changes = await resolverChanges(domains.map((domain) => domain.id));
    // Resolver entity id <resolverAddress>-<node> to the domain it serves
    const resolverDomains = new Map<string, string>();
    for (const row of changes.set) {
      const resolver = toAddress(row.resolver.address);
      push(row.domain.id, { kind: 'resolver-set', resolver, ...position(row) });
      if (resolver !== null) {
        resolverDomains.set(
          `${resolver}-${row.domain.id.toLowerCase()}`,
          row.domain.id,
        );
      }
    }
    for (const row of changes.cleared) {
      push(row.domain.id, {
        kind: 'resolver-set',
        resolver: null,
        ...position(row),
      });
    }

    let complete = true;
    if (resolverDomains.size > 0) {
      const data = await query(
        ADDR_EVENTS,
        { resolverIds: [...resolverDomains.keys()] },
        AddrEventsData,
      );
      // A full list may have cut older events of any domain in the batch
      complete = [
        data.addrChangeds,
        data.multicoinAddrChangeds,
        data.versionChangeds,
      ].every((list) => list.length < PAGE_SIZE);

      const seenAddrSets = new Set<string>();
      const addrSets = [
        ...data.addrChangeds.map((row) => ({ ...row, address: row.addr.id })),
        ...data.multicoinAddrChangeds.map((row) => ({
          ...row,
          address: row.addr,
        })),
      ];
      for (const row of addrSets) {
        const domainId = resolverDomains.get(row.resolver.id.toLowerCase());
        const resolver = toAddress(row.resolver.address);
        const key = `${domainId ?? ''} ${row.id}`;
        if (
          domainId === undefined ||
          resolver === null ||
          seenAddrSets.has(key)
        ) {
          continue;
        }
        seenAddrSets.add(key);
        push(domainId, {
          kind: 'addr-set',
          resolver,
          record: 'self',
          address: toAddress(row.address),
          ...position(row),
        });
      }
      for (const row of data.versionChangeds) {
        const domainId = resolverDomains.get(row.resolver.id.toLowerCase());
        const resolver = toAddress(row.resolver.address);
        if (domainId === undefined || resolver === null) {
          continue;
        }
        push(domainId, {
          kind: 'records-cleared',
          resolver,
          record: 'self',
          ...position(row),
        });
      }
    }

    return [...events].map(([domainId, list]) => [
      domainId,
      { events: list.sort(compareEvents), complete },
    ]);
  }

  return {
    id: 'ens-subgraph',
    maxParentsPerCall: MAX_PARENTS_PER_CALL,

    async getDomain(name: InterpretedName): Promise<DomainRecord | null> {
      const { domain } = await query(
        DOMAIN_BY_ID,
        { id: nameId(name) },
        DomainData,
      );
      return domain === null ? null : toRecord(domain, now());
    },

    async listChildren(
      parents: readonly DomainRecord[],
      cursor: string | null,
    ): Promise<ChildrenPage> {
      const { domains } = await query(
        CHILDREN,
        { parents: parents.map((parent) => parent.id), after: cursor ?? '' },
        ChildrenData,
      );
      const at = now();
      const last = domains.at(-1);
      return {
        items: domains.map((domain) => ({
          parentId: domain.parent.id,
          record: toRecord(domain, at),
        })),
        next: domains.length === PAGE_SIZE && last ? last.id : null,
      };
    },

    registryReferrers(): Promise<InterpretedName[] | null> {
      return Promise.resolve(null);
    },

    async recordHistory(
      domains: readonly DomainRecord[],
    ): Promise<Map<string, RecordHistory>> {
      const batches = await Promise.all(
        chunk(domains, HISTORY_BATCH_SIZE).map(historyBatch),
      );
      return new Map(batches.flat());
    },
  };
}
