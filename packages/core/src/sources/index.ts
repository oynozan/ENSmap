import pLimit from 'p-limit';

import type {
  EndpointConfig,
  NameSourceKind,
  NamespaceConfig,
} from '../config/namespaces.ts';
import { createHttpClient, type HttpClient } from '../http/client.ts';
import type { CallCounter } from '../http/counter.ts';
import type { NamespaceDeps } from '../names/buildNameMap.ts';
import type { NameSource } from '../names/types.ts';
import { createChainReader } from '../rpc/chainReader.ts';
import { createRpcClient } from '../rpc/client.ts';
import { createEnsResolver } from '../rpc/ensResolver.ts';
import { createEnsDevGraphqlSource } from './ens-dev-graphql/index.ts';
import { createEnsSubgraphSource } from './ens-subgraph/index.ts';

export { createEnsDevGraphqlSource, createEnsSubgraphSource };

export interface NamespaceDepsOptions {
  counter: CallCounter;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
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
  const shared = { counter, secrets: cfg.secrets, fetch, sleep, now };
  const namesHttp = createHttpClient({
    provider: cfg.nameSource.kind,
    limits: cfg.nameSource.limits,
    ...shared,
  });
  const rpcHttp = createHttpClient({
    provider: 'rpc',
    limits: cfg.rpc.limits,
    ...shared,
  });
  const client = createRpcClient(cfg, {
    rpc: rpcHttp,
    ccipLimit: pLimit(cfg.ccipLimits.concurrency),
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
  };
}
