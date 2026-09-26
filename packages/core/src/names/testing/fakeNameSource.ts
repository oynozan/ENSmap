import type { InterpretedName } from '../../ens/names.ts';
import type {
  Address,
  ChildrenPage,
  DomainRecord,
  NameSource,
  RecordHistory,
} from '../types.ts';

export interface FakeDomain {
  id: string;
  label: string;
  canonicalName?: string | null;
  protocol?: 'v1' | 'v2';
  registry?: Address | null;
  subregistry?: Address | null;
  owner?: Address | null;
  indexedResolver?: Address | null;
  indexedEthAddress?: Address | null;
  registeredAt?: Date | null;
  expiresAt?: Date | null;
  expired?: boolean;
}

export interface FakeNameSourceOptions {
  domains: readonly FakeDomain[];
  // Listing key (subregistry or parent id) to child ids in source order
  children?: Readonly<Record<string, readonly string[]>>;
  pageSize?: number;
  maxParentsPerCall?: number;
  reportTotals?: boolean;
  // null means the capability is unsupported
  referrers?: Readonly<Record<string, readonly string[]>> | null;
  history?: Readonly<Record<string, RecordHistory>> | null;
}

export type FakeCall =
  | { method: 'getDomain'; name: InterpretedName }
  | { method: 'listChildren'; parents: string[]; cursor: string | null }
  | { method: 'registryReferrers'; registry: Address }
  | { method: 'recordHistory'; ids: string[] };

export interface FakeNameSource extends NameSource {
  readonly calls: FakeCall[];
  record(id: string): DomainRecord;
}

function toRecord(domain: FakeDomain): DomainRecord {
  return {
    id: domain.id,
    label: domain.label,
    canonicalName: (domain.canonicalName ?? null) as InterpretedName | null,
    protocol: domain.protocol ?? 'v1',
    registry: domain.registry ?? null,
    subregistry: domain.subregistry ?? null,
    owner: domain.owner ?? null,
    indexedResolver: domain.indexedResolver ?? null,
    indexedEthAddress: domain.indexedEthAddress ?? null,
    registeredAt: domain.registeredAt ?? null,
    expiresAt: domain.expiresAt ?? null,
    expired: domain.expired ?? false,
  };
}

export function createFakeNameSource(
  options: FakeNameSourceOptions,
): FakeNameSource {
  const records = new Map(
    options.domains.map((domain) => [domain.id, toRecord(domain)]),
  );
  const children = options.children ?? {};
  const pageSize = options.pageSize ?? 1000;
  const calls: FakeCall[] = [];

  function record(id: string): DomainRecord {
    const found = records.get(id);
    if (found === undefined) {
      throw new Error(`fake source has no domain ${id}`);
    }
    return found;
  }

  function childIdsOf(parent: DomainRecord): readonly string[] {
    return children[parent.subregistry ?? parent.id] ?? [];
  }

  return {
    id: 'fake',
    maxParentsPerCall: options.maxParentsPerCall ?? 100,
    calls,
    record,

    getDomain(name) {
      calls.push({ method: 'getDomain', name });
      const found = [...records.values()].find(
        (candidate) => candidate.canonicalName === name,
      );
      return Promise.resolve(found ?? null);
    },

    listChildren(parents, cursor) {
      calls.push({
        method: 'listChildren',
        parents: parents.map((parent) => parent.id),
        cursor,
      });
      const all = parents.flatMap((parent) =>
        childIdsOf(parent).map((id) => ({
          parentId: parent.id,
          record: record(id),
        })),
      );
      const offset = cursor === null ? 0 : Number(cursor);
      const end = offset + pageSize;
      const page: ChildrenPage = {
        items: all.slice(offset, end),
        next: end < all.length ? String(end) : null,
      };
      if (options.reportTotals === true) {
        page.totals = new Map(
          parents.map((parent) => [parent.id, childIdsOf(parent).length]),
        );
      }
      return Promise.resolve(page);
    },

    registryReferrers(registry) {
      calls.push({ method: 'registryReferrers', registry });
      if (options.referrers === null) {
        return Promise.resolve(null);
      }
      const names = options.referrers?.[registry] ?? [];
      return Promise.resolve([...names] as InterpretedName[]);
    },

    recordHistory(domains) {
      calls.push({
        method: 'recordHistory',
        ids: domains.map((domain) => domain.id),
      });
      const history = options.history ?? null;
      if (history === null) {
        return Promise.resolve(null);
      }
      const result = new Map<string, RecordHistory>();
      for (const domain of domains) {
        const entry = history[domain.id];
        if (entry !== undefined) {
          result.set(domain.id, entry);
        }
      }
      return Promise.resolve(result);
    },
  };
}
