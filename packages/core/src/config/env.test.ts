import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { loadEnv, requireEnv, workspaceRoot } from './env.ts';

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

  it('treats a blank value as unset rather than an invalid URL', () => {
    expect(loadEnv({ RPC_URL_1: '' }).RPC_URL_1).toBeUndefined();
  });

  it('does not throw for an env shaped like a copied .env.example (every key blank)', () => {
    const exampleText = readFileSync(
      join(workspaceRoot(), '.env.example'),
      'utf8',
    );
    const blankEnv = parseEnv(exampleText);

    expect(() => loadEnv(blankEnv)).not.toThrow();
    expect(loadEnv(blankEnv)).toEqual(loadEnv({}));
  });

  it('rejects a javascript: RPC_URL_1', () => {
    expect(() =>
      loadEnv({ RPC_URL_1: 'javascript:alert(1)' }),
    ).toThrow(/RPC_URL_1/);
  });

  it('rejects a file: RPC_URL_1', () => {
    expect(() => loadEnv({ RPC_URL_1: 'file:///etc/passwd' })).toThrow(
      /RPC_URL_1/,
    );
  });

  it('accepts a Postgres DATABASE_URL with a query string', () => {
    const url = 'postgres://u:p@/db?host=/var/run/postgresql';
    expect(loadEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('never includes the offending value in a rejection message', () => {
    expect(() => loadEnv({ RPC_URL_1: 'javascript:alert(1)' })).not.toThrow(
      /javascript:alert/,
    );
    expect(() => loadEnv({ RPC_URL_1: 'file:///etc/passwd' })).not.toThrow(
      /etc\/passwd/,
    );
  });
});

describe('requireEnv', () => {
  it('throws a message naming the missing key', () => {
    expect(() => requireEnv(loadEnv({}), 'ALCHEMY_API_KEY')).toThrow(
      'Missing required env var ALCHEMY_API_KEY',
    );
  });

  it('throws on a blank value instead of returning an empty string', () => {
    expect(() =>
      requireEnv(loadEnv({ ALCHEMY_API_KEY: '' }), 'ALCHEMY_API_KEY'),
    ).toThrow('Missing required env var ALCHEMY_API_KEY');
  });
});
