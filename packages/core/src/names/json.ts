import { z } from 'zod';

import type { Resolution } from '../rpc/ensResolver.ts';
import type { Binding } from './bindings.ts';
import type { NameMapResult } from './buildNameMap.ts';
import type { WalletGroup } from './homes.ts';
import type { DomainRecord, TreeNode } from './types.ts';

const AddressJson = z.string().regex(/^0x[0-9a-f]{40}$/);
// toISOString writes years past 9999 as ±YYYYYY, which z.iso.datetime rejects
const DateJson = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'expected a date');

const DomainRecordJson = z.object({
  id: z.string(),
  label: z.string(),
  canonicalName: z.string().nullable(),
  protocol: z.enum(['v1', 'v2']),
  registry: AddressJson.nullable(),
  subregistry: AddressJson.nullable(),
  owner: AddressJson.nullable(),
  indexedResolver: AddressJson.nullable(),
  indexedEthAddress: AddressJson.nullable(),
  registeredAt: DateJson.nullable(),
  expiresAt: DateJson.nullable(),
  expired: z.boolean(),
});

const TreeNodeJson = z.object({
  record: DomainRecordJson,
  name: z.string(),
  aliasNames: z.array(z.string()),
  parentIds: z.array(z.string()),
  level: z.number().int().nonnegative(),
});

const ResolutionJson = z.object({
  address: AddressJson.nullable(),
  resolver: AddressJson.nullable(),
  error: z.string().nullable(),
});

const BindingJson = z.object({
  nameId: z.string(),
  name: z.string(),
  chainId: z.number().int(),
  address: AddressJson,
  resolver: AddressJson.nullable(),
  verified: z.boolean(),
  verifiedBy: z.enum(['primary-name', 'owner']).nullable(),
  validFrom: DateJson.nullable(),
  validTo: z.null(),
  windowSource: z.enum(['record-history', 'registration', 'unknown']),
  source: z.string(),
});

const WalletGroupJson = z.object({
  address: AddressJson,
  homeNameId: z.string(),
  memberNameIds: z.array(z.string()),
});

export const NameMapJson = z.object({
  namespace: z.enum(['mainnet', 'sepolia-v2']),
  root: z.string(),
  tree: z.object({
    rootId: z.string(),
    nodes: z.record(z.string(), TreeNodeJson),
    truncated: z.boolean(),
    indexedTotal: z.object({
      value: z.number().int().nonnegative(),
      exact: z.boolean(),
    }),
    externalReferrers: z.record(z.string(), z.array(z.string())),
  }),
  resolutions: z.record(z.string(), ResolutionJson),
  bindings: z.array(BindingJson),
  wallets: z.record(z.string(), WalletGroupJson),
  tags: z.record(z.string(), z.array(z.string())),
  calls: z.record(z.string(), z.number().int().nonnegative()),
  warnings: z.array(z.string()),
});
export type NameMapJson = z.infer<typeof NameMapJson>;

// An Invalid Date from an out-of-range source value has no ISO form
function isoDate(date: Date | null): string | null {
  return date === null || Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function recordJson(record: DomainRecord): z.infer<typeof DomainRecordJson> {
  return {
    ...record,
    registeredAt: isoDate(record.registeredAt),
    expiresAt: isoDate(record.expiresAt),
  };
}

function nodeJson(node: TreeNode): z.infer<typeof TreeNodeJson> {
  return {
    record: recordJson(node.record),
    name: node.name,
    aliasNames: [...node.aliasNames],
    parentIds: [...node.parentIds],
    level: node.level,
  };
}

function bindingJson(binding: Binding): z.infer<typeof BindingJson> {
  return { ...binding, validFrom: isoDate(binding.validFrom) };
}

function walletJson(group: WalletGroup): z.infer<typeof WalletGroupJson> {
  return { ...group, memberNameIds: [...group.memberNameIds] };
}

function mapRecord<K extends string, V, T>(
  map: ReadonlyMap<K, V>,
  convert: (value: V) => T,
): Record<string, T> {
  return Object.fromEntries(
    [...map].map(([key, value]) => [key, convert(value)]),
  );
}

export function toNameMapJson(r: NameMapResult): NameMapJson {
  const { tree } = r;
  return {
    namespace: r.namespace,
    root: r.root,
    tree: {
      rootId: tree.rootId,
      nodes: mapRecord(tree.nodes, nodeJson),
      truncated: tree.truncated,
      indexedTotal: { ...tree.indexedTotal },
      externalReferrers: mapRecord(tree.externalReferrers, (names) => [
        ...names,
      ]),
    },
    resolutions: mapRecord(r.resolutions, (resolution: Resolution) => ({
      ...resolution,
    })),
    bindings: r.bindings.map(bindingJson),
    wallets: mapRecord(r.wallets, walletJson),
    tags: mapRecord(r.tags, (tags) => [...tags]),
    calls: { ...r.calls },
    warnings: [...r.warnings],
  };
}
