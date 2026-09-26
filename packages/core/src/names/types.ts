import type { InterpretedName } from '../ens/names.ts';

// Always lowercase
export type Address = `0x${string}`;

export interface DomainRecord {
  // Namehash on the subgraph, Domain.id on graphql.ens.dev
  id: string;
  label: string;
  canonicalName: InterpretedName | null;
  protocol: 'v1' | 'v2';
  registry: Address | null;
  subregistry: Address | null;
  owner: Address | null;
  indexedResolver: Address | null;
  indexedEthAddress: Address | null;
  registeredAt: Date | null;
  expiresAt: Date | null;
  expired: boolean;
}

// parentId and the totals keys are ids of the requested parents
export interface ChildrenPage {
  items: { parentId: string; record: DomainRecord }[];
  next: string | null;
  totals?: Map<string, number>;
}

interface RecordEventBase {
  block: bigint;
  logIndex: number;
  timestamp: Date | null;
}

export type RecordEvent = RecordEventBase &
  (
    | { kind: 'resolver-set'; resolver: Address | null }
    | { kind: 'record-linked'; resolver: Address; record: string }
    | {
        kind: 'addr-set';
        resolver: Address;
        record: string;
        address: Address | null;
      }
    | { kind: 'records-cleared'; resolver: Address; record: string }
  );

export interface RecordHistory {
  events: RecordEvent[];
  complete: boolean;
}

// A null return means the source doesn't support that capability
export interface NameSource {
  readonly id: string;
  readonly maxParentsPerCall: number;
  getDomain(name: InterpretedName): Promise<DomainRecord | null>;
  listChildren(
    parents: readonly DomainRecord[],
    cursor: string | null,
  ): Promise<ChildrenPage>;
  registryReferrers(registry: Address): Promise<InterpretedName[] | null>;
  recordHistory(
    domains: readonly DomainRecord[],
  ): Promise<Map<string, RecordHistory> | null>;
}

export interface TreeNode {
  record: DomainRecord;
  name: InterpretedName;
  aliasNames: InterpretedName[];
  parentIds: string[];
  // Levels below the root, which is level 0
  level: number;
}

export interface NameTree {
  rootId: string;
  nodes: Map<string, TreeNode>;
  truncated: boolean;
  indexedTotal: { value: number; exact: boolean };
  externalReferrers: Map<string, InterpretedName[]>;
}
