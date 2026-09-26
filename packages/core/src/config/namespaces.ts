import type { ProviderLimits } from '../http/client.ts';
import type { Env } from './env.ts';

// ---- Types --------------------------------------------------------------

export type NamespaceId = 'mainnet' | 'sepolia-v2';
export type NameSourceKind = 'ens-subgraph' | 'ens-dev-graphql';

export interface EndpointConfig {
  url: string;
  headers: Record<string, string>;
  keyless: boolean;
  limits: ProviderLimits;
}

export interface NamespaceConfig {
  id: NamespaceId;
  chainId: 1 | 11155111;
  chains: number[];
  nameSource: EndpointConfig & { kind: NameSourceKind };
  rpc: EndpointConfig;
  ccipLimits: ProviderLimits;
  fetchCap: number;
  maxLevels: number;
  secrets: string[];
}

const NAMESPACE_IDS: NamespaceId[] = ['mainnet', 'sepolia-v2'];

// ---- Rate limits ----------------------------------------------------------
// Fields the brief doesn't pin default to: baseDelayMs 500, maxDelayMs 30s,
// timeoutMs 30s (the brief's single "timeout 30s" line, applied uniformly),
// retries 4.

const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function limitsWith(
  overrides: Pick<ProviderLimits, 'concurrency' | 'minIntervalMs'> &
    Partial<ProviderLimits>,
): ProviderLimits {
  return {
    retries: DEFAULT_RETRIES,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: DEFAULT_MAX_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...overrides,
  };
}

// api.thegraph.com's hosted service throttles hard without a key
const KEYLESS_SUBGRAPH_LIMITS = limitsWith({
  concurrency: 1,
  minIntervalMs: 3000,
  retries: 8,
  maxDelayMs: 60_000,
});
const KEYED_SUBGRAPH_LIMITS = limitsWith({ concurrency: 4, minIntervalMs: 0 });
const GRAPHQL_ENS_DEV_LIMITS = limitsWith({ concurrency: 2, minIntervalMs: 0 });
const KEYLESS_RPC_LIMITS = limitsWith({ concurrency: 2, minIntervalMs: 100 });
// Chosen default, not brief-pinned: treated as a paid/user-controlled endpoint.
const PAID_RPC_LIMITS = limitsWith({ concurrency: 4, minIntervalMs: 0 });
// A stalled gateway holds a resolver slot until this timeout
const CCIP_LIMITS = limitsWith({
  concurrency: 2,
  minIntervalMs: 0,
  timeoutMs: 10_000,
});

// ---- Secrets --------------------------------------------------------------
// redact() runs against both the raw request URL in error messages and a
// normalized Request.url in fixtures, so a query-bearing env URL must
// contribute both the raw and the URL-API-normalized path+query.

export function urlSecrets(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return [raw];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // DATABASE_URL also accepts `pglite:<path>` / `memory:`, and a Postgres
    // URL may carry credentials outside path+query; redact it wholesale
    // rather than guess at a scheme-specific split.
    return [raw];
  }
  if (url.pathname === '/' && url.search === '') {
    return [];
  }
  return [rawPathAndQuery(raw), `${url.pathname}${url.search}`];
}

