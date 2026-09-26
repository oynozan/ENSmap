// Graph JSON contract for the API and the web map, browser-safe so zod is its only import
import { z } from 'zod';

export const GRAPH_VERSION = 1;

const Address = z.string().regex(/^0x[0-9a-f]{40}$/);
// toISOString writes years past 9999 as ±YYYYYY, which z.iso.datetime rejects
const IsoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'expected a date');
const Count = z.number().int().nonnegative();

export const NodeKind = z.enum([
  'name',
  'subname',
  'counterparty',
  'deposit',
  'cexHub',
  'dexHub',
  'timeNode',
  'collapsed',
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const EdgeKind = z.enum(['subname', 'bond', 'sweep', 'hub']);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const SizeMetric = z.enum([
  'outgoingUsd',
  'subnamesHeld',
  'walletBalanceUsd',
]);
export type SizeMetric = z.infer<typeof SizeMetric>;

// A null address is the chain's native token
export const TokenAmount = z.object({
  symbol: z.string(),
  address: Address.nullable(),
  amount: z.string(),
  usd: z.number().nullable(),
  count: Count,
});
export type TokenAmount = z.infer<typeof TokenAmount>;

export const GraphNode = z.object({
  id: z.string(),
  kind: NodeKind,
  label: z.string(),
  address: Address.optional(),
  names: z.array(z.string()).optional(),
  homeName: z.string().optional(),
  chainId: z.number().int().positive().optional(),
  verified: z.boolean().optional(),
  tags: z.array(z.string()),
  labelSource: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  size: z.object({ metric: SizeMetric, value: z.number().nonnegative() }),
  clusterId: z.string().optional(),
  collapsedCount: Count.optional(),
  verifiedBy: z.enum(['primary-name', 'owner']).optional(),
  owner: Address.optional(),
  canonical: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: EdgeKind,
  directed: z.boolean(),
  tokens: z.array(TokenAmount).optional(),
  usdTotal: z.number().optional(),
  count: Count.optional(),
  firstAt: IsoDate.optional(),
  lastAt: IsoDate.optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const GraphMeta = z.object({
  namespace: z.enum(['mainnet', 'sepolia-v2']),
  root: z.string(),
  computedAt: IsoDate,
  caps: z.object({ fetch: z.number().int().positive() }),
  // Phase 4 adds the filter fields
  filters: z.object({}),
  totals: z.object({
    names: Count,
    indexed: z.object({ value: Count, exact: z.boolean() }),
    wallets: Count,
  }),
  truncated: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type GraphMeta = z.infer<typeof GraphMeta>;

export const Graph = z.object({
  version: z.literal(GRAPH_VERSION),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  meta: GraphMeta,
});
export type Graph = z.infer<typeof Graph>;

export const ApiErrorCode = z.enum([
  'invalid-name',
  'invalid-namespace',
  'not-found',
  'provider-error',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    message: z.string(),
    labels: z
      .array(z.object({ index: Count, label: z.string(), reason: z.string() }))
      .optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
