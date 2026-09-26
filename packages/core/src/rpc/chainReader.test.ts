import pLimit from 'p-limit';
import { UnknownRpcError, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadEnv, resolveNamespace } from '../config/index.ts';
import {
  CallCounter,
  createFixtureFetch,
  createHttpClient,
  FIXTURES_DIR,
  fixtureMode,
  ProviderError,
} from '../http/index.ts';
import { createChainReader } from './chainReader.ts';
import { createRpcClient } from './client.ts';

const MAINNET = resolveNamespace('mainnet', loadEnv({}));
const mode = fixtureMode(loadEnv());
const BLOCK_TIME = new Date('2023-11-14T22:13:20.000Z');

type Reply = { result: unknown } | { error: { code: number; message: string } };

const BlockRequest = z.object({
  id: z.number(),
  params: z.tuple([z.string(), z.boolean()]),
});

function rpcError(code: number, message: string): Reply {
  return { error: { code, message } };
}

// Replies per block through the real RPC client, so viem wraps errors as it does live
function scriptedReader(replies: Readonly<Record<string, Reply>>) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const { id, params } = BlockRequest.parse(
      await new Request(input, init).json(),
    );
    const reply = replies[params[0]] ?? {
      result: { number: params[0], timestamp: '0x6553f100', transactions: [] },
    };
    return Response.json({ jsonrpc: '2.0', id, ...reply });
  };
  const counter = new CallCounter();
  const rpc = createHttpClient({
    provider: 'rpc',
    limits: MAINNET.rpc.limits,
    counter,
    secrets: [],
    fetch,
    sleep: () => Promise.resolve(),
  });
  const client = createRpcClient(MAINNET, {
    rpc,
    ccipLimit: pLimit(1),
    counter,
  });
  return createChainReader(client, { concurrency: 1 });
}

describe('createChainReader', () => {
  it('rethrows a wrapped ProviderError as-is', async () => {
    const providerError = new ProviderError('rpc: HTTP 500', {
      provider: 'rpc',
      status: 500,
      retryable: true,
    });
    const client = {
      getBlock: () => Promise.reject(new UnknownRpcError(providerError)),
    } as unknown as PublicClient;

    await expect(
      createChainReader(client, { concurrency: 1 }).blockTimestamps([1n]),
    ).rejects.toBe(providerError);
  });

  it('leaves out a block the RPC does not have', async () => {
    const reader = scriptedReader({ '0x2': { result: null } });

    const { times, skipped } = await reader.blockTimestamps([2n, 3n]);

    expect(times).toEqual(new Map([[3n, BLOCK_TIME]]));
    expect(skipped).toEqual(new Map([[2n, 'block not found']]));
  });

  it('leaves out a block pruned with code 4444, keeping the code and message', async () => {
    // publicnode's answer for a block before its pruning horizon
    const reader = scriptedReader({
      '0x1': rpcError(4444, 'pruned history unavailable'),
    });

    const { times, skipped } = await reader.blockTimestamps([1n, 3n]);

    expect(times).toEqual(new Map([[3n, BLOCK_TIME]]));
    expect(skipped).toEqual(
      new Map([[1n, 'RPC error 4444: pruned history unavailable']]),
    );
  });

  it.each([
    'pruned history unavailable',
    'history is unavailable',
    'history expired',
  ])('leaves out a block answered -32000 %j', async (message) => {
    const reader = scriptedReader({ '0x1': rpcError(-32000, message) });

    const { times, skipped } = await reader.blockTimestamps([1n]);

    expect(times.size).toBe(0);
    expect(skipped).toEqual(new Map([[1n, `RPC error -32000: ${message}`]]));
  });

  it('rethrows a -32000 error that is not about pruned history', async () => {
    const reader = scriptedReader({
      '0x1': rpcError(-32000, 'some other error'),
    });

    await expect(reader.blockTimestamps([1n])).rejects.toThrow(
      /some other error/,
    );
  });

  it('rethrows another code even when its message mentions pruning', async () => {
    const reader = scriptedReader({
      '0x1': rpcError(-32602, 'pruned history unavailable'),
    });

    await expect(reader.blockTimestamps([1n])).rejects.toThrow(
      /pruned history unavailable/,
    );
  });

  it('rethrows any other error', async () => {
    const client = {
      getBlock: () => Promise.reject(new Error('boom')),
    } as unknown as PublicClient;

    await expect(
      createChainReader(client, { concurrency: 1 }).blockTimestamps([1n]),
    ).rejects.toThrow('boom');
  });

  it(
    'reads a recorded block timestamp once for a repeated block',
    { timeout: mode === 'replay' ? 5_000 : 60_000 },
    async () => {
      const counter = new CallCounter();
      const rpc = createHttpClient({
        provider: 'rpc',
        limits: MAINNET.rpc.limits,
        counter,
        secrets: MAINNET.secrets,
        fetch: createFixtureFetch({
          dir: FIXTURES_DIR,
          mode,
          secrets: MAINNET.secrets,
        }),
        ...(mode === 'replay' ? { sleep: () => Promise.resolve() } : {}),
      });
      const client = createRpcClient(MAINNET, {
        rpc,
        ccipLimit: pLimit(MAINNET.ccipLimits.concurrency),
        counter,
      });

      const { times } = await createChainReader(client, {
        concurrency: 4,
      }).blockTimestamps([17_000_000n, 17_000_000n]);

      // Timestamp 1680911891 in the recorded block
      expect(times).toEqual(
        new Map([[17_000_000n, new Date('2023-04-07T23:58:11.000Z')]]),
      );
      expect(counter.snapshot()).toEqual({ rpc: 1 });
    },
  );
});