// WHATWG URL ends the authority at the first / ? # or \ after the slashes
function rawPathAndQuery(raw: string): string {
  const authority = /^[^:]*:[/\\]*[^/?#\\]*/.exec(raw);
  return authority === null ? raw : raw.slice(authority[0].length);
}

// Every secret-bearing env value, regardless of whether this particular
// namespace's endpoints use it: redaction is global (global-constraints.md).
function allEnvSecrets(env: Env): string[] {
  return [
    env.GRAPH_API_KEY,
    env.ALCHEMY_API_KEY,
    env.DUNE_API_KEY,
    env.BITQUERY_API_KEY,
  ]
    .filter((value): value is string => value !== undefined)
    .concat(
      urlSecrets(env.RPC_URL_1),
      urlSecrets(env.RPC_URL_11155111),
      urlSecrets(env.ENS_SOURCE_URL_MAINNET),
      urlSecrets(env.ENS_SOURCE_URL_SEPOLIA_V2),
      urlSecrets(env.ENSNODE_URL_MAINNET),
      urlSecrets(env.ENSNODE_URL_SEPOLIA_V2),
      urlSecrets(env.DATABASE_URL),
    );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

export function envSecrets(env: Env): string[] {
  return dedupe(allEnvSecrets(env));
}

// ---- Name source ----------------------------------------------------------

function overrideNameSource(
  kind: NameSourceKind,
  url: string,
  env: Env,
): EndpointConfig & { kind: NameSourceKind } {
  const key = env.GRAPH_API_KEY;
  // R11: forwarding the Graph key to an arbitrary user-chosen host would
  // leak it, so only attach it when the override URL is the Graph gateway.
  const isGraphGateway =
    kind === 'ens-subgraph' &&
    key !== undefined &&
    new URL(url).hostname === 'gateway.thegraph.com';
  return {
    kind,
    url,
    headers: isGraphGateway ? { authorization: `Bearer ${key}` } : {},
    // A user-supplied source URL override is never keyless (R11).
    keyless: false,
    limits:
      kind === 'ens-subgraph' ? KEYED_SUBGRAPH_LIMITS : GRAPHQL_ENS_DEV_LIMITS,
  };
}

function resolveMainnetNameSource(
  env: Env,
): EndpointConfig & { kind: NameSourceKind } {
  const kind = env.ENS_SOURCE_KIND_MAINNET ?? 'ens-subgraph';
  if (env.ENS_SOURCE_URL_MAINNET !== undefined) {
    return overrideNameSource(kind, env.ENS_SOURCE_URL_MAINNET, env);
  }
  if (kind !== 'ens-subgraph') {
    throw new Error(
      `ENS_SOURCE_URL_MAINNET is required when ENS_SOURCE_KIND_MAINNET is '${kind}'`,
    );
  }
  if (env.GRAPH_API_KEY !== undefined) {
    return {
      kind: 'ens-subgraph',
      // docs.ens.domains/web/subgraph: The Graph's hosted gateway (keyed)
      url: 'https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH',
      headers: { authorization: `Bearer ${env.GRAPH_API_KEY}` },
      keyless: false,
      limits: KEYED_SUBGRAPH_LIMITS,
    };
  }
  return {
    kind: 'ens-subgraph',
    // docs.ens.domains/web/subgraph: legacy keyless hosted-service endpoint
    url: 'https://api.thegraph.com/subgraphs/name/ensdomains/ens',
    headers: {},
    keyless: true,
    limits: KEYLESS_SUBGRAPH_LIMITS,
  };
}

function resolveSepoliaV2NameSource(
  env: Env,
): EndpointConfig & { kind: NameSourceKind } {
  const kind = env.ENS_SOURCE_KIND_SEPOLIA_V2 ?? 'ens-dev-graphql';
  if (env.ENS_SOURCE_URL_SEPOLIA_V2 !== undefined) {
    return overrideNameSource(kind, env.ENS_SOURCE_URL_SEPOLIA_V2, env);
  }
  if (kind !== 'ens-dev-graphql') {
    throw new Error(
      `ENS_SOURCE_URL_SEPOLIA_V2 is required when ENS_SOURCE_KIND_SEPOLIA_V2 is '${kind}'`,
    );
  }
  return {
    kind: 'ens-dev-graphql',
    // graphql.ens.dev: ENS Labs-hosted GraphQL endpoint (keyless)
    url: 'https://graphql.ens.dev',
    headers: {},
    keyless: true,
    limits: GRAPHQL_ENS_DEV_LIMITS,
  };
}

// ---- RPC --------------------------------------------------------------

function resolveRpc(opts: {
  urlOverride: string | undefined;
  alchemyKey: string | undefined;
  alchemySubdomain: 'eth-mainnet' | 'eth-sepolia';
  publicnodeHost:
    'ethereum-rpc.publicnode.com' | 'ethereum-sepolia-rpc.publicnode.com';
}): EndpointConfig {
  if (opts.urlOverride !== undefined) {
    return {
      url: opts.urlOverride,
      headers: {},
      keyless: false,
      limits: PAID_RPC_LIMITS,
    };
  }
  if (opts.alchemyKey !== undefined) {
    return {
      // Alchemy docs: https://www.alchemy.com/docs/reference/ethereum-api-quickstart
      url: `https://${opts.alchemySubdomain}.g.alchemy.com/v2`,
      headers: { authorization: `Bearer ${opts.alchemyKey}` },
      keyless: false,
      limits: PAID_RPC_LIMITS,
    };
  }
  return {
    // research-verified publicnode: https://ethereum-rpc.publicnode.com and
    // https://ethereum-sepolia-rpc.publicnode.com
    url: `https://${opts.publicnodeHost}`,
    headers: {},
    keyless: true,
    limits: KEYLESS_RPC_LIMITS,
  };
}

// ---- resolveNamespace -----------------------------------------------------

export function resolveNamespace(id: string, env: Env): NamespaceConfig {
  const secrets = envSecrets(env);

  if (id === 'mainnet') {
    return {
      id: 'mainnet',
      chainId: 1,
      chains: [1],
      nameSource: resolveMainnetNameSource(env),
      rpc: resolveRpc({
        urlOverride: env.RPC_URL_1,
        alchemyKey: env.ALCHEMY_API_KEY,
        alchemySubdomain: 'eth-mainnet',
        publicnodeHost: 'ethereum-rpc.publicnode.com',
      }),
      ccipLimits: CCIP_LIMITS,
      fetchCap: 1000,
      maxLevels: 16,
      secrets,
    };
  }
  if (id === 'sepolia-v2') {
    return {
      id: 'sepolia-v2',
      chainId: 11155111,
      chains: [11155111],
      nameSource: resolveSepoliaV2NameSource(env),
      rpc: resolveRpc({
        urlOverride: env.RPC_URL_11155111,
        alchemyKey: env.ALCHEMY_API_KEY,
        alchemySubdomain: 'eth-sepolia',
        publicnodeHost: 'ethereum-sepolia-rpc.publicnode.com',
      }),
      ccipLimits: CCIP_LIMITS,
      fetchCap: 1000,
      maxLevels: 16,
      secrets,
    };
  }
  throw new Error(
    `Unknown namespace '${id}'; expected one of: ${NAMESPACE_IDS.join(', ')}`,
  );
}

// ---- coinTypeFor ------------------------------------------------------

export function coinTypeFor(ns: NamespaceConfig, chainId: number): bigint {
  if (chainId === ns.chainId) {
    return 60n;
  }
  // ENSIP-11: https://docs.ens.domains/ensip/11
  return BigInt((0x80000000 | chainId) >>> 0);
}
