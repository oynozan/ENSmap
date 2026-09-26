import { describe, expect, it } from 'vitest';

import { redact } from '../http/index.ts';
import { loadEnv } from './env.ts';
import { coinTypeFor, resolveNamespace } from './namespaces.ts';

describe('resolveNamespace', () => {
  describe('mainnet', () => {
    it('uses the keyless subgraph and a keyless RPC with an empty env', () => {
      const ns = resolveNamespace('mainnet', loadEnv({}));

      expect(ns.id).toBe('mainnet');
      expect(ns.chainId).toBe(1);
      expect(ns.chains).toEqual([1]);
      expect(ns.nameSource.kind).toBe('ens-subgraph');
      expect(ns.nameSource.keyless).toBe(true);
      expect(ns.nameSource.url).toBe(
        'https://api.thegraph.com/subgraphs/name/ensdomains/ens',
      );
      expect(ns.rpc.keyless).toBe(true);
      expect(ns.secrets).toEqual([]);
    });

    it('uses the keyed gateway and a bearer header when GRAPH_API_KEY is set', () => {
      const ns = resolveNamespace('mainnet', loadEnv({ GRAPH_API_KEY: 'g' }));

      expect(ns.nameSource.url).toBe(
        'https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH',
      );
      expect(ns.nameSource.headers['authorization']).toBe('Bearer g');
      expect(ns.nameSource.keyless).toBe(false);
      expect(ns.secrets).toContain('g');
    });

    it('sets the RPC bearer header and keeps the key out of the URL when ALCHEMY_API_KEY is set', () => {
      const ns = resolveNamespace('mainnet', loadEnv({ ALCHEMY_API_KEY: 'k' }));

      expect(ns.rpc.url).not.toContain('k');
      expect(ns.rpc.headers['authorization']).toBe('Bearer k');
      expect(ns.rpc.keyless).toBe(false);
      expect(ns.secrets).toContain('k');
    });

    it('prefers RPC_URL_1 over ALCHEMY_API_KEY and redacts its path+query', () => {
      const url = 'https://x.example/rpc?apikey=s3';
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({ RPC_URL_1: url, ALCHEMY_API_KEY: 'k' }),
      );

      expect(ns.rpc.url).toBe(url);
      expect(ns.secrets).toContain('/rpc?apikey=s3');
      // Error messages redact the raw request URL string...
      expect(redact(url, ns.secrets)).not.toContain('s3');
      // ...while fixtures redact a normalized Request.url; both must hide it.
      expect(redact(new Request(url).url, ns.secrets)).not.toContain('s3');
    });

    it('redacts both the raw and normalized forms of a query with no explicit path', () => {
      const url = 'https://x.example?apikey=s3';
      const ns = resolveNamespace('mainnet', loadEnv({ RPC_URL_1: url }));

      expect(ns.secrets).toContain('?apikey=s3');
      expect(ns.secrets).toContain('/?apikey=s3');
      expect(redact(url, ns.secrets)).not.toContain('s3');
      expect(redact(new Request(url).url, ns.secrets)).not.toContain('s3');
    });

    it('does not add a secret for a plain RPC_URL_1 with no path or query', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({ RPC_URL_1: 'https://x.example' }),
      );

      expect(ns.secrets).toEqual([]);
    });

    it('throws when ENS_SOURCE_KIND_MAINNET has no default URL and none is given', () => {
      expect(() =>
        resolveNamespace(
          'mainnet',
          loadEnv({ ENS_SOURCE_KIND_MAINNET: 'ens-dev-graphql' }),
        ),
      ).toThrow();
    });

    it('honours ENS_SOURCE_KIND_MAINNET when ENS_SOURCE_URL_MAINNET is also given', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_KIND_MAINNET: 'ens-dev-graphql',
          ENS_SOURCE_URL_MAINNET: 'https://example.test/graphql',
        }),
      );

      expect(ns.nameSource.kind).toBe('ens-dev-graphql');
      expect(ns.nameSource.url).toBe('https://example.test/graphql');
    });

    it('includes secrets from env vars this namespace does not itself use', () => {
      // Redaction is global (global-constraints.md), so a GRAPH_API_KEY set
      // while resolving sepolia-v2 still must not leak anywhere else.
      const ns = resolveNamespace(
        'sepolia-v2',
        loadEnv({ GRAPH_API_KEY: 'g' }),
      );

      expect(ns.secrets).toContain('g');
    });
  });

  describe('sepolia-v2', () => {
    it('defaults to kind ens-dev-graphql and chainId 11155111', () => {
      const ns = resolveNamespace('sepolia-v2', loadEnv({}));

      expect(ns.id).toBe('sepolia-v2');
      expect(ns.chainId).toBe(11155111);
      expect(ns.chains).toEqual([11155111]);
      expect(ns.nameSource.kind).toBe('ens-dev-graphql');
      expect(ns.nameSource.url).toBe('https://graphql.ens.dev');
      expect(ns.nameSource.keyless).toBe(true);
    });
  });

  it('throws on an unknown namespace, listing the known ones', () => {
    expect(() => resolveNamespace('holesky', loadEnv({}))).toThrow(
      /mainnet, sepolia-v2/,
    );
  });

  describe('ENS_SOURCE_URL override (R11)', () => {
    it('is never keyless for a mainnet override with the default kind', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_URL_MAINNET:
            'https://my-graph-node.example/subgraphs/name/ens',
        }),
      );

      expect(ns.nameSource.keyless).toBe(false);
    });

    it('is never keyless for a mainnet override with kind ens-dev-graphql', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_KIND_MAINNET: 'ens-dev-graphql',
          ENS_SOURCE_URL_MAINNET: 'https://example.test/graphql',
        }),
      );

      expect(ns.nameSource.keyless).toBe(false);
    });

    it('is never keyless for a sepolia-v2 override with the default kind', () => {
      const ns = resolveNamespace(
        'sepolia-v2',
        loadEnv({ ENS_SOURCE_URL_SEPOLIA_V2: 'https://example.test/graphql' }),
      );

      expect(ns.nameSource.keyless).toBe(false);
    });

    it('is never keyless for a sepolia-v2 override with kind ens-subgraph', () => {
      const ns = resolveNamespace(
        'sepolia-v2',
        loadEnv({
          ENS_SOURCE_KIND_SEPOLIA_V2: 'ens-subgraph',
          ENS_SOURCE_URL_SEPOLIA_V2:
            'https://my-graph-node.example/subgraphs/name/ens',
        }),
      );

      expect(ns.nameSource.keyless).toBe(false);
    });

    it('attaches the Graph bearer header when the override host is exactly gateway.thegraph.com', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_URL_MAINNET:
            'https://gateway.thegraph.com/api/subgraphs/id/other-id',
          GRAPH_API_KEY: 'g',
        }),
      );

      expect(ns.nameSource.headers['authorization']).toBe('Bearer g');
    });

    it('does not forward the Graph key to an arbitrary override host', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_URL_MAINNET:
            'https://my-graph-node.example/subgraphs/name/ens',
          GRAPH_API_KEY: 'g',
        }),
      );

      expect(ns.nameSource.headers['authorization']).toBeUndefined();
    });

    it('does not attach the Graph key when the overridden kind is ens-dev-graphql', () => {
      const ns = resolveNamespace(
        'mainnet',
        loadEnv({
          ENS_SOURCE_KIND_MAINNET: 'ens-dev-graphql',
          ENS_SOURCE_URL_MAINNET:
            'https://gateway.thegraph.com/api/subgraphs/id/other-id',
          GRAPH_API_KEY: 'g',
        }),
      );

      expect(ns.nameSource.headers['authorization']).toBeUndefined();
    });
  });

  describe('shared defaults', () => {
    it('sets fetchCap, maxLevels and ccipLimits concurrency', () => {
      const ns = resolveNamespace('mainnet', loadEnv({}));

      expect(ns.fetchCap).toBe(1000);
      expect(ns.maxLevels).toBe(16);
      expect(ns.ccipLimits.concurrency).toBe(2);
    });

    it('pins the keyless subgraph limits from the brief', () => {
      const ns = resolveNamespace('mainnet', loadEnv({}));

      expect(ns.nameSource.limits).toMatchObject({
        concurrency: 1,
        minIntervalMs: 3000,
        retries: 8,
        maxDelayMs: 60_000,
      });
    });

    it('pins the keyed subgraph concurrency from the brief', () => {
      const ns = resolveNamespace('mainnet', loadEnv({ GRAPH_API_KEY: 'g' }));

      expect(ns.nameSource.limits.concurrency).toBe(4);
    });

    it('pins the graphql.ens.dev concurrency from the brief', () => {
      const ns = resolveNamespace('sepolia-v2', loadEnv({}));

      expect(ns.nameSource.limits.concurrency).toBe(2);
    });

    it('pins the keyless RPC limits from the brief', () => {
      const ns = resolveNamespace('mainnet', loadEnv({}));

      expect(ns.rpc.limits).toMatchObject({
        concurrency: 2,
        minIntervalMs: 100,
      });
    });
  });
});

describe('coinTypeFor', () => {
  it("returns 60n for the namespace's own chain", () => {
    const mainnet = resolveNamespace('mainnet', loadEnv({}));

    expect(coinTypeFor(mainnet, 1)).toBe(60n);
  });

  it('returns the ENSIP-11 coin type for another chain', () => {
    const mainnet = resolveNamespace('mainnet', loadEnv({}));

    expect(coinTypeFor(mainnet, 8453)).toBe(2147492101n);
  });
});
