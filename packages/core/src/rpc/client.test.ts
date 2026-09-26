import pLimit from 'p-limit';
import { BaseError, RpcRequestError } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import { loadEnv, resolveNamespace } from '../config/index.ts';
import type { NamespaceConfig } from '../config/index.ts';
import { CallCounter, createHttpClient, ProviderError } from '../http/index.ts';
import { createRpcClient } from './client.ts';

const SECRET_RPC_URL = 'https://rpc.example/v2/secret-key-123';
const TARGET = `0x${'11'.repeat(20)}` as const;
const REVERT_DATA = '0x7199966d0000000000000000000000000000000000000000';

function scriptedFetch(reply: () => Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, body: JSON.parse(await request.text()) });
    return reply();
  };
  return { fetch, calls };
}

function setup(cfg: NamespaceConfig, reply: () => Response) {
  const { fetch, calls } = scriptedFetch(reply);
  const counter = new CallCounter();
  const rpc = createHttpClient({
    provider: 'rpc',
    limits: cfg.rpc.limits,
    counter,
    secrets: cfg.secrets,
    fetch,
    sleep: () => Promise.resolve(),
  });
  const client = createRpcClient(cfg, {
    rpc,
    ccipLimit: pLimit(cfg.ccipLimits.concurrency),
    counter,
  });
  return { client, calls, counter };
}

describe('viem chain definitions', () => {
  it('define the Universal Resolver and multicall3 on mainnet and sepolia', () => {
    for (const chain of [mainnet, sepolia]) {
      expect(chain.contracts.ensUniversalResolver.address).toMatch(
        /^0x[0-9a-fA-F]{40}$/,
      );
      expect(chain.contracts.multicall3.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });
});

describe('createRpcClient', () => {
  it('surfaces a JSON-RPC revert as RpcRequestError with its data and no secret', async () => {
    const cfg = resolveNamespace(
      'mainnet',
      loadEnv({ RPC_URL_1: SECRET_RPC_URL }),
    );
    const { client, calls } = setup(cfg, () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 3, message: 'execution reverted', data: REVERT_DATA },
      }),
    );

    const error: unknown = await client
      .request({ method: 'eth_call', params: [{ to: TARGET }, 'latest'] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcRequestError);
    const rpcError = error as RpcRequestError;
    expect(rpcError.code).toBe(3);
    expect(rpcError.data).toBe(REVERT_DATA);
    expect(cfg.secrets.length).toBeGreaterThan(0);
    for (const secret of cfg.secrets) {
      expect(rpcError.message).not.toContain(secret);
      expect(rpcError.url).not.toContain(secret);
    }
    expect(calls.map((call) => call.url)).toEqual([SECRET_RPC_URL]);
    expect(calls[0]?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: TARGET }, 'latest'],
    });
  });

  it('returns the JSON-RPC result', async () => {
    const cfg = resolveNamespace('mainnet', loadEnv({}));
    const { client } = setup(cfg, () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: '0x10' }),
    );

    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(16n);
  });

  it('leaves retries to the HTTP client, so a 500 fails after retries + 1 attempts', async () => {
    const cfg = resolveNamespace('mainnet', loadEnv({}));
    const { client, calls, counter } = setup(
      cfg,
      () => new Response('upstream down', { status: 500 }),
    );

    const error: unknown = await client
      .getBlock({ blockNumber: 17_000_000n })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BaseError);
    const cause = (error as BaseError).walk((e) => e instanceof ProviderError);
    expect(cause).toBeInstanceOf(ProviderError);
    expect(cause).toMatchObject({ status: 500, retryable: true });
    expect(calls).toHaveLength(cfg.rpc.limits.retries + 1);
    expect(counter.snapshot()).toEqual({ rpc: cfg.rpc.limits.retries + 1 });
  });
});
