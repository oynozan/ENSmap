import pLimit from 'p-limit';

import type {
  EndpointConfig,
  NameSourceKind,
  NamespaceConfig,
} from '../config/namespaces.ts';
import {
  createHttpClient,
  createRequestGate,
  type HttpClient,
  type RequestGate,
} from '../http/client.ts';
import type { CallCounter } from '../http/counter.ts';
import type { NamespaceDeps } from '../names/buildNameMap.ts';
import type { NameSource } from '../names/types.ts';
import { createChainReader } from '../rpc/chainReader.ts';
import { createRpcClient } from '../rpc/client.ts';
import { createEnsResolver } from '../rpc/ensResolver.ts';
import { createEnsDevGraphqlSource } from './ens-dev-graphql/index.ts';
import { createEnsSubgraphSource } from './ens-subgraph/index.ts';

export { createEnsDevGraphqlSource, createEnsSubgraphSource };

// Provider limits, shared by every build that should respect them together
export interface NamespaceGates {
  names: RequestGate;
  rpc: RequestGate;
  ccip: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface NamespaceDepsOptions {
  counter: CallCounter;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Defaults to gates of this build's own
  gates?: NamespaceGates;
}

export function createNamespaceGates(
  cfg: NamespaceConfig,
  opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): NamespaceGates {
  return {
    names: createRequestGate(cfg.nameSource.limits, opts),
    rpc: createRequestGate(cfg.rpc.limits, opts),
    ccip: pLimit(cfg.ccipLimits.concurrency),
  };
}

export function createNameSource(
  cfg: EndpointConfig & { kind: NameSourceKind },
  http: HttpClient,
  now?: () => Date,
): NameSource {
  return cfg.kind === 'ens-subgraph'
    ? createEnsSubgraphSource(cfg, http, now)
    : createEnsDevGraphqlSource(cfg, http, now);
}

function noticesFor(cfg: NamespaceConfig): string[] {
  const notices: string[] = [];
  if (cfg.nameSource.kind === 'ens-subgraph' && cfg.nameSource.keyless) {
    notices.push(
      'keyless ENS subgraph: heavily rate-limited; set GRAPH_API_KEY',
    );
  }
  if (cfg.rpc.keyless) {
    notices.push(
      `keyless public RPC: rate-limited; set ALCHEMY_API_KEY or RPC_URL_${cfg.chainId}`,
    );
  }
  return notices;
}

export function createNamespaceDeps(
  cfg: NamespaceConfig,
  opts: NamespaceDepsOptions,
): NamespaceDeps {
  const { counter, fetch, sleep, now } = opts;
  const gates = opts.gates ?? createNamespaceGates(cfg, { sleep, now });
  const shared = { counter, secrets: cfg.secrets, fetch, sleep, now };
  const namesHttp = createHttpClient({
    provider: cfg.nameSource.kind,
    limits: cfg.nameSource.limits,
    gate: gates.names,
    ...shared,
  });
  const rpcHttp = createHttpClient({
    provider: 'rpc',
    limits: cfg.rpc.limits,
    gate: gates.rpc,
    ...shared,
  });
  const client = createRpcClient(cfg, {
    rpc: rpcHttp,
    ccipLimit: gates.ccip,
    counter,
  });
  const concurrency = cfg.rpc.limits.concurrency;

  return {
    names: createNameSource(
      cfg.nameSource,
      namesHttp,
      now === undefined ? undefined : () => new Date(now()),
    ),
    ens: createEnsResolver(client, { concurrency }),
    chain: createChainReader(client, { concurrency }),
    notices: noticesFor(cfg),
    secrets: cfg.secrets,
  };
}
