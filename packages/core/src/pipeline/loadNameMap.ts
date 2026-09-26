import type { Env } from '../config/env.ts';
import type { NamespaceConfig } from '../config/namespaces.ts';
import type { InterpretedName } from '../ens/names.ts';
import type { CallCounter } from '../http/counter.ts';
import {
  createFixtureFetch,
  FIXTURES_DIR,
  fixtureMode,
} from '../http/fixtures.ts';
import { buildNameMap, type NameMapResult } from '../names/buildNameMap.ts';
import { createNamespaceDeps } from '../sources/index.ts';

export interface LoadNameMapOptions {
  env: Env;
  counter: CallCounter;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // Defaults to the namespace's fetch cap
  fetchCap?: number;
}

// Shared by the CLI and the API, NameNotFoundError and ProviderError pass through unchanged
export async function loadNameMap(
  cfg: NamespaceConfig,
  root: InterpretedName,
  opts: LoadNameMapOptions,
): Promise<NameMapResult> {
  const fetch = createFixtureFetch({
    dir: FIXTURES_DIR,
    mode: fixtureMode(opts.env),
    secrets: cfg.secrets,
    inner: opts.fetch,
  });
  const deps = createNamespaceDeps(cfg, {
    counter: opts.counter,
    fetch,
    sleep: opts.sleep,
    now: opts.now,
  });
  const now = opts.now ?? Date.now;

  return buildNameMap(
    deps,
    {
      namespace: cfg.id,
      chainId: cfg.chainId,
      root,
      fetchCap: opts.fetchCap ?? cfg.fetchCap,
      maxLevels: cfg.maxLevels,
      now: () => new Date(now()),
    },
    opts.counter,
  );
}
