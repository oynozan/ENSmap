import { describe, expect, it } from 'vitest';

import { loadEnv, requireEnv } from './env.ts';

describe('loadEnv', () => {
  it('returns every key undefined when the source is empty', () => {
    const env = loadEnv({});

    expect(env).toEqual({
      ALCHEMY_API_KEY: undefined,
      ENSNODE_URL_MAINNET: undefined,
      ENSNODE_URL_SEPOLIA_V2: undefined,
      DUNE_API_KEY: undefined,
      BITQUERY_API_KEY: undefined,
      DATABASE_URL: undefined,
      GRAPH_API_KEY: undefined,
      ENS_SOURCE_KIND_MAINNET: undefined,
      ENS_SOURCE_KIND_SEPOLIA_V2: undefined,
      ENS_SOURCE_URL_MAINNET: undefined,
      ENS_SOURCE_URL_SEPOLIA_V2: undefined,
      RPC_URL_1: undefined,
      RPC_URL_11155111: undefined,
      ENSMAP_FIXTURES: undefined,
    });
  });

  it('throws on an invalid URL without leaking the raw value', () => {
    expect(() => loadEnv({ RPC_URL_1: 'nope' })).toThrow(/RPC_URL_1/);
    expect(() => loadEnv({ RPC_URL_1: 'nope' })).not.toThrow(/nope/);
  });

  it('throws on an invalid ENSMAP_FIXTURES value', () => {
    expect(() => loadEnv({ ENSMAP_FIXTURES: 'bogus' })).toThrow(
      /ENSMAP_FIXTURES/,
    );
  });

  it('throws on an invalid ENS_SOURCE_KIND_MAINNET value', () => {
    expect(() => loadEnv({ ENS_SOURCE_KIND_MAINNET: 'omnigraph' })).toThrow(
      /ENS_SOURCE_KIND_MAINNET/,
    );
  });
});

describe('requireEnv', () => {
  it('throws a message naming the missing key', () => {
    expect(() => requireEnv(loadEnv({}), 'ALCHEMY_API_KEY')).toThrow(
      'Missing required env var ALCHEMY_API_KEY',
    );
  });
});
