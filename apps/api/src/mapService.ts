/*
 * Name maps for the API, cached in memory until Phase 4 adds the maps table
 * (web map spec section 3). Concurrent requests for one key share a build and
 * a failed build is never kept.
 */
import {
  resolveNamespace,
  type Env,
  type NamespaceId,
} from '@ensmap/core/config';
import type { InterpretedName } from '@ensmap/core/ens';
import { buildGraph } from '@ensmap/core/graph';
import { CallCounter } from '@ensmap/core/http';
import { loadNameMap } from '@ensmap/core/pipeline';
import type { Graph } from '@ensmap/core/schema';
import {
  createNamespaceGates,
  type NamespaceGates,
} from '@ensmap/core/sources';

export interface MapService {
  nameMap(namespace: NamespaceId, name: InterpretedName): Promise<Graph>;
}

export const MAP_CACHE_TTL_MS = 21_600_000;
export const MAP_CACHE_MAX_ENTRIES = 100;

type BuildMap = (
  namespace: NamespaceId,
  name: InterpretedName,
) => Promise<Graph>;

interface CacheEntry {
  graph: Promise<Graph>;
  // null while the build is in flight
  storedAt: number | null;
}

export function createCachedMapService(
  build: BuildMap,
  opts: { ttlMs: number; maxEntries: number; now: () => number },
): MapService {
  // Map order is insertion order, so the first key is the oldest entry
  const entries = new Map<string, CacheEntry>();

  function fresh(entry: CacheEntry): boolean {
    return entry.storedAt === null || opts.now() - entry.storedAt <= opts.ttlMs;
  }

  return {
    nameMap(namespace, name) {
      const key = `${namespace}:${name}`;
      const cached = entries.get(key);
      if (cached !== undefined && fresh(cached)) {
        return cached.graph;
      }

      // The async wrapper turns a synchronous throw into a rejection
      const entry: CacheEntry = {
        graph: (async () => build(namespace, name))(),
        storedAt: null,
      };
      entries.delete(key);
      entries.set(key, entry);
      for (const [oldestKey, oldest] of entries) {
        if (entries.size <= opts.maxEntries) {
          break;
        }
        // Evicting a build in flight would let a repeat request start a second one
        if (oldest.storedAt !== null) {
          entries.delete(oldestKey);
        }
      }

      entry.graph.then(
        () => {
          entry.storedAt = opts.now();
        },
        () => {
          if (entries.get(key) === entry) {
            entries.delete(key);
          }
        },
      );
      return entry.graph;
    },
  };
}

export interface LiveMapDeps {
  env: Env;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

export function createLiveMapService(deps: LiveMapDeps): MapService {
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((line: string) => {
      console.log(line);
    });

  // One gate set per namespace, so overlapping builds share each provider's limits
  const gates = new Map<NamespaceId, NamespaceGates>();

  return createCachedMapService(
    async (namespace, name) => {
      const cfg = resolveNamespace(namespace, deps.env);
      let shared = gates.get(namespace);
      if (shared === undefined) {
        shared = createNamespaceGates(cfg, { sleep: deps.sleep, now });
        gates.set(namespace, shared);
      }
      const counter = new CallCounter();
      try {
        const result = await loadNameMap(cfg, name, {
          env: deps.env,
          counter,
          fetch: deps.fetch,
          sleep: deps.sleep,
          now,
          gates: shared,
        });
        return buildGraph(result, {
          computedAt: new Date(now()),
          fetchCap: cfg.fetchCap,
        });
      } finally {
        log(`map ${namespace} ${name} · ${counter.format()}`);
      }
    },
    { ttlMs: MAP_CACHE_TTL_MS, maxEntries: MAP_CACHE_MAX_ENTRIES, now },
  );
}
